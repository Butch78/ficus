/**
 * What a built-in agent is told when the machine hands it a rebase conflict
 * (`resolveConflict` in tree.ts): where the attempt's commits conflicted,
 * the head's version of those files and the change the attempt meant to
 * make, with the instruction to make that change again on the head. The tree
 * Worker reads the files and the diff from Artifacts; this module only
 * shapes and bounds them, so it tests without a Worker. The agents Worker
 * reads the same schema.
 */
import * as Schema from "effect/Schema";
import type { FileDiff } from "./diff.ts";
import { AttemptId, NodeId } from "./values.ts";

/** The most of the attempt's diff an agent is shown, in characters. */
export const DIFF_MAX = 24_000;

/** The most of each head file an agent is shown, in characters. */
export const FILE_MAX = 8_000;

/** The most conflicting files whose head version is shown. */
export const FILES_MAX = 4;

export const HeadFile = Schema.Struct({
  path: Schema.String,
  /** The file on the head, cut at `FILE_MAX`; empty when the head has no such file or it is not text. */
  content: Schema.String,
  truncated: Schema.Boolean,
});

export type HeadFile = typeof HeadFile.Type;

/** The conflict a retry's agent starts from. */
export const ConflictBrief = Schema.Struct({
  /** The attempt whose rebase conflicted. */
  attempt: AttemptId,
  /** The head the agent's checkout starts at. */
  onto: NodeId,
  paths: Schema.Array(Schema.String),
  /** The attempt's change against its old base, as a unified diff, cut at `DIFF_MAX`. */
  intended: Schema.String,
  head_files: Schema.Array(HeadFile),
});

export type ConflictBrief = typeof ConflictBrief.Type;

/**
 * The paths a rebase conflicted in, from the sandbox's reason (`… conflicts
 * in a.py, b.py`); `fallback` (the paths both sides touched) when it names
 * none.
 */
export const conflictPaths = (reason: string, fallback: ReadonlyArray<string>): ReadonlyArray<string> => {
  const named = /conflicts in (.+)$/u.exec(reason.trim())?.[1];

  const paths = (named ?? "")
    .split(", ")
    .map((path) => path.trim())
    .filter((path) => path !== "" && !/\s/u.test(path));

  return paths.length > 0 ? paths : [...fallback];
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** `bytes` as text, or undefined when absent or not UTF-8. */
const textOf = (bytes: Uint8Array | undefined) => {
  try {
    return bytes === undefined ? undefined : utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

const clip = (text: string, max: number) => ({ text: text.length > max ? text.slice(0, max) : text, truncated: text.length > max });

const MARKS = { context: " ", added: "+", removed: "-" } as const;

/** `files` as a unified diff, the way `git diff` prints text changes. */
export const unifiedDiff = (files: ReadonlyArray<FileDiff>): string =>
  files
    .map((file) => {
      const from = file.change === "added" ? "/dev/null" : `a/${file.path}`;
      const to = file.change === "removed" ? "/dev/null" : `b/${file.path}`;
      const header = `--- ${from}\n+++ ${to}`;

      if (file.content.kind !== "text") {
        return `${header}\n(${file.content.kind === "binary" ? "binary" : "too large to show"})`;
      }

      const hunks = file.content.hunks.map(
        (hunk) =>
          `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@\n${hunk.lines.map((line) => `${MARKS[line.kind]}${line.text}`).join("\n")}`,
      );

      return [header, ...hunks].join("\n");
    })
    .join("\n");

/** A brief bounded for a model's context: the diff cut at `DIFF_MAX`, at most `FILES_MAX` head files of `FILE_MAX` each. */
export const conflictBrief = (
  attempt: AttemptId,
  onto: NodeId,
  paths: ReadonlyArray<string>,
  intended: ReadonlyArray<FileDiff>,
  headFiles: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array | undefined }>,
): ConflictBrief => {
  const diff = clip(unifiedDiff(intended), DIFF_MAX);

  return {
    attempt,
    onto,
    paths: [...paths],
    intended: diff.truncated ? `${diff.text}\n… (diff cut at ${DIFF_MAX} characters)` : diff.text,
    head_files: headFiles.slice(0, FILES_MAX).map((file) => {
      const shown = clip(textOf(file.content) ?? "", FILE_MAX);

      return { path: file.path, content: shown.text, truncated: shown.truncated };
    }),
  };
};

/** The words an agent's prompt gains for a conflict it is handed. */
export const conflictInstructions = (brief: ConflictBrief): string =>
  [
    `This attempt continues attempt ${brief.attempt}, whose change was made on an older head. Replaying its commits onto node ${brief.onto} conflicted in ${brief.paths.join(", ") || "files both sides changed"}.`,
    "Re-apply that attempt's intent on your checkout (the current head): make the same change, adapted to what the head now has in those files. Keep what the head gained; do not revert it.",
    "",
    `The change attempt ${brief.attempt} made, against its old base:`,
    "```diff",
    brief.intended,
    "```",
    ...brief.head_files.flatMap((file) => [
      "",
      `${file.path} on the head${file.truncated ? ` (first ${FILE_MAX} characters)` : ""}:`,
      file.content === "" ? "(absent on the head, or not text)" : ["```", file.content, "```"].join("\n"),
    ]),
  ].join("\n");
