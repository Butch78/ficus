/**
 * What the Api answers, decoded at the boundary. The tree shapes are
 * ficus-core's serde output (crates/ficus-core/src/tree.rs): enums are
 * externally tagged, so a unit variant is a bare string ("Working") and a
 * struct variant an object with one key ({ "Scored": { ... } }).
 */
import * as Schema from "effect/Schema";

const Id = Schema.Number;

const Oid = Schema.String;

export const Score = Schema.Struct({
  checks_passed: Schema.Number,
  checks_total: Schema.Number,
  cost: Schema.Number,
  /** The judges' mean confidence, in thousandths; null when the root has no judges. */
  confidence: Schema.optional(Schema.NullOr(Schema.Number)),
});

export type Score = typeof Score.Type;

export const CloseReason = Schema.Union([
  Schema.Struct({ Lost: Schema.Struct({ to: Id }) }),
  Schema.Struct({ Retried: Schema.Struct({ into: Id }) }),
  Schema.Struct({ Rebased: Schema.Struct({ into: Id }) }),
  Schema.Struct({ Abandoned: Schema.Struct({ note: Schema.String }) }),
]);

export type CloseReason = typeof CloseReason.Type;

export const AttemptState = Schema.Union([
  Schema.Literal("Working"),
  Schema.Struct({ Checking: Schema.Struct({ commit: Oid }) }),
  Schema.Struct({ Scored: Schema.Struct({ commit: Oid, score: Score }) }),
  Schema.Struct({ Accepted: Schema.Struct({ node: Id }) }),
  Schema.Struct({ Closed: Schema.Struct({ reason: CloseReason }) }),
]);

export type AttemptState = typeof AttemptState.Type;

export const Attempt = Schema.Struct({
  id: Id,
  task: Id,
  agent: Schema.String,
  base: Id,
  repo: Schema.String,
  state: AttemptState,
  /** Paths it changed against its base, once scored. */
  touched: Schema.optional(Schema.Array(Schema.String)),
  /** The fresh attempt a rebase of this one is in flight into. */
  rebase: Schema.optional(Schema.NullOr(Id)),
  /** The behind attempt this one is a rebase of. */
  rebase_of: Schema.optional(Schema.NullOr(Id)),
});

export type Attempt = typeof Attempt.Type;

export const TaskState = Schema.Union([
  Schema.Literal("Open"),
  Schema.Struct({ Done: Schema.Struct({ attempt: Id, node: Id }) }),
]);

/** A task's own check (ficus-core `CheckSpec`): run after the root's. */
export const TaskCheck = Schema.Struct({ name: Schema.String, run: Schema.String, timeout_secs: Schema.optional(Schema.NullOr(Schema.Number)) });

export const Task = Schema.Struct({
  id: Id,
  intent: Schema.String,
  state: TaskState,
  checks: Schema.optional(Schema.Array(TaskCheck)),
  retries: Schema.optional(Schema.Number),
});

export type Task = typeof Task.Type;

export const TreeNode = Schema.Struct({
  id: Id,
  parent: Schema.NullOr(Id),
  commit: Oid,
  repo: Schema.String,
  accepted_from: Schema.NullOr(Id),
  touched: Schema.optional(Schema.Array(Schema.String)),
});

export type TreeNode = typeof TreeNode.Type;

export const HistoryEntry = Schema.Struct({
  attempt: Id,
  task: Id,
  agent: Schema.String,
  reason: CloseReason,
  score: Schema.NullOr(Score),
});

export type HistoryEntry = typeof HistoryEntry.Type;

/** `GET /v1/orgs/<org>/trees/<tree>`. Maps are keyed by the id as text. */
export const Tree = Schema.Struct({
  name: Schema.String,
  head: Id,
  nodes: Schema.Record(Schema.String, TreeNode),
  tasks: Schema.Record(Schema.String, Task),
  attempts: Schema.Record(Schema.String, Attempt),
  history: Schema.Array(HistoryEntry),
  /** The node a deployment follows; null until the first release. */
  released: Schema.optional(Schema.NullOr(Id)),
});

export type Tree = typeof Tree.Type;

export const CheckOutcome = Schema.Struct({
  name: Schema.String,
  /** The root's `ficus.toml` check, or the task's own. */
  origin: Schema.optional(Schema.Literals(["root", "task"])),
  passed: Schema.Boolean,
  millis: Schema.Number,
  tail: Schema.String,
  /** A judge's probability of yes, in thousandths; absent for a command. */
  confidence: Schema.optional(Schema.Number),
});

/** ficus-core `Ledger`: an operation's steps as they went (an attempt's scoring). */
export const Ledger = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      step: Schema.String,
      item: Schema.optional(Schema.String),
      state: Schema.Literals(["active", "complete", "error"]),
      detail: Schema.optional(Schema.String),
      started_at: Schema.Number,
      ended_at: Schema.optional(Schema.Number),
    }),
  ),
});

export type Ledger = typeof Ledger.Type;

/** `GET .../attempts/<attempt>`: the attempt and, once scored, its report. */
export const AttemptDetail = Schema.Struct({
  attempt: Attempt,
  report: Schema.NullOr(Schema.Struct({ checks: Schema.Array(CheckOutcome), cost: Schema.Number })),
  /** Its scoring steps, live while its checks run; absent for an attempt never scored. */
  scoring: Schema.optional(Schema.NullOr(Ledger)),
});

const Person = Schema.Struct({ name: Schema.String, email: Schema.String });

export const Commit = Schema.Struct({
  hash: Oid,
  tree_hash: Oid,
  message: Schema.String,
  author: Person,
  committer: Person,
  parents: Schema.Array(Oid),
  authored_at: Schema.Number,
  committed_at: Schema.Number,
});

export type Commit = typeof Commit.Type;

/** `GET .../{attempts,nodes}/<id>/log`. */
export const Log = Schema.Struct({ repo: Schema.String, ref: Schema.String, commits: Schema.Array(Commit) });

export const TreeEntry = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  hash: Oid,
  type: Schema.String,
});

export type TreeEntry = typeof TreeEntry.Type;

/** `GET .../{attempts,nodes}/<id>/tree?path=`. */
export const Directory = Schema.Struct({
  repo: Schema.String,
  commit: Commit,
  path: Schema.String,
  entries: Schema.Array(TreeEntry),
});

export type Directory = typeof Directory.Type;

/** `GET /v1/orgs/<org>/trees`. */
export const Trees = Schema.Struct({
  trees: Schema.Array(Schema.Struct({ name: Schema.String, createdAt: Schema.Number })),
});

/** Better Auth's `GET /api/auth/organization/list`, the fields the UI shows. */
export const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }));

/** Better Auth's `GET /api/auth/get-session`: null when signed out. */
export const Session = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }) }),
);

/** ficus-core `Standing`: where an attempt stands if its task were accepted now. */
export const Standing = Schema.Union([
  Schema.Literals(["Best", "Behind", "Working", "Checking"]),
  Schema.Struct({ Outscored: Schema.Struct({ by: Id }) }),
  Schema.Struct({ Failing: Schema.Struct({ checks_passed: Schema.Number, checks_total: Schema.Number }) }),
  Schema.Struct({ Accepted: Schema.Struct({ node: Id }) }),
  Schema.Struct({ Closed: Schema.Struct({ reason: CloseReason }) }),
]);

export type Standing = typeof Standing.Type;

const Report = Schema.Struct({
  checks: Schema.Array(CheckOutcome),
  cost: Schema.Number,
  touched: Schema.optional(Schema.Array(Schema.String)),
});

export type Report = typeof Report.Type;

/** `GET .../tasks/<task>`: the race. */
export const TaskRace = Schema.Struct({
  task: Task,
  head: Id,
  attempts: Schema.Array(
    Schema.Struct({
      attempt: Attempt,
      standing: Standing,
      report: Schema.NullOr(Report),
      scoring: Schema.optional(Schema.NullOr(Ledger)),
      /** The model of the agent working it; null for an attempt a person works. */
      agent: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  history: Schema.Array(HistoryEntry),
});

export type TaskRace = typeof TaskRace.Type;

const DiffLine = Schema.Struct({ kind: Schema.Literals(["context", "added", "removed"]), text: Schema.String });

const Hunk = Schema.Struct({
  old_start: Schema.Number,
  old_lines: Schema.Number,
  new_start: Schema.Number,
  new_lines: Schema.Number,
  lines: Schema.Array(DiffLine),
});

export type Hunk = typeof Hunk.Type;

export const FileDiff = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["added", "removed", "modified"]),
  content: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("text"),
      additions: Schema.Number,
      deletions: Schema.Number,
      hunks: Schema.Array(Hunk),
    }),
    Schema.Struct({ kind: Schema.Literals(["binary", "too_large"]) }),
  ]),
});

export type FileDiff = typeof FileDiff.Type;

/** `GET .../{attempts,nodes}/<id>/diff`. */
export const Diff = Schema.Struct({
  repo: Schema.String,
  base: Schema.String,
  head: Schema.String,
  files: Schema.Array(FileDiff),
  truncated: Schema.Boolean,
});

export type Diff = typeof Diff.Type;

/** `POST .../tasks`. */
export const TaskCreated = Schema.Struct({ task: Id });

/** `POST .../tasks/<task>/accept`. */
export const Acceptance = Schema.Struct({ accepted: Id, node: Id });

/**
 * `POST .../tasks/<task>/attempts` and `.../retry`: an attempt to push to,
 * with its write token. An agent's retry has no token: the agent holds it.
 */
export const Started = Schema.Struct({
  attempt: Id,
  task: Id,
  agent: Schema.String,
  remote: Schema.String,
  token: Schema.optional(Schema.String),
  base_commit: Schema.String,
});

export type Started = typeof Started.Type;

/** `GET .../attempts/<attempt>/agent`: the agent working it (src/agents/actor.ts `#status`). */
export const AgentStatus = Schema.Struct({
  state: Schema.Literals(["working", "submitted", "stopped", "failed", "unassigned"]),
  reason: Schema.optional(Schema.String),
  /** `scout` reads and plans; `change` makes the change and submits it. */
  phase: Schema.optional(Schema.Literals(["scout", "change"])),
  model: Schema.String,
  calls: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tool: Schema.String,
      summary: Schema.String,
      state: Schema.Literals(["running", "ok", "error"]),
    }),
  ),
  lastWords: Schema.optional(Schema.String),
});

export type AgentStatus = typeof AgentStatus.Type;

/** `POST .../tasks/<task>/agents`. */
export const AgentsStarted = Schema.Struct({ attempts: Schema.Array(Id) });
