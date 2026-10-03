/**
 * A change as a person reviews it: each changed file with its additions and
 * deletions, its hunks numbered like `git diff`. From the tree Worker's
 * `.../diff`, which walks the two commits in Artifacts.
 */
import { Badge, Empty, LayerCard, Text } from "@cloudflare/kumo";
import type { Diff, FileDiff, Hunk } from "../lib/answers.ts";
import { LayerCardPrimary, LayerCardSecondary } from "./kumo.ts";

const CHANGE_BADGE = { added: "green", removed: "red", modified: "neutral" } as const satisfies Record<FileDiff["change"], string>;

/** Each line with its numbers on the old and new side, as `git diff` counts them. */
const numbered = (hunk: Hunk) => {
  let old = hunk.old_start;
  let next = hunk.new_start;

  return hunk.lines.map((line) => {
    const row = {
      ...line,
      old: line.kind === "added" ? undefined : old,
      new: line.kind === "removed" ? undefined : next,
    };

    old += line.kind === "added" ? 0 : 1;
    next += line.kind === "removed" ? 0 : 1;

    return row;
  });
};

const ROW = {
  added: "bg-kumo-success-tint",
  removed: "bg-kumo-danger-tint",
  context: "",
} as const;

const SIGN = { added: "+", removed: "-", context: " " } as const;

function FileChange({ file }: { readonly file: FileDiff }) {
  return (
    <LayerCard>
      <LayerCardSecondary className="flex flex-wrap items-center gap-2">
        <Text variant="mono">{file.path}</Text>
        <Badge variant={CHANGE_BADGE[file.change]}>{file.change}</Badge>
        {file.content.kind === "text" ? (
          <span className="text-xs">
            <span className="text-kumo-success">+{file.content.additions}</span>{" "}
            <span className="text-kumo-danger">-{file.content.deletions}</span>
          </span>
        ) : null}
      </LayerCardSecondary>
      <LayerCardPrimary className="overflow-x-auto p-0">
        {file.content.kind === "text" ? (
          <table className="w-full border-collapse font-mono text-xs">
            <tbody>
              {file.content.hunks.map((hunk) => (
                <HunkRows key={`${hunk.old_start}-${hunk.new_start}`} hunk={hunk} />
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-3">
            <Text variant="secondary" size="sm">
              {file.content.kind === "binary" ? "Binary file: not shown." : "Too large to show."}
            </Text>
          </div>
        )}
      </LayerCardPrimary>
    </LayerCard>
  );
}

function HunkRows({ hunk }: { readonly hunk: Hunk }) {
  return (
    <>
      <tr className="bg-kumo-recessed text-kumo-subtle">
        <td colSpan={4} className="px-3 py-1">
          @@ -{hunk.old_start},{hunk.old_lines} +{hunk.new_start},{hunk.new_lines} @@
        </td>
      </tr>
      {numbered(hunk).map((line, index) => (
        <tr key={index} className={ROW[line.kind]}>
          <td className="w-10 select-none px-2 text-right text-kumo-subtle">{line.old ?? ""}</td>
          <td className="w-10 select-none px-2 text-right text-kumo-subtle">{line.new ?? ""}</td>
          <td className="w-4 select-none text-kumo-subtle">{SIGN[line.kind]}</td>
          <td className="whitespace-pre-wrap break-all pr-3 text-kumo-default">{line.text}</td>
        </tr>
      ))}
    </>
  );
}

export function DiffView({ diff }: { readonly diff: Diff }) {
  const totals = diff.files.reduce(
    (sum, file) =>
      file.content.kind === "text"
        ? { additions: sum.additions + file.content.additions, deletions: sum.deletions + file.content.deletions }
        : sum,
    { additions: 0, deletions: 0 },
  );

  if (diff.files.length === 0) {
    return <Empty size="sm" title="No changes yet" description="This is the same as the commit it started from." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <Text variant="secondary" size="sm">
        {diff.files.length} {diff.files.length === 1 ? "file" : "files"} changed,{" "}
        <span className="text-kumo-success">+{totals.additions}</span>{" "}
        <span className="text-kumo-danger">-{totals.deletions}</span>, from {diff.base.slice(0, 8)} to{" "}
        {diff.head.slice(0, 8)}
        {diff.truncated ? " (more files changed than are shown)" : ""}.
      </Text>
      {diff.files.map((file) => (
        <FileChange key={file.path} file={file} />
      ))}
    </div>
  );
}
