/**
 * Copying a branch from a remote that needs credentials (a private GitHub
 * repo, with a read-only installation token: src/api/github.ts) into an empty
 * Artifacts repo, which Artifacts' own import refuses (it takes only public
 * remotes). Git's smart HTTP protocol, both ways, streamed: ask the remote for
 * the branch's whole history as one pack, and push that pack, untouched, as
 * the new repo's `main`. No container, no checkout, nothing kept: the token
 * travels only in the request to the remote.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { redactCredentials, withoutCredentials } from "../core/remote.ts";

export class CopyFailure extends Schema.TaggedError<CopyFailure>()("GitCopy.Failure", {
  message: Schema.String,
}) {}

/** The branch a copied repo's history lands on: Artifacts creates repos with `main` as their default branch. */
export const TARGET_BRANCH = "main";

const ZERO = "0".repeat(40);

const encoder = new TextEncoder();

/** One pkt-line: its length (four hex digits, counting themselves) and its payload. */
export const pktLine = (payload: string) => `${(encoder.encode(payload).length + 4).toString(16).padStart(4, "0")}${payload}`;

const FLUSH = "0000";

/** The refs an `info/refs?service=git-upload-pack` advertisement names, and where HEAD points. */
export const advertisedRefs = (advertisement: string) => {
  const refs = new Map<string, string>();
  let head: string | undefined;
  let at = 0;

  while (at + 4 <= advertisement.length) {
    const length = Number.parseInt(advertisement.slice(at, at + 4), 16);

    if (Number.isNaN(length)) {
      break;
    }

    if (length === 0) {
      at += 4;
      continue;
    }

    const line = advertisement.slice(at + 4, at + length).replace(/\n$/u, "");
    const [refPart = "", capabilities = ""] = line.split("\0");
    const match = /^([0-9a-f]{40}) (\S+)$/u.exec(refPart);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      refs.set(match[2], match[1]);
    }

    head ??= /symref=HEAD:(\S+)/u.exec(capabilities)?.[1];
    at += length;
  }

  return { refs, head };
};

/** The commit to copy: `branch`'s, or the default branch's (where HEAD points) when none is asked. */
export const wantedCommit = (advertised: ReturnType<typeof advertisedRefs>, branch: string | undefined) => {
  const ref = branch === undefined ? advertised.head : `refs/heads/${branch}`;

  return ref === undefined ? advertised.refs.get("HEAD") : advertised.refs.get(ref);
};

/** The remote's URL without its credentials, and the Basic header carrying them. */
const authenticated = (source: string) => {
  const url = new URL(source);
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;

  return { base: withoutCredentials(source).replace(/\/$/u, ""), authorization: `Basic ${btoa(credentials)}` };
};

const PACK = [0x50, 0x41, 0x43, 0x4b];

/** Where a pack starts in `bytes` ("PACK"), or -1. */
const packStart = (bytes: Uint8Array) => bytes.findIndex((_, index) => PACK.every((byte, offset) => bytes[index + offset] === byte));

/**
 * The upload-pack answer's pack, without the pkt-lines before it (`NAK`):
 * asked without side-band, the remote sends them and then the raw pack.
 */
const packOf = (answer: ReadableStream<Uint8Array>) => {
  const reader = answer.getReader();
  let started = false;
  let held = new Uint8Array(0);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();

      if (chunk.done) {
        if (!started) {
          controller.error(new Error("the remote sent no pack"));

          return;
        }

        controller.close();

        return;
      }

      if (started) {
        controller.enqueue(chunk.value);

        return;
      }

      const joined = new Uint8Array(held.length + chunk.value.length);

      joined.set(held);
      joined.set(chunk.value, held.length);

      const start = packStart(joined);

      if (start === -1) {
        held = joined;

        return;
      }

      started = true;
      controller.enqueue(joined.slice(start));
    },
    cancel: (reason) => reader.cancel(reason),
  });
};

/** `prefix`, then everything `rest` streams. */
const prefixed = (prefix: string, rest: ReadableStream<Uint8Array>) => {
  const reader = rest.getReader();
  let sentPrefix = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(encoder.encode(prefix));

        return;
      }

      const chunk = await reader.read();

      if (chunk.done) {
        controller.close();

        return;
      }

      controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
};

const failed = (step: string) => (cause: unknown) => new CopyFailure({ message: redactCredentials(`${step}: ${String(cause)}`) });

/** Whether a receive-pack report says the pack unpacked and `ref` was written. */
export const pushAccepted = (report: string, ref: string) => report.includes("unpack ok") && report.includes(`ok ${ref}`);

/**
 * Copy `branch` (default: the remote's default branch) of `source`, a URL with
 * credentials, into the empty Artifacts repo at `target` (its remote and a
 * write token), as `main`. Answers the copied commit.
 */
export const copyBranch = Effect.fn("GitCopy.copyBranch")(function* (source: string, branch: string | undefined, target: { readonly remote: string; readonly token: string }) {
  const { base, authorization } = authenticated(source);
  const headers = { authorization, "user-agent": "git/2.47 (ficus)" };

  const advertisement = yield* Effect.tryPromise({
    try: async () => {
      const answer = await fetch(`${base}/info/refs?service=git-upload-pack`, { headers });

      if (!answer.ok) {
        throw new Error(`the remote answered ${answer.status} to its refs`);
      }

      return answer.text();
    },
    catch: failed("reading the remote's refs"),
  });

  const commit = wantedCommit(advertisedRefs(advertisement), branch);

  if (commit === undefined) {
    return yield* new CopyFailure({ message: branch === undefined ? "the remote has no default branch" : `the remote has no branch ${branch}` });
  }

  yield* Effect.annotateCurrentSpan({ "ficus.copy.commit": commit });

  const pack = yield* Effect.tryPromise({
    try: async () => {
      const answer = await fetch(`${base}/git-upload-pack`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" },
        // The whole history, as REF_DELTAs (no ofs-delta asked), with no progress lines.
        body: `${pktLine(`want ${commit} no-progress\n`)}${FLUSH}${pktLine("done\n")}`,
      });

      if (!answer.ok || answer.body === null) {
        throw new Error(`the remote answered ${answer.status} to the fetch`);
      }

      return answer.body;
    },
    catch: failed("fetching the branch from the remote"),
  });

  const ref = `refs/heads/${TARGET_BRANCH}`;

  const report = yield* Effect.tryPromise({
    try: async () => {
      const answer = await fetch(`${target.remote.replace(/\/$/u, "")}/git-receive-pack`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result" },
        body: prefixed(`${pktLine(`${ZERO} ${commit} ${ref}\0report-status\n`)}${FLUSH}`, packOf(pack)),
      });

      const text = await answer.text();

      if (!answer.ok) {
        throw new Error(`Artifacts answered ${answer.status} to the push: ${text.slice(0, 200)}`);
      }

      return text;
    },
    catch: failed("pushing into Artifacts"),
  });

  if (!pushAccepted(report, ref)) {
    return yield* new CopyFailure({ message: `Artifacts did not take the push: ${report.slice(0, 200)}` });
  }

  return commit;
});
