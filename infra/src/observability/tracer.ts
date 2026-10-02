/**
 * Effect's tracing, recorded by Cloudflare: every `Effect.fn` and
 * `Effect.withSpan` in a Worker that provides {@link layer} becomes a
 * Workers Observability span, nested with the platform's own (subrequests,
 * service bindings, D1, Durable Objects), and its scalar annotations become
 * the span's attributes.
 *
 * The same bridge as alchemy's internal CloudflareTracer (not exported for
 * Workers outside alchemy's runtime): Cloudflare owns sampling and export,
 * and each span runs its children in the async context it opened, so the
 * platform's spans nest under it.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Tracer from "effect/Tracer";
import { AsyncLocalStorage } from "node:async_hooks";

type Tracing = (typeof import("cloudflare:workers"))["tracing"];

// Started when the module loads, so a request's layer finds it settled.
// Outside workerd (Bun's tests) there is no such module: spans stay Effect's.
const platform: Promise<Tracing | undefined> = import("cloudflare:workers").then(
  (workers) => workers.tracing,
  () => undefined,
);

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0];

type RunInContext = ReturnType<typeof AsyncLocalStorage.snapshot>;

type CloudflareSpan = ReturnType<Tracing["startSpan"]>;

class Span extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    readonly runInContext: RunInContext,
    readonly cloudflareSpan?: CloudflareSpan,
  ) {
    // An invocation Cloudflare does not trace leaves its Effect spans unsampled.
    super({ ...options, sampled: options.sampled && (cloudflareSpan?.isTraced ?? false) });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Effect's Span.attribute signature
  override attribute(key: string, value: unknown) {
    super.attribute(key, value);

    if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
      this.cloudflareSpan?.setAttribute(key, value);
    }
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    super.end(endTime, exit);

    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      this.cloudflareSpan?.setStatus({ code: "error", message: Cause.pretty(exit.cause).slice(0, 500) });
    }

    this.cloudflareSpan?.end();
  }
}

/**
 * The tracer, for one event: it captures the invocation's async context, so
 * build it per request (provide it where the request's Effect is run).
 */
export const layer: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    const tracing = yield* Effect.promise(() => platform);
    const invocation = AsyncLocalStorage.snapshot();

    const contextFor = (span: Tracer.AnySpan | undefined): RunInContext => {
      let current = span;

      while (current?._tag === "Span") {
        if (current instanceof Span) {
          return current.runInContext;
        }

        current = Option.getOrUndefined(current.parent);
      }

      return invocation;
    };

    return Tracer.make({
      span(options) {
        const parent = options.root ? invocation : contextFor(Option.getOrUndefined(options.parent));

        if (!options.sampled || tracing === undefined) {
          return new Span(options, parent);
        }

        return parent(() =>
          tracing.startActiveSpan(options.name, (span) => new Span(options, AsyncLocalStorage.snapshot(), span)),
        );
      },
      context(primitive, fiber) {
        return contextFor(fiber.cache.span)(() => primitive["~effect/Effect/evaluate"](fiber));
      },
    });
  }),
);
