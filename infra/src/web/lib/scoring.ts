/**
 * A leaf's scoring, said as it goes: the steps its sandbox streams
 * (crates/ficus-core/src/progress.rs `ScoreStep`), in words. Pure.
 */
import type { StepStatus } from "../components/elements/chain-of-thought.tsx";
import type { Ledger } from "./answers.ts";

type Entry = Ledger["entries"][number];

const WORDS = {
  sandbox: ["Starting a sandbox, the internet off", "Started a sandbox, the internet off"],
  clone: ["Cloning the leaf", "Cloned the leaf"],
  restore: ["Putting the root's checks back", "Put the root's checks back: the leaf cannot change them"],
  devenv: ["Building the root's devenv shell (slow the first time)", "Built the root's devenv shell"],
  cost: ["Measuring the change", "Measured the change"],
} as const;

const isKnown = (step: string): step is keyof typeof WORDS => step in WORDS;

export const scoringLabel = ({ step, item, state }: Entry) => {
  const done = state !== "active";

  if (step === "check") {
    if (state === "error") {
      return `Check ${item ?? ""} failed`;
    }

    return done ? `Check ${item ?? ""} passed` : `Running check ${item ?? ""}, no network`;
  }

  return isKnown(step) ? WORDS[step][done ? 1 : 0] : step;
};

export const scoringStatus = ({ state }: Entry): StepStatus => (state === "active" ? "active" : state);

/** The step running now, or the last one to finish: a race card's one line. */
export const current = (ledger: Ledger) => ledger.entries.findLast((entry) => entry.state === "active") ?? ledger.entries.at(-1);

export const elapsed = (entry: Entry, now: number) => {
  const ms = Math.max(0, (entry.ended_at ?? now) - entry.started_at);

  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};
