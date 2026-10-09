/**
 * The work growing from the head: each open task with attempts in its race,
 * every attempt said as it is right now (an agent's latest tool call, the
 * scoring step running, or where it stands once scored). Pure, so the page
 * can refresh it while the work goes on and tests hold the wording.
 */
import type { AgentStatus, TaskRace } from "./answers.ts";
import { current, scoringLabel } from "./scoring.ts";
import { say, type Tone } from "./standing.ts";

type Entry = TaskRace["attempts"][number];

export interface LiveAttempt {
  readonly attempt: number;
  readonly agent: string;
  readonly tone: Tone;
  /** What it is doing now, or where it stands. */
  readonly words: string;
  /** Whether it is still moving: working, or its checks running. */
  readonly live: boolean;
}

export interface GrowingStory {
  readonly task: { readonly id: number; readonly intent: string };
  /** Its attempts still in the race, oldest first. */
  readonly attempts: ReadonlyArray<LiveAttempt>;
  readonly live: boolean;
}

/** What a working attempt is doing: its agent's latest tool call, or that a person is at it. */
const working = (entry: Entry, agent: AgentStatus | undefined) => {
  if (entry.agent === undefined || entry.agent === null) {
    return "being worked on by hand";
  }

  const last = agent?.calls.at(-1);

  if (last !== undefined) {
    return `${last.tool}: ${last.summary}`;
  }

  return agent?.phase === "change" ? `${entry.agent}: making the change` : `${entry.agent}: reading the task`;
};

const words = (entry: Entry, agent: AgentStatus | undefined) => {
  if (entry.standing === "Working") {
    return working(entry, agent);
  }

  const step = entry.standing === "Checking" && entry.scoring !== undefined && entry.scoring !== null ? current(entry.scoring) : undefined;

  return step === undefined ? say(entry.standing).short : scoringLabel(step);
};

/** Out of the race: closed, or accepted (the task is done then). */
const isClosed = (entry: Entry) => ["closed", "accepted"].includes(say(entry.standing).tone);

const liveAttempt = (entry: Entry, agents: ReadonlyMap<number, AgentStatus | undefined>): LiveAttempt => ({
  attempt: entry.attempt.id,
  agent: entry.attempt.agent,
  tone: say(entry.standing).tone,
  words: words(entry, agents.get(entry.attempt.id)),
  live: entry.standing === "Working" || entry.standing === "Checking",
});

/** The open tasks that have attempts still in their race, newest task first; `agents` holds what each working agent reported. */
export const growing = (races: ReadonlyArray<TaskRace>, agents: ReadonlyMap<number, AgentStatus | undefined>): ReadonlyArray<GrowingStory> =>
  races.flatMap((race) => {
    const attempts = race.attempts
      .filter((entry) => !isClosed(entry))
      .toSorted((one, other) => one.attempt.id - other.attempt.id)
      .map((entry) => liveAttempt(entry, agents));

    return race.task.state !== "Open" || attempts.length === 0
      ? []
      : [{ task: { id: race.task.id, intent: race.task.intent }, attempts, live: attempts.some((attempt) => attempt.live) }];
  });

/** The working attempts an agent is at, whose status the page asks for. */
export const agentAttempts = (races: ReadonlyArray<TaskRace>) =>
  races.flatMap((race) => race.attempts.filter((entry) => entry.standing === "Working" && entry.agent !== undefined && entry.agent !== null).map((entry) => entry.attempt.id));
