/**
 * AI Gateway's Auto Router as a pi model: `cloudflare/auto` lets the gateway
 * choose the model per request, from a task-difficulty classification
 * weighed against cost, with fallback when a provider cannot serve it
 * (https://developers.cloudflare.com/ai-gateway/features/auto-router/).
 *
 * An attempt opts in with `model: "cloudflare/auto"`: its change phase then
 * runs on the router instead of the model Clef's effort question picks
 * (actor.ts). The scout stays on its cheap model.
 *
 * The model goes through the same Workers AI path as `@cf/` models, which
 * is the router's documented binding call: `env.AI.run("cloudflare/auto",
 * input, { gateway: { id } })`. Two headers ride along. `cf-aig-session-id`
 * keeps one attempt's conversation on one model while switching would cost
 * its prompt cache. `cf-aig-allowed-models` limits the pool to Workers AI
 * models; the default pool is premium third-party models billed through the
 * gateway.
 */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { AI } from "agents/models/pi-ai";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as Effect from "effect/Effect";

export const AUTO_MODEL = "cloudflare/auto";

/**
 * The router's pool when the env names none: the Workers AI models it can
 * route to that are fit for code changes, all with 262k tokens of context or
 * more (gemma and gpt-oss-20b are left out).
 */
export const DEFAULT_POOL = [
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/qwen/qwen3.8-27b",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
] as const;

/** The catalog entry the router's metadata (API, context window, costs) comes from. */
const TEMPLATE = "@cf/moonshotai/kimi-k2.7-code";

/** The env this module reads (the agents Worker's). */
export interface RouterEnv {
  readonly AI_GATEWAY?: string | undefined;
  readonly AUTO_ROUTER_POOL?: string | undefined;
}

export interface RouterSettings {
  /** The AI Gateway every model call goes through; Auto Router needs one. */
  readonly gateway: string;
  readonly pool: ReadonlyArray<string>;
}

/** `AI_GATEWAY` and, optionally, `AUTO_ROUTER_POOL` (comma-separated model ids). */
export const RouterConfig = Config.all({
  gateway: Config.String("AI_GATEWAY"),
  pool: Config.String("AUTO_ROUTER_POOL").pipe(
    Config.withDefault(DEFAULT_POOL.join(",")),
    Config.map((list) =>
      list
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    ),
  ),
});

/** The router's settings, read from a Worker's env. */
export const settingsOf = (env: RouterEnv): Effect.Effect<RouterSettings, Config.ConfigError> =>
  RouterConfig.parse(ConfigProvider.fromUnknown(env));

/** The headers that pin `session`'s conversation to one model and limit the pool. */
export const routingHeaders = (session: string, pool: ReadonlyArray<string>) => ({
  "cf-aig-session-id": session,
  "cf-aig-allowed-models": pool.join(","),
});

/** `cloudflare/auto` as a pi model for one conversation. */
export const autoModel = (ai: AI, session: string, settings: RouterSettings): Model<Api> =>
  ai({ ...ai(TEMPLATE), id: AUTO_MODEL, name: "Auto Router" }, { headers: routingHeaders(session, settings.pool) });

/**
 * `provider` with `extra` chat models added to what it lists. pi looks models
 * up by provider and id on every request, so a model it should run has to be
 * on its provider's list; everything else is the provider's own.
 */
/** A provider under construction: its members, writable. */
type ProviderParts = { -readonly [K in keyof Provider]: Provider[K] };

export const withModels = (provider: Provider, extra: ReadonlyArray<Model<Api>>): Provider => {
  const wrapped: ProviderParts = {
    id: provider.id,
    name: provider.name,
    auth: provider.auth,
    getModels: () => [...provider.getModels(), ...extra],
    stream: provider.stream.bind(provider),
    streamSimple: provider.streamSimple.bind(provider),
  };

  if (provider.baseUrl !== undefined) {
    wrapped.baseUrl = provider.baseUrl;
  }

  if (provider.headers !== undefined) {
    wrapped.headers = provider.headers;
  }

  if (provider.getAllModels !== undefined) {
    const all = provider.getAllModels.bind(provider);

    wrapped.getAllModels = () => [...all(), ...extra];
  }

  if (provider.refreshModels !== undefined) {
    wrapped.refreshModels = provider.refreshModels.bind(provider);
  }

  if (provider.filterModels !== undefined) {
    wrapped.filterModels = provider.filterModels.bind(provider);
  }

  if (provider.filterAllModels !== undefined) {
    wrapped.filterAllModels = provider.filterAllModels.bind(provider);
  }

  if (provider.fetchDeferred !== undefined) {
    wrapped.fetchDeferred = provider.fetchDeferred.bind(provider);
  }

  if (provider.cancelDeferred !== undefined) {
    wrapped.cancelDeferred = provider.cancelDeferred.bind(provider);
  }

  if (provider.generateImages !== undefined) {
    wrapped.generateImages = provider.generateImages.bind(provider);
  }

  if (provider.classify !== undefined) {
    wrapped.classify = provider.classify.bind(provider);
  }

  return wrapped;
};
