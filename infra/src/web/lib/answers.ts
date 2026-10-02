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

/** `GET .../leaves/<leaf>`: the leaf and, once scored, its report. */
export const LeafDetail = Schema.Struct({
  leaf: Leaf,
  report: Schema.NullOr(Schema.Struct({ checks: Schema.Array(CheckOutcome), cost: Schema.Number })),
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
