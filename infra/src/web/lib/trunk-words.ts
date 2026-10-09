/**
 * The tree page's history in words, beside its drawing of the trunk: what
 * each node settled and how its attempts went. Plain functions over
 * `trunkStory`'s answer, so they test without a Worker.
 */
import type { AttemptStory, NodeStory, Outcome } from "./trunk.ts";

export const OUTCOME_WORD = {
  accepted: "accepted",
  lost: "lost",
  abandoned: "abandoned",
  rebased: "rebased",
  retried: "retried",
  open: "still open",
} as const satisfies Record<Outcome, string>;

/** Names listed for a sentence: "a", "a and b", "a, b and c", "a, b, c and 2 more". */
export const listed = (names: ReadonlyArray<string>) => {
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  const last = shown.at(-1) ?? "";

  return shown.length <= 1 ? last : `${shown.slice(0, -1).join(", ")} and ${last}`;
};

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "once", "twice", "3 times". */
const times = (count: number) => {
  if (count === 1) {
    return "once";
  }

  return count === 2 ? "twice" : `${count} times`;
};

/**
 * One piece of work at a task: the attempt it ended in, and how often it was
 * rebased or retried on the way there. A rebase replays the same commits onto
 * a newer head and a retry hands a conflict back to the same agent, so each
 * hop is the same work moved on, not another attempt competing.
 */
export interface AttemptChain {
  readonly last: AttemptStory;
  /** Every attempt of the work, oldest first: the hops it was moved on through, then `last`. */
  readonly line: ReadonlyArray<AttemptStory>;
  readonly rebased: number;
  readonly retried: number;
}

/** Whether `attempt` was moved on into another attempt that is also at this task. */
const movedOn = (attempt: AttemptStory, ids: ReadonlySet<number>) =>
  (attempt.outcome === "rebased" || attempt.outcome === "retried") && attempt.other !== undefined && ids.has(attempt.other);

/** The node's attempts as pieces of work, in the order their last attempts come (the winner first). */
export const attemptChains = (attempts: ReadonlyArray<AttemptStory>): ReadonlyArray<AttemptChain> => {
  const ids = new Set(attempts.map((attempt) => attempt.attempt));
  const into = new Map(attempts.flatMap((attempt) => (movedOn(attempt, ids) ? [[attempt.other, attempt] as const] : [])));

  return attempts.flatMap((last) => {
    if (movedOn(last, ids)) {
      return [];
    }

    const seen = new Set([last.attempt]);
      const line = [last];
      let rebased = 0;
      let retried = 0;
      let before = into.get(last.attempt);

      while (before !== undefined && !seen.has(before.attempt)) {
        seen.add(before.attempt);
        line.unshift(before);
        rebased += before.outcome === "rebased" ? 1 : 0;
        retried += before.outcome === "retried" ? 1 : 0;
        before = into.get(before.attempt);
      }

      return [{ last, line, rebased, retried }];
  });
};

/** How a chain was moved on, as words: "rebased once", "rebased twice and retried once". */
const hopWords = (rebased: number, retried: number) =>
  [...(rebased === 0 ? [] : [`rebased ${times(rebased)}`]), ...(retried === 0 ? [] : [`retried ${times(retried)}`])].join(" and ");

/** The outcomes other than the winner's, in the order a summary counts them. */
const OTHERS = ["lost", "abandoned", "rebased", "retried", "open"] as const;

const scored = (attempt: AttemptStory) => (attempt.score === undefined ? "" : ` (${attempt.score})`);

/**
 * The pieces of work that did not win, counted by what became of them: "2 lost, 1 abandoned".
 * With no score for the winner, a lone loser's score is the nearest thing to why it lost.
 */
const counted = (others: ReadonlyArray<AttemptChain>, winnerScored: boolean) =>
  OTHERS.flatMap((outcome) => {
    const these = others.filter(({ last }) => last.outcome === outcome);
    const lone = these.length === 1 && !winnerScored && outcome === "lost" ? these[0] : undefined;

    return these.length === 0 ? [] : [`${these.length} ${OUTCOME_WORD[outcome]}${lone === undefined ? "" : scored(lone.last)}`];
  }).join(", ");

/** How the node's task was won: who worked on it, who won and how it scored, what became of the rest, and how often work was moved on. */
const race = (attempts: ReadonlyArray<AttemptStory>) => {
  const chains = attemptChains(attempts);
  const winner = chains.find(({ last }) => last.outcome === "accepted");

  if (chains.length === 1 && winner !== undefined) {
    const hops = hopWords(winner.rebased, winner.retried);

    return `One attempt, by ${winner.last.agent}${scored(winner.last)}${hops === "" ? "" : `, ${hops}`}.`;
  }

  const agents = listed([...new Set(attempts.map((attempt) => attempt.agent))]);
  const won = winner === undefined ? [] : [`${winner.last.agent} won${scored(winner.last)}`];

  const rest = counted(
    chains.filter((chain) => chain !== winner),
    winner?.last.score !== undefined,
  );

  const hops = hopWords(
    chains.reduce((sum, chain) => sum + chain.rebased, 0),
    chains.reduce((sum, chain) => sum + chain.retried, 0),
  );

  const clauses = [...won, ...(rest === "" ? [] : [rest]), ...(hops === "" ? [] : [`${hops} along the way`])];

  return `${plural(chains.length, "attempt")} by ${agents}: ${clauses.join("; ")}.`;
};

/** One line under the node's task: how the node came to be. */
export const nodeSummary = (story: NodeStory) => {
  if (story.kind === "root") {
    return "The code the tree started from.";
  }

  if (story.kind === "graft") {
    return "An outside commit, imported onto the trunk.";
  }

  return story.attempts.length === 0 ? "Accepted." : race(story.attempts);
};

/** How long a headline runs before it is cut at a word. */
const HEADLINE = 110;

/** An intent's first sentence, cut at a word when it runs long: intents are often paragraphs. */
export const headline = (intent: string) => {
  const first = intent.trim().split(/(?<=[.!?])\s|\n/u)[0] ?? "";

  if (first.length <= HEADLINE) {
    return first;
  }

  const cut = first.slice(0, HEADLINE);
  const word = cut.lastIndexOf(" ");

  return `${cut.slice(0, word > HEADLINE / 2 ? word : HEADLINE).replace(/[\s,;:]+$/u, "")}…`;
};

/** Where a graft came from, said short: `https://github.com/o/r.git#main` → "github.com/o/r (main)". */
export const graftSource = (from: string | undefined) => {
  if (from === undefined || from === "") {
    return "an outside commit";
  }

  const [repo = "", branch = ""] = from
    .replace(/^https?:\/\//u, "")
    .replace(/\.git(?=#|$)/u, "")
    .split("#");

  return branch === "" ? repo : `${repo} (${branch})`;
};

/** What the node settled, as its heading says it: the task's intent's first sentence, or where the code came from. */
export const nodeIntent = (story: NodeStory) => {
  if (story.task !== undefined) {
    return headline(story.task.intent);
  }

  return story.kind === "graft" ? `Grafted from ${graftSource(story.graftedFrom)}` : "Root, as initialized";
};

/** Whether `story` may share a row with the graft above it: grafts from the same place, neither the head nor released. */
const joins = (above: NodeStory | undefined, story: NodeStory) =>
  above !== undefined &&
  above.kind === "graft" &&
  story.kind === "graft" &&
  !above.head &&
  !above.released &&
  !story.released &&
  graftSource(above.graftedFrom) === graftSource(story.graftedFrom);

/** One row of the trunk: a node, or a run of grafts from one place, head first. */
export type TrunkRow = readonly [NodeStory, ...ReadonlyArray<NodeStory>];

/** The trunk as rows, head first: one node per row, except that a run of grafts from one place shares a row. */
export const trunkRows = (stories: ReadonlyArray<NodeStory>): ReadonlyArray<TrunkRow> =>
  stories.reduce<Array<[NodeStory, ...Array<NodeStory>]>>((rows, story) => {
    const last = rows.at(-1);

    if (last !== undefined && joins(last.at(-1), story)) {
      last.push(story);
    } else {
      rows.push([story]);
    }

    return rows;
  }, []);

/** How a run of grafts reads in its heading: "7 outside commits imported from github.com/o/r (deploys)". */
export const graftRunIntent = (run: TrunkRow) => `${run.length} outside commits imported from ${graftSource(run[0].graftedFrom)}`;

/** How an attempt points at the other one it names: lost to it, rebased into it, retried as it. */
const RELATION: Partial<Record<Outcome, string>> = { lost: "to", rebased: "into", retried: "as" };

/** What became of an attempt beyond its outcome, and how it scored: "to attempt 12 · 3/5 checks, cost 20". */
export const attemptDetail = (attempt: AttemptStory) => {
  const word = RELATION[attempt.outcome];
  const relation = word === undefined || attempt.other === undefined ? [] : [`${word} attempt ${attempt.other}`];

  const note = attempt.outcome === "abandoned" && attempt.note !== undefined && attempt.note !== "" ? [attempt.note] : [];
  // The tree keeps no score for an accepted attempt once it is a node, so it goes unsaid rather than "never scored".
  const unscored = attempt.outcome === "accepted" ? [] : ["never scored"];
  const score = attempt.score === undefined ? unscored : [attempt.score];

  return [...relation, ...score, ...note].join(" · ");
};

/** How many paths an accepted node changed; nodes recorded before `touched` existed have none, which says nothing. */
export const changedPaths = (story: NodeStory) =>
  story.kind === "accepted" && story.touched.length > 0 ? `${plural(story.touched.length, "path")} changed` : undefined;

/** The label of a node's details: what opening them shows. */
export const detailsLabel = (story: NodeStory) => {
  const chains = attemptChains(story.attempts).length;
  const paths = changedPaths(story);

  const parts = [
    ...(chains === 0 ? [] : [plural(chains, "attempt")]),
    ...(story.deploys.length === 0 ? [] : [plural(story.deploys.length, "deploy")]),
    ...(paths === undefined ? [] : [paths]),
  ];

  return parts.length === 0 ? "Details" : `Details: ${parts.join(", ")}`;
};
