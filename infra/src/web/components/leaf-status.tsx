import type { LeafState } from "../lib/answers.ts";
import { short, status } from "../lib/view.ts";

export function LeafStatus({ state }: { readonly state: LeafState }) {
  const { tone, label, commit } = status(state);

  return (
    <>
      <span className={`tone tone-${tone}`}>{tone}</span> {label}
      {commit === undefined ? null : (
        <>
          {" "}
          at <code>{short(commit)}</code>
        </>
      )}
    </>
  );
}
