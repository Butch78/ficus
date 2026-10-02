import { Badge } from "@cloudflare/kumo";
import type { Standing } from "../lib/answers.ts";
import { say, type Tone } from "../lib/standing.ts";

/** Kumo's status badges, by where a leaf stands in its race. */
export const TONE_BADGE = {
  winner: "success",
  passing: "info",
  failing: "error",
  stale: "warning",
  growing: "neutral",
  ripening: "orange",
  fruit: "green",
  pruned: "secondary",
} as const satisfies Record<Tone, string>;

export function StandingBadge({ standing }: { readonly standing: Standing }) {
  const { tone, short } = say(standing);

  return (
    <Badge variant={TONE_BADGE[tone]} appearance="dot">
      {short}
    </Badge>
  );
}
