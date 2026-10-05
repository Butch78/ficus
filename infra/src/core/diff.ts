/**
 * An attempt's change as a person reads it: which files changed, and for
 * text, the lines added and removed in hunks with context. The tree Worker
 * finds the changed files by walking two git trees in Artifacts; this module
 * only turns their contents into a diff, so it tests without a Worker.
 */
import { structuredPatch } from "diff";

/** Lines of unchanged context around each hunk, as `git diff` shows. */
export const CONTEXT = 3;

export type FileChange = "added" | "removed" | "modified";

export type LineKind = "context" | "added" | "removed";

export interface Line {
  readonly kind: LineKind;
  readonly text: string;
}

/** A run of changes with its context; lines are 1-based, as in `@@ -a,b +c,d @@`. */
export interface Hunk {
  readonly old_start: number;
  readonly old_lines: number;
  readonly new_start: number;
  readonly new_lines: number;
  readonly lines: ReadonlyArray<Line>;
}

/** What a file's change shows: its lines, or why they are not shown. */
export type Content =
  | { readonly kind: "text"; readonly additions: number; readonly deletions: number; readonly hunks: ReadonlyArray<Hunk> }
  /** Not UTF-8 on either side. */
  | { readonly kind: "binary" }
  /** Larger than a reader would page through; counted, not shown. */
  | { readonly kind: "too_large" };

export interface FileDiff {
  readonly path: string;
  readonly change: FileChange;
  readonly content: Content;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const text = (bytes: Uint8Array | undefined) => {
  try {
    return bytes === undefined ? "" : utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

const KINDS: ReadonlyMap<string, LineKind> = new Map([
  [" ", "context"],
  ["+", "added"],
  ["-", "removed"],
]);

/** The diff from `old` to `updated`, either side absent for an added or removed file. */
export const content = (old: Uint8Array | undefined, updated: Uint8Array | undefined): Content => {
  const [before, after] = [text(old), text(updated)];

  if (before === undefined || after === undefined) {
    return { kind: "binary" };
  }

  let additions = 0;
  let deletions = 0;

  const hunks = structuredPatch("a", "b", before, after, undefined, undefined, { context: CONTEXT }).hunks.map((hunk): Hunk => {
    const lines = hunk.lines.flatMap((line): ReadonlyArray<Line> => {
      // "\ No newline at end of file" describes the line before it; git shows it, a reader need not.
      const kind = KINDS.get(line.charAt(0));

      if (kind === "added") {
        additions += 1;
      }

      if (kind === "removed") {
        deletions += 1;
      }

      return kind === undefined ? [] : [{ kind, text: line.slice(1) }];
    });

    return {
      old_start: hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart,
      old_lines: hunk.oldLines,
      new_start: hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart,
      new_lines: hunk.newLines,
      lines,
    };
  });

  return { kind: "text", additions, deletions, hunks };
};
