import { Badge, Text } from "@cloudflare/kumo";
import type { LeafState } from "../lib/answers.ts";
import { short, status, type Tone } from "../lib/view.ts";

/** Kumo's status badges, by where the leaf stands. */
const BADGE = {
  growing: "neutral",
  ripening: "warning",
  ripe: "success",
  failing: "error",
  fruit: "green",
  pruned: "secondary",
} as const satisfies Record<Tone, string>;

export function LeafStatus({ state }: { readonly state: LeafState }) {
  const { tone, label, commit } = status(state);

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={BADGE[tone]} appearance="dot">
        {tone}
      </Badge>
      <Text as="span" size="sm">
        {label}
      </Text>
      {commit === undefined ? null : (
        <Text variant="mono-secondary">
          {short(commit)}
        </Text>
      )}
    </span>
  );
}
