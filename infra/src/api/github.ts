/**
 * The Ficus GitHub App: adding GitHub repos as trees, and keeping them in sync.
 *
 * A person installs the app on the repos they choose (on GitHub) and connects
 * their GitHub account to Ficus (Better Auth's github provider, on the same
 * app). The repos Ficus offers them are those their own GitHub token reaches
 * through the app's installations, so no one is shown a repo they cannot read.
 * Adding one imports it through Artifacts: a public repo from its plain URL, a
 * private one from a URL carrying an installation token that reads that one
 * repo for an hour (never kept: src/core/remote.ts strips it). GitHub then
 * sends every push to `POST /v1/github/webhook`, signed with the app's webhook
 * secret, and each tree added from that repo and branch is grafted to it.
 *
 * The app reads code and nothing more: contents and metadata, and the email
 * addresses signing in needs.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What the Api holds of the app: its id (the JWT's issuer), its slug (its GitHub URL), its private key and its webhook secret. */
export interface GitHubAppKeys {
  readonly appId: string;
  readonly slug: string;
  /** PKCS#8, DER, base64: what Web Crypto imports (secrets.run.ts converts GitHub's PEM). */
  readonly privateKey: string;
  readonly webhookSecret: string;
}

export class GitHubFailure extends Schema.TaggedError<GitHubFailure>()("GitHub.Failure", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const API = "https://api.github.com";

/** Where a person installs the app on more repos. */
export const installUrl = (app: Pick<GitHubAppKeys, "slug">) => `https://github.com/apps/${app.slug}/installations/new`;

const encode = (text: string) => new TextEncoder().encode(text);

const base64Url = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.codePointAt(0) ?? 0);

/** A JWT GitHub accepts as the app for nine minutes (it allows ten): RS256 with the app's private key. `now` in seconds. */
export const appJwt = async (app: Pick<GitHubAppKeys, "appId" | "privateKey">, now: number) => {
  const key = await crypto.subtle.importKey("pkcs8", fromBase64(app.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = base64Url(encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  // Issued a minute early, for clocks that run behind GitHub's.
  const claims = base64Url(encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encode(`${header}.${claims}`));

  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
};

const HEX = /^[0-9a-f]{64}$/u;

/** Whether `signature` (`X-Hub-Signature-256`) is the webhook secret's HMAC of `body`: compared by Web Crypto, in constant time. */
export const signedByGitHub = async (secret: string, body: string, signature: string | null) => {
  const hex = signature?.startsWith("sha256=") === true ? signature.slice("sha256=".length) : "";

  if (!HEX.test(hex)) {
    return false;
  }

  const key = await crypto.subtle.importKey("raw", encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const expected = Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));

  return crypto.subtle.verify("HMAC", key, expected, encode(body));
};

/** A repo, as GitHub answers and Ficus offers it. */
export const Repository = Schema.Struct({
  id: Schema.Number,
  full_name: Schema.String,
  private: Schema.Boolean,
  default_branch: Schema.String,
});

export type Repository = typeof Repository.Type;

const Installations = Schema.Struct({ installations: Schema.Array(Schema.Struct({ id: Schema.Number })) });

const InstallationRepositories = Schema.Struct({ repositories: Schema.Array(Repository) });

const Installation = Schema.Struct({ id: Schema.Number });

const AccessToken = Schema.Struct({ token: Schema.String });

/** Ask GitHub's REST API as `token` (a user's, an installation's, or the app's JWT); its answer decoded as `schema`. */
/** GitHub's request for `path` as `token`, with `body` as JSON when given. */
const githubRequest = (path: string, token: string, body: string | undefined) => {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    // GitHub refuses requests without one.
    "user-agent": "ficus",
  });

  if (body === undefined) {
    return new Request(`${API}${path}`, { headers });
  }

  headers.set("content-type", "application/json");

  return new Request(`${API}${path}`, { method: "POST", headers, body });
};

const ask = <S extends Schema.Constraint>(schema: S, path: string, token: string, body?: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(githubRequest(path, token, body)),
      catch: (cause) => new GitHubFailure({ status: 502, message: `GitHub is unreachable: ${String(cause)}` }),
    });

    const text = yield* Effect.promise(() => response.text());

    if (!response.ok) {
      return yield* new GitHubFailure({ status: response.status, message: `GitHub answered ${response.status} to ${path}: ${text.slice(0, 200)}` });
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((error) => new GitHubFailure({ status: 502, message: `GitHub's answer to ${path} was not understood: ${error.message}` })),
    );
  });

const appToken = (app: GitHubAppKeys) =>
  Effect.tryPromise({
    try: () => appJwt(app, Math.floor(Date.now() / 1000)),
    catch: (cause) => new GitHubFailure({ status: 500, message: `could not sign as the GitHub App: ${String(cause)}` }),
  });

/** Every repo `userToken` reaches through the app's installations, by name. */
export const userRepositories = Effect.fn("GitHub.userRepositories")(function* (userToken: string) {
  const { installations } = yield* ask(Installations, "/user/installations?per_page=100", userToken);

  const pages = yield* Effect.forEach(installations, (installation) => ask(InstallationRepositories, `/user/installations/${installation.id}/repositories?per_page=100`, userToken), {
    concurrency: 4,
  });

  return pages.flatMap((page) => page.repositories).toSorted((a, b) => a.full_name.localeCompare(b.full_name));
});

/** The repo `id`, if `userToken` reaches it through the app's installations: the check before adding it. */
export const userRepository = Effect.fn("GitHub.userRepository")(function* (userToken: string, id: number) {
  const repositories = yield* userRepositories(userToken);

  return Option.fromUndefinedOr(repositories.find((repository) => repository.id === id));
});

/** A token that reads `repository` for an hour, as the app's installation on it. */
export const repositoryToken = Effect.fn("GitHub.repositoryToken")(function* (app: GitHubAppKeys, repository: Pick<Repository, "id" | "full_name">) {
  const jwt = yield* appToken(app);
  const installation = yield* ask(Installation, `/repos/${repository.full_name}/installation`, jwt);

  const { token } = yield* ask(
    AccessToken,
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    JSON.stringify({ repository_ids: [repository.id], permissions: { contents: "read" } }),
  );

  return token;
});

/** Where Artifacts imports `repository` from: a public repo's plain URL, or a private one's with `token`. */
export const importSource = (repository: Pick<Repository, "full_name" | "private">, token: string | undefined) =>
  repository.private && token !== undefined ? `https://x-access-token:${token}@github.com/${repository.full_name}.git` : `https://github.com/${repository.full_name}.git`;

/** A push, as far as syncing reads it (GitHub's `push` event). */
const PushEvent = Schema.Struct({
  ref: Schema.String,
  deleted: Schema.optional(Schema.Boolean),
  repository: Schema.Struct({ id: Schema.Number, full_name: Schema.String, private: Schema.Boolean }),
});

const decodePush = Schema.decodeUnknownOption(Schema.fromJsonString(PushEvent));

const BRANCH_REF = "refs/heads/";

/** The repo and branch a push moved, from its body; none for a tag, a deleted branch, or a body that is not a push. */
export const pushed = (body: string) =>
  Option.flatMap(decodePush(body), (push) =>
    push.ref.startsWith(BRANCH_REF) && push.deleted !== true
      ? Option.some({ repository: { id: push.repository.id, full_name: push.repository.full_name, private: push.repository.private }, branch: push.ref.slice(BRANCH_REF.length) })
      : Option.none(),
  );
