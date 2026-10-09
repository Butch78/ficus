"use client";

/**
 * The tree page's live parts: the open tasks growing from the head of the
 * history, and the race panel of the one being watched. TanStack Query keeps
 * them fresh (lib/use-live.ts), and both read the same cached race.
 */
import { Badge, Link, Loader, Text } from "@cloudflare/kumo";
import { growing, type GrowingStory } from "../lib/growing.ts";
import { agentsOf, LiveRace, raceMoving } from "../lib/live.ts";
import { taskName } from "../lib/trunk-words.ts";
import { useLive, useLiveRaces } from "../lib/use-live.ts";
import { FlowParallel } from "./kumo.ts";
import { TaskFlow } from "./node-flow.tsx";
import { TONE_BADGE } from "./standing-badge.tsx";
import { FullPrompt } from "./task-prompt.tsx";
import { Card } from "./trunk-card.tsx";

/** How many growing tasks branch from the head side by side; more would leave each too narrow to read. */
const BRANCHES = 3;

interface GrowingProps {
  readonly org: string;
  readonly tree: string;
  readonly member: boolean;
  /** The open tasks' races as the page was drawn, newest task first. */
  readonly initial: ReadonlyArray<LiveRace>;
  /** The task the panel shows, if it is one of these. */
  readonly watched: number | undefined;
  /** Where each task's "Watch the race" goes, by task. */
  readonly hrefs: Readonly<Record<string, string>>;
}

/** Each live race's growing story, if it has attempts still in the race. */
const storiesOf = (races: ReadonlyArray<LiveRace>) => races.flatMap((live) => growing([live.race], agentsOf(live)));

/**
 * The open tasks growing from the head, side by side above it: a card each,
 * newest first. Their races stay fresh in the browser (lib/use-live.ts), asked
 * for again every few seconds while any attempt still moves.
 */
export function LiveGrowing({ org, tree, member, initial, watched, hrefs }: GrowingProps) {
  const base = `/orgs/${org}/trees/${tree}`;
  const shown = storiesOf(useLiveRaces(org, tree, initial)).slice(0, BRANCHES);

  const card = (story: GrowingStory) => (
    <GrowingCard
      key={story.task.id}
      base={base}
      member={member}
      story={story}
      share={shown.length}
      watched={watched === story.task.id}
      open={hrefs[String(story.task.id)] ?? "#history"}
    />
  );

  if (shown.length <= 1) {
    return shown.map(card);
  }

  return <FlowParallel>{shown.map(card)}</FlowParallel>;
}

interface GrowingCardProps {
  readonly base: string;
  readonly member: boolean;
  readonly story: GrowingStory;
  /** How many cards share the row. */
  readonly share: number;
  readonly watched: boolean;
  readonly open: string;
}

function GrowingCard({ base, member, story, share, watched, open }: GrowingCardProps) {
  return (
    <Card share={share}>
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">growing</Badge>
        {story.live ? <Loader size={12} /> : null}
        {member ? <Link href={`${base}/tasks/${story.task.id}`}>task {story.task.id}</Link> : <Text size="sm">task {story.task.id}</Text>}
      </span>
      <Text size="sm">{taskName(story.task)}</Text>
      <ul className="flex flex-col gap-1">
        {story.attempts.map((attempt) => (
          <li key={attempt.attempt} className="flex min-w-0 flex-col items-start gap-0.5">
            <Badge variant={TONE_BADGE[attempt.tone]} appearance="dot">
              {attempt.agent}
            </Badge>
            <span className="line-clamp-2 min-w-0">
              <Text variant="secondary" size="xs" as="span">
                {attempt.words}
              </Text>
            </span>
          </li>
        ))}
      </ul>
      {watched ? (
        <span className="flex items-center gap-2">
          <Badge variant="outline">shown</Badge>
          <Text variant="secondary" size="xs" as="span">
            its race is in the panel
          </Text>
        </span>
      ) : (
        <Link href={open}>Watch the race</Link>
      )}
    </Card>
  );
}

interface PanelProps {
  readonly org: string;
  readonly tree: string;
  readonly member: boolean;
  readonly initial: LiveRace;
}

/** A growing task's race as it runs, live in the browser: its flow and the task in full; gone once the race is over. */
export function LiveTaskPanel({ org, tree, member, initial }: PanelProps) {
  const base = `/orgs/${org}/trees/${tree}`;
  const live = useLive({ kind: "race", org, tree, id: initial.race.task.id }, LiveRace, initial, raceMoving);
  const [story] = growing([live.race], agentsOf(live));

  if (story === undefined) {
    return null;
  }

  return (
    <section className="order-first flex min-w-0 flex-col gap-3 rounded-lg border border-kumo-hairline p-4 lg:sticky lg:top-4 lg:order-none">
      <span className="flex items-center gap-2">
        <Text variant="heading3" as="h3">
          {taskName(story.task)}
        </Text>
        {story.live ? <Loader size={14} /> : null}
      </span>
      <Text variant="secondary" size="xs">
        Growing: task {story.task.id}
      </Text>
      <TaskFlow base={base} member={member} story={story} />
      <FullPrompt intent={story.task.intent} />
    </section>
  );
}
