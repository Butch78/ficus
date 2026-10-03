import { Badge, Text } from "@cloudflare/kumo";
import type { AttemptState } from "../lib/answers.ts";
import { short, status, type Tone } from "../lib/view.ts";

/** Kumo's status badges, by where the attempt stands. */
const BADGE = {
  working: "neutral",
  checking: "warning",
  scored: "success",
  failing: "error",
  accepted: "green",
  closed: "secondary",
} as const satisfies Record<Tone, string>;

export function AttemptStatus({ state }: { readonly state: AttemptState }) {
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
