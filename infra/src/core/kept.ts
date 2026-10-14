/**
 * Answers the tree Worker keeps in KV: reads that are a pure function of
 * fixed commits, so they never change once their commits are fixed (derived
 * data, like a log read at a commit id or the diff between two). Each key
 * names the repo and the full commit ids the answer depends on; a subject
 * still moving (a working attempt's branch) has no commit id to name, so
 * nothing about it is kept until its ref is resolved to one.
 */

/** How long a kept answer stays in KV: long enough that a page's reads are made once, short enough that old ones go. */
export const KEPT_SECONDS = 30 * 24 * 60 * 60;

/** The largest answer kept: a bigger diff or file is read through Artifacts each time. */
export const KEPT_MAX_BYTES = 512 * 1024;

/** KV refuses a longer key. */
export const KEY_MAX_BYTES = 512;

/** A full commit id: whatever is read at one is the same forever. */
const COMMIT_ID = /^[0-9a-f]{40}$/u;

export const isCommitId = (ref: string | undefined): ref is string => ref !== undefined && COMMIT_ID.test(ref);

const fits = (key: string) => (new TextEncoder().encode(key).byteLength <= KEY_MAX_BYTES ? key : undefined);

/** A page of the log read at `ref`, if `ref` is a commit id. */
export const logKey = (repo: string, ref: string | undefined, limit: number, offset: number) =>
  isCommitId(ref) ? fits(`log/${repo}/${ref}/${limit}/${offset}`) : undefined;

/** What changed from `base` to `head`, if both are fixed (`head` is unset while an attempt is still working). */
export const diffKey = (repo: string, base: string | undefined, head: string | undefined) =>
  isCommitId(base) && isCommitId(head) ? fits(`diff/${repo}/${base}/${head}`) : undefined;

/** A directory listing (`tree`) or a file (`file`) at `path` in `commit`, if `commit` is a commit id. */
export const readKey = (what: "tree" | "file", repo: string, commit: string | undefined, names: ReadonlyArray<string>) =>
  isCommitId(commit) ? fits(`${what}/${repo}/${commit}/${names.join("/")}`) : undefined;

/** Whether an answer of `bytes` is small enough to keep. */
export const keepable = (bytes: number) => bytes <= KEPT_MAX_BYTES;
