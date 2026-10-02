/**
 * What the Api answers, decoded at the boundary. The tree shapes are
 * ficus-core's serde output (crates/ficus-core/src/tree.rs): enums are
 * externally tagged, so a unit variant is a bare string ("Growing") and a
 * struct variant an object with one key ({ "Ripe": { ... } }).
 */
import * as Schema from "effect/Schema";

const Id = Schema.Number;

const Oid = Schema.String;

export const Score = Schema.Struct({ checks_passed: Schema.Number, checks_total: Schema.Number, cost: Schema.Number });

export type Score = typeof Score.Type;

export const PruneReason = Schema.Union([
  Schema.Struct({ Outgrown: Schema.Struct({ by: Id }) }),
  Schema.Struct({ Regrown: Schema.Struct({ into: Id }) }),
  Schema.Struct({ Withered: Schema.Struct({ note: Schema.String }) }),
]);

export type PruneReason = typeof PruneReason.Type;

export const LeafState = Schema.Union([
  Schema.Literal("Growing"),
  Schema.Struct({ Ripening: Schema.Struct({ commit: Oid }) }),
  Schema.Struct({ Ripe: Schema.Struct({ commit: Oid, score: Score }) }),
  Schema.Struct({ Fruit: Schema.Struct({ node: Id }) }),
  Schema.Struct({ Pruned: Schema.Struct({ reason: PruneReason }) }),
]);

export type LeafState = typeof LeafState.Type;

export const Leaf = Schema.Struct({
  id: Id,
  bud: Id,
  agent: Schema.String,
  base: Id,
  repo: Schema.String,
  state: LeafState,
});

export type Leaf = typeof Leaf.Type;

export const BudState = Schema.Union([
  Schema.Literal("Open"),
  Schema.Struct({ Fruited: Schema.Struct({ leaf: Id, node: Id }) }),
]);

export const Bud = Schema.Struct({ id: Id, intent: Schema.String, state: BudState });

export type Bud = typeof Bud.Type;

export const TreeNode = Schema.Struct({
  id: Id,
  parent: Schema.NullOr(Id),
  commit: Oid,
  repo: Schema.String,
  fruit_of: Schema.NullOr(Id),
});

export type TreeNode = typeof TreeNode.Type;

export const Compost = Schema.Struct({
  leaf: Id,
  bud: Id,
  agent: Schema.String,
  reason: PruneReason,
  score: Schema.NullOr(Score),
});

export type Compost = typeof Compost.Type;

/** `GET /v1/orgs/<org>/trees/<tree>`. Maps are keyed by the id as text. */
export const Tree = Schema.Struct({
  name: Schema.String,
  head: Id,
  nodes: Schema.Record(Schema.String, TreeNode),
  buds: Schema.Record(Schema.String, Bud),
  leaves: Schema.Record(Schema.String, Leaf),
  compost: Schema.Array(Compost),
});

export type Tree = typeof Tree.Type;

export const CheckOutcome = Schema.Struct({
  name: Schema.String,
  passed: Schema.Boolean,
  millis: Schema.Number,
  tail: Schema.String,
});

/** ficus-core `Ledger`: an operation's steps as they went (a leaf's scoring). */
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

/** `GET .../leaves/<leaf>`: the leaf and, once scored, its report. */
export const LeafDetail = Schema.Struct({
  leaf: Leaf,
  report: Schema.NullOr(Schema.Struct({ checks: Schema.Array(CheckOutcome), cost: Schema.Number })),
  /** Its scoring steps, live while it ripens; absent for a leaf never scored. */
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

/** `GET .../{leaves,nodes}/<id>/log`. */
export const Log = Schema.Struct({ repo: Schema.String, ref: Schema.String, commits: Schema.Array(Commit) });

export const TreeEntry = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  hash: Oid,
  type: Schema.String,
});

export type TreeEntry = typeof TreeEntry.Type;

/** `GET .../{leaves,nodes}/<id>/tree?path=`. */
export const Directory = Schema.Struct({
  repo: Schema.String,
  commit: Commit,
  path: Schema.String,
  entries: Schema.Array(TreeEntry),
});

export type Directory = typeof Directory.Type;

/** `GET /v1/orgs/<org>/trees`. */
export const PlantedTrees = Schema.Struct({
  trees: Schema.Array(Schema.Struct({ name: Schema.String, plantedAt: Schema.Number })),
});

/** Better Auth's `GET /api/auth/organization/list`, the fields the UI shows. */
export const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }));

/** Better Auth's `GET /api/auth/get-session`: null when signed out. */
export const Session = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }) }),
);

/** ficus-core `Standing`: where a leaf stands if its bud were harvested now. */
export const Standing = Schema.Union([
  Schema.Literals(["Winner", "Stale", "Growing", "Ripening"]),
  Schema.Struct({ Outscored: Schema.Struct({ by: Id }) }),
  Schema.Struct({ Failing: Schema.Struct({ checks_passed: Schema.Number, checks_total: Schema.Number }) }),
  Schema.Struct({ Fruit: Schema.Struct({ node: Id }) }),
  Schema.Struct({ Pruned: Schema.Struct({ reason: PruneReason }) }),
]);

export type Standing = typeof Standing.Type;

const Report = Schema.Struct({ checks: Schema.Array(CheckOutcome), cost: Schema.Number });

export type Report = typeof Report.Type;

/** `GET .../buds/<bud>`: the race. */
export const BudRace = Schema.Struct({
  bud: Bud,
  head: Id,
  leaves: Schema.Array(
    Schema.Struct({
      leaf: Leaf,
      standing: Standing,
      report: Schema.NullOr(Report),
      scoring: Schema.optional(Schema.NullOr(Ledger)),
      /** The model of the agent growing it; null for a leaf a person grows. */
      agent: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  compost: Schema.Array(Compost),
});

export type BudRace = typeof BudRace.Type;

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

/** `GET .../{leaves,nodes}/<id>/diff`. */
export const Diff = Schema.Struct({
  repo: Schema.String,
  base: Schema.String,
  head: Schema.String,
  files: Schema.Array(FileDiff),
  truncated: Schema.Boolean,
});

export type Diff = typeof Diff.Type;

/** `POST .../buds`. */
export const BudCreated = Schema.Struct({ bud: Id });

/** `POST .../buds/<bud>/harvest`. */
export const Harvested = Schema.Struct({ fruit: Id, node: Id });


/** `POST .../buds/<bud>/leaves` and `.../regrow`: a leaf to push to, with its write token. */
export const Growing = Schema.Struct({
  leaf: Id,
  bud: Id,
  agent: Schema.String,
  remote: Schema.String,
  token: Schema.String,
  base_commit: Schema.String,
});

export type Growing = typeof Growing.Type;

/** `GET .../leaves/<leaf>/agent`: the agent growing it (src/agents/actor.ts `#status`). */
export const AgentStatus = Schema.Struct({
  state: Schema.Literals(["working", "submitted", "stopped", "failed", "unassigned"]),
  reason: Schema.optional(Schema.String),
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

/** `POST .../buds/<bud>/grow`. */
export const Grown = Schema.Struct({ leaves: Schema.Array(Id) });
