"use client";

/**
 * A task's attempts, live: each card as the race stands now, asked for again
 * every few seconds while an attempt works or is checked (lib/use-live.ts).
 * When the race settles, the page refreshes once, so the case for accepting
 * catches up.
 */
import { Loader, Text } from "@cloudflare/kumo";
import { agentsOf, LiveRace, raceMoving } from "../lib/live.ts";
import { useLive } from "../lib/use-live.ts";
import { AttemptCard } from "./attempt-card.tsx";

interface Props {
  readonly org: string;
  readonly tree: string;
  /** The race as the page was drawn. */
  readonly initial: LiveRace;
}

export function LiveAttempts({ org, tree, initial }: Props) {
  const live = useLive({ kind: "race", org, tree, id: initial.race.task.id }, LiveRace, initial, raceMoving);
  const agents = agentsOf(live);

  return (
    <>
      {raceMoving(live) ? (
        <span className="inline-flex items-center gap-2">
          <Loader size={12} />
          <Text variant="secondary" as="span" size="xs">
            Live: attempts are working or being checked
          </Text>
        </span>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {live.race.attempts.map((entry) => (
          <AttemptCard key={entry.attempt.id} entry={entry} org={org} tree={tree} agent={agents.get(entry.attempt.id)} />
        ))}
      </div>
    </>
  );
}
