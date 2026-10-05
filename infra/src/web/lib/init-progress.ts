/**
 * An init as it happens: the progress lines the tree streams
 * (src/core/progress.ts, plus the Api's `record`), folded into
 * the state of each step the person sees. Pure, so it tests without a stream.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StepStatus } from "../components/elements/chain-of-thought.tsx";

/** An init from a remote, in order: the UI's own check first, the Api's record last. */
export const INIT_STEPS = ["membership", "import", "settle", "lock", "save", "record"] as const;

export type InitStep = (typeof INIT_STEPS)[number];

const isInitStep = Schema.is(Schema.Literals(INIT_STEPS));

/** The answer a streamed init ends with: text, an `{error}`, or the tree. */
const ErrorBody = Schema.Struct({ error: Schema.String });

const OutcomeBody = Schema.Union([Schema.String, ErrorBody, Schema.Struct({})]);

type OutcomeBody = typeof OutcomeBody.Type;

const Line = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("step"),
    step: Schema.String,
    state: Schema.Literals(["active", "complete", "error"]),
    detail: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("outcome"), status: Schema.Number, body: OutcomeBody }),
]);

export type Line = typeof Line.Type;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

const isErrorBody = Schema.is(ErrorBody);

const isText = Schema.is(Schema.String);

export interface StepProgress {
  readonly status: StepStatus;
  readonly detail: string | undefined;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
}

export interface InitProgress {
  readonly steps: ReadonlyMap<InitStep, StepProgress>;
  /** Set by the last line: whether the init happened, and if not, why. */
  readonly outcome: { readonly succeeded: boolean; readonly message: string } | undefined;
}

const pending: StepProgress = { status: "pending", detail: undefined, startedAt: undefined, endedAt: undefined };

/** Before the Api answers: checking membership, everything else to come. */
export const started = (now: number): InitProgress => ({
  steps: new Map(INIT_STEPS.map((step) => [step, step === "membership" ? { ...pending, status: "active", startedAt: now } : pending])),
  outcome: undefined,
});

const update = (
  progress: InitProgress,
  step: InitStep,
  change: (current: StepProgress) => StepProgress,
): InitProgress => {
  const steps = new Map(progress.steps);

  steps.set(step, change(steps.get(step) ?? pending));

  return { ...progress, steps };
};

/** The Api began streaming: it only does once it has checked membership. */
export const connected = (progress: InitProgress, now: number): InitProgress =>
  update(progress, "membership", (current) => ({ ...current, status: "complete", endedAt: now }));

const messageOf = (body: OutcomeBody) => {
  if (isText(body)) {
    return body;
  }

  return isErrorBody(body) ? body.error : JSON.stringify(body);
};

/** One line of the stream, applied. Lines this UI does not know are skipped. */
export const apply = (progress: InitProgress, text: string, now: number): InitProgress =>
  Option.match(decodeLine(text), {
    onNone: () => progress,
    onSome: (line) => {
      if (line.kind === "outcome") {
        const succeeded = line.status >= 200 && line.status < 300;

        return { ...progress, outcome: { succeeded, message: succeeded ? "" : messageOf(line.body) } };
      }

      if (!isInitStep(line.step)) {
        return progress;
      }

      return update(progress, line.step, (current) => ({
        status: line.state === "active" ? "active" : line.state,
        detail: line.detail ?? current.detail,
        startedAt: current.startedAt ?? now,
        endedAt: line.state === "active" ? undefined : now,
      }));
    },
  });

/** An init that failed before streaming (no membership, the Api unreachable). */
export const refused = (progress: InitProgress, message: string, now: number): InitProgress => ({
  ...update(progress, "membership", (current) => ({ ...current, status: "error" as const, endedAt: now })),
  outcome: { succeeded: false, message },
});

/** Complete lines out of what has arrived so far, and the unfinished rest. */
export const split = (buffer: string) => {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";

  return { lines: lines.filter((line) => line.trim() !== ""), rest };
};

export interface Context {
  readonly org: string;
  readonly source: string;
}

/** What a step says: what it will do or is doing, and what it did. */
export const label = (step: InitStep, status: StepStatus, { org, source }: Context) => {
  const done = status === "complete";

  switch (step) {
    case "membership":
      return done ? `Checked you belong to ${org}` : `Checking you belong to ${org}`;
    case "import":
      return done ? `Artifacts accepted ${source}` : `Asking Artifacts to import ${source}`;
    case "settle":
      return done ? "The import landed" : "Waiting for the import to land";
    case "lock":
      return done ? "Locked the root: its write tokens are revoked" : "Locking the root: revoking its write tokens";
    case "save":
      return done ? "Saved the tree" : "Saving the tree";
    case "record":
      return done ? `Listed the tree in ${org}` : `Listing the tree in ${org}`;
  }
};

/**
 * The line under a step, if it adds anything: an error's reason, the import's
 * wait, the commit it landed at. The import's own detail is its source, which
 * its label already says.
 */
export const description = (step: InitStep, { status, detail }: StepProgress) => {
  if (detail === undefined || (step === "import" && status !== "error")) {
    return undefined;
  }

  return step === "settle" && status === "complete" ? `at ${detail.slice(0, 8)}` : detail;
};
