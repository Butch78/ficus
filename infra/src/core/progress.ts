/**
 * Progress of a long operation, as it happens: one JSON object per line
 * (NDJSON), for whoever asked with `Accept: application/x-ndjson`.
 *
 * A step line says a step changed state; the last line is the outcome, the
 * status and body the same request would have answered without streaming.
 *
 *     {"kind":"step","step":"import","state":"active","detail":"https://github.com/o/r"}
 *     {"kind":"step","step":"import","state":"complete"}
 *     {"kind":"outcome","status":200,"body":{...}}
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const CONTENT_TYPE = "application/x-ndjson";

export const StepState = Schema.Literals(["active", "complete", "error"]);

export type StepState = typeof StepState.Type;

/** The steps of an init, in the order they can happen. */
export type InitStep =
  /** Ask Artifacts to import the source remote as the root repo. */
  | "import"
  /** Wait for the import to land and read its head commit. */
  | "settle"
  /** No source: read the head of the root repo that was pushed. */
  | "read_head"
  /** No source and no root yet: create an empty root to push to. */
  | "create"
  /** Revoke the root repo's write tokens: it is only ever forked. */
  | "lock"
  /** Store the initialized tree. */
  | "save";

/** The steps of scoring an attempt, in a sandbox, in order. */
export type ScoreStep =
  /** Start the sandbox's container, with the internet off. */
  | "sandbox"
  /** Clone the attempt, through the sandbox's egress. */
  | "clone"
  /** Put the root's locked files (its checks, its devenv) back. */
  | "restore"
  /** Build the root's devenv shell. */
  | "devenv"
  /** Run the root's `[fetch]` (dependencies), with its hosts open. */
  | "fetch"
  /** Run one of the checks (`item`: its name), with no network. */
  | "check"
  /** Measure the change: lines added and removed. */
  | "cost"
  /** Put the root's judges' questions to Clef, after the container is gone. */
  | "judge";

/** A line as written to a stream, newline included. */
export const stepLine = (step: string, state: StepState, item?: string, detail?: string) =>
  // JSON leaves out an absent item or detail.
  `${JSON.stringify({ kind: "step", step, state, item, detail })}\n`;

export const outcomeLine = (status: number, body: Schema.Json) => `${JSON.stringify({ kind: "outcome", status, body })}\n`;

/** A line as read back from a stream, whoever wrote it. */
export const Incoming = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("step"),
    step: Schema.String,
    state: StepState,
    item: Schema.optionalKey(Schema.String),
    detail: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("outcome"), status: Schema.Int, body: Schema.Json }),
]);

export type Incoming = typeof Incoming.Type;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Incoming));

/** A line of a progress stream; `None` for a blank or foreign one. */
export const parseLine = (line: string) => decodeLine(line.trim());

/** One step as it went: when it started and ended, and how. */
export const Entry = Schema.Struct({
  step: Schema.String,
  item: Schema.optional(Schema.String),
  state: StepState,
  detail: Schema.optional(Schema.String),
  /** Milliseconds since the epoch. */
  started_at: Schema.Number,
  ended_at: Schema.optional(Schema.Number),
});

export type Entry = typeof Entry.Type;

/** An operation's steps so far, folded from its stream: one entry per `(step, item)`. */
export const Ledger = Schema.Struct({ entries: Schema.Array(Entry) });

export type Ledger = typeof Ledger.Type;

export const emptyLedger: Ledger = { entries: [] };

/** The ledger with `step` (and `item`) now in `state`, at `now`. */
export const applyStep = (ledger: Ledger, step: string, state: StepState, item: string | undefined, detail: string | undefined, now: number): Ledger => {
  const ended = state === "active" ? undefined : now;
  const index = ledger.entries.findIndex((entry) => entry.step === step && entry.item === item);
  const existing = ledger.entries[index];

  if (existing === undefined) {
    return { entries: [...ledger.entries, { step, item, state, detail, started_at: now, ended_at: ended }] };
  }

  const updated: Entry = { ...existing, state, detail: detail ?? existing.detail, ended_at: ended };

  return { entries: ledger.entries.map((entry, at) => (at === index ? updated : entry)) };
};

/** Steps still marked active become `state`: the stream ended under them. */
export const closeLedger = (ledger: Ledger, state: StepState, now: number): Ledger => ({
  entries: ledger.entries.map((entry) => (entry.state === "active" ? { ...entry, state, ended_at: now } : entry)),
});

/** An outcome's body: the answer's JSON, or its text when it is not JSON. */
export const outcomeBody = (text: string): Schema.Json =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text), () => text);

/** An outcome body as text: a string as it is, anything else as JSON. */
export const textOf = (body: Schema.Json) => (Schema.is(Schema.String)(body) ? body : JSON.stringify(body));
