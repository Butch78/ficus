import { Badge } from "@cloudflare/kumo";
import type { Standing } from "../lib/answers.ts";
import { say, type Tone } from "../lib/standing.ts";

/** Kumo's status badges, by where an attempt stands in its race. */
export const TONE_BADGE = {
  winner: "success",
  passing: "info",
  failing: "error",
  behind: "warning",
  working: "neutral",
  checking: "orange",
  accepted: "green",
  closed: "secondary",
} as const satisfies Record<Tone, string>;

export function StandingBadge({ standing }: { readonly standing: Standing }) {
  const { tone, short } = say(standing);

  return (
    <Badge variant={TONE_BADGE[tone]} appearance="dot">
      {short}
    </Badge>
  );
}
