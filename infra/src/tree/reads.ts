/**
 * Reading a tree's repos through Artifacts: a directory, a file, and what
 * an attempt or node changed (both trees walked side by side, descending
 * only where they differ, each changed file's text diffed by core/diff.ts).
 */
import * as Effect from "effect/Effect";
import { content, type FileChange, type FileDiff } from "../core/diff.ts";
import * as Artifacts from "./artifacts.ts";
import { artifactsRefused, json, refuse } from "./http.ts";

/** How many changed files one diff shows; past it, the rest are only counted. */
export const MAX_FILES = 200;

/** The largest file whose lines are diffed. */
const MAX_BLOB_BYTES = 256 * 1024;

/** The largest file a reader may read. */
const FILE_MAX_BYTES = 1024 * 1024;

/** The narrow view of `ArtifactsRepo` reading needs, so tests can stand in for it. */
export type Reader = Pick<ArtifactsRepo, "readTree" | "readBlob">;

/** The directory at `names` in `commit`, walking down from its root tree. */
export const listDirectory = Effect.fn("Tree.listDirectory")(function* (
  on: ArtifactsRepo,
  repoName: string,
  commit: ArtifactsCommitMetadata,
  names: ReadonlyArray<string>,
) {
  let hash = commit.treeHash;

  for (const name of names) {
    const entries = yield* Artifacts.readTree(on, hash).pipe(Effect.mapError(artifactsRefused));
    const next = entries?.find((entry) => entry.name === name && entry.type === "tree");

    if (entries === null) {
      return yield* refuse(404, `no tree ${hash}`);
    }

    if (next === undefined) {
      return yield* refuse(404, `no directory ${names.join("/")}`);
    }

    hash = next.hash;
  }

  const entries = yield* Artifacts.readTree(on, hash).pipe(Effect.mapError(artifactsRefused));

  if (entries === null) {
    return yield* refuse(404, `no tree ${hash}`);
  }

  // Directories first, then by name: how a reader expects a listing.
  const sorted = entries.toSorted((one, other) => Number(other.type === "tree") - Number(one.type === "tree") || (one.name < other.name ? -1 : one.name > other.name ? 1 : 0));

  return json({ repo: repoName, commit: committed(commit), path: names.join("/"), entries: sorted });
});

/** A commit as the tree Worker serves it: snake_case fields. */
export const committed = (commit: ArtifactsCommitMetadata) => ({
  hash: commit.hash,
  tree_hash: commit.treeHash,
  message: commit.message,
  author: commit.author,
  committer: commit.committer,
  parents: commit.parents,
  authored_at: commit.authoredAt,
  committed_at: commit.committedAt,
});

const TEXT_TYPES = ["json", "xml", "javascript", "toml", "yaml"];

/**
 * The file at `path` in `commit`, as bytes. Never served as anything a
 * browser would run: these are untrusted bytes leaving through the origin
 * that holds the session cookie.
 */
export const readFile = Effect.fn("Tree.readFile")(function* (on: ArtifactsRepo, commit: string, names: ReadonlyArray<string>) {
  if (names.length === 0) {
    return yield* refuse(400, "a file read needs a path");
  }

  const path = names.join("/");
  const file = yield* Artifacts.readFile(on, commit, path, FILE_MAX_BYTES).pipe(Effect.mapError(artifactsRefused));

  if (file === undefined) {
    return yield* refuse(404, `no file ${path}`);
  }

  const isText = file.contentType.startsWith("text/") || TEXT_TYPES.some((kind) => file.contentType.includes(kind));

  return new Response(file.bytes, {
    headers: {
      "content-type": isText ? "text/plain; charset=utf-8" : "application/octet-stream",
      "x-ficus-content-type": file.contentType,
      "x-ficus-commit": commit,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
});

/** A changed path, with the blob on each side that has one. */
interface Changed {
  readonly path: string;
  readonly old: string | undefined;
  readonly updated: string | undefined;
}

const entriesOf = Effect.fn("Tree.entries")(function* (on: Reader, tree: string | undefined) {
  if (tree === undefined) {
    return new Map<string, ArtifactsTreeEntry>();
  }

  const entries = yield* Effect.tryPromise({ try: () => on.readTree(tree), catch: (cause) => new Artifacts.ArtifactsError({ code: "UNCLASSIFIED", message: String(cause) }) });

  // A submodule is a pointer into another repo: nothing to diff here.
  return new Map((entries ?? []).filter((entry) => entry.type !== "gitlink").map((entry) => [entry.name, entry]));
});

const treeOf = (entry: ArtifactsTreeEntry | undefined) => (entry?.type === "tree" ? entry.hash : undefined);

const blobOf = (entry: ArtifactsTreeEntry | undefined) => (entry !== undefined && entry.type !== "tree" ? entry.hash : undefined);

/** The files that differ between two trees, in path order, at most `MAX_FILES`; `truncated` if there were more. */
export const changedFiles = Effect.fn("Tree.changedFiles")(function* (on: Reader, old: string | undefined, updated: string | undefined) {
  const found: Array<Changed> = [];
  // Directories to compare, by path; a stack, popped in reverse so paths stay in order.
  const pending: Array<readonly [string, string | undefined, string | undefined]> = [["", old, updated]];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [prefix, before, after] = next;
    const [oldEntries, newEntries] = [yield* entriesOf(on, before), yield* entriesOf(on, after)];
    const names = [...new Set([...oldEntries.keys(), ...newEntries.keys()])].toSorted();
    const directories: Array<readonly [string, string | undefined, string | undefined]> = [];

    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const [was, now] = [oldEntries.get(name), newEntries.get(name)];

      if (was !== undefined && now !== undefined && was.hash === now.hash) {
        continue;
      }

      if (treeOf(was) !== undefined || treeOf(now) !== undefined) {
        directories.push([path, treeOf(was), treeOf(now)]);
      }

      if (blobOf(was) !== undefined || blobOf(now) !== undefined) {
        if (found.length === MAX_FILES) {
          return { found, truncated: true };
        }

        found.push({ path, old: blobOf(was), updated: blobOf(now) });
      }
    }

    pending.push(...directories.toReversed());
  }

  return { found, truncated: false };
});

const bytesOf = (on: Reader, hash: string | undefined) =>
  hash === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: async () => {
          const blob = await on.readBlob(hash);

          if (blob === null) {
            return undefined;
          }

          return blob.size > MAX_BLOB_BYTES ? ("too_large" as const) : new Uint8Array(await blob.arrayBuffer());
        },
        catch: (cause) => new Artifacts.ArtifactsError({ code: "UNCLASSIFIED", message: String(cause) }),
      });

/** The diff from tree `old` to tree `updated` (either absent: everything added or removed). */
export const diffTrees = Effect.fn("Tree.diffTrees")(function* (on: Reader, old: string | undefined, updated: string | undefined) {
  const { found, truncated } = yield* changedFiles(on, old, updated);
  const files: Array<FileDiff> = [];

  for (const file of found) {
    const change: FileChange = file.old === undefined ? "added" : file.updated === undefined ? "removed" : "modified";
    const [before, after] = [yield* bytesOf(on, file.old), yield* bytesOf(on, file.updated)];

    files.push({
      path: file.path,
      change,
      content: before === "too_large" || after === "too_large" ? { kind: "too_large" } : content(before, after),
    });
  }

  return { files, truncated };
});
