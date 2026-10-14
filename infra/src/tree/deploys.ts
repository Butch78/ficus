/**
 * A tree's deploys: one `Deploy` Workflow instance (src/deploys) per release,
 * started when the release pointer moves, read back when asked. The tree
 * keeps a record of each (which node, which instance); how one went is the
 * Workflow's to say.
 *
 * A stage without the deploys Worker has no `DEPLOYS` binding: its trees
 * release without deploying.
 *
 * Nothing calls the tree back, so it watches: while a deploy is going, the
 * tree's alarm reads the list again every `WATCH_MS`, as `GET .../deploys`
 * does. When the newest deploy's canary failed, the tree rolls the release
 * back (core/deploy.ts `automaticRollback`), claiming it in storage first so
 * it happens once however many readers saw it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { automaticRollback, DeployEnding, DeployOutcome, DeployRecord, deployId, ending, RolledBack, type DeployParams } from "../core/deploy.ts";
import type { NodeId } from "../core/values.ts";
import { refuse } from "./http.ts";

/** The tree's deploy records, newest last. */
const DEPLOYS_KEY = "deploys";

/** How many deploys the tree has started: the next one's number. */
const DEPLOY_COUNT_KEY = "deploy-count";

/** Where a finished deploy's ending is kept, so reading it back never asks the Workflow again. */
const endingKey = (id: string) => `deploy-ending:${id}`;

/** Where a deploy's automatic rollback is kept: claimed before the release moves, so it happens once. */
const rollbackKey = (id: string) => `deploy-rollback:${id}`;

/** How often the tree's alarm reads a going deploy's status. */
const WATCH_MS = 60_000;

/** How long after it started a deploy is watched: past the Workflow's step timeouts and retries, and the canary. */
const WATCH_FOR_MS = 6 * 60 * 60 * 1000;

/** The most deploy records a tree keeps. */
const MAX_RECORDS = 50;

const Records = Schema.Array(DeployRecord);

const records = Effect.fn("Deploys.records")(function* (storage: DurableObjectStorage) {
  const stored = yield* Effect.promise(() => storage.get(DEPLOYS_KEY));

  return Option.getOrElse(Schema.decodeUnknownOption(Records)(stored), () => []);
});

/** Set the alarm within `WATCH_MS`, unless it is due sooner. */
const wake = Effect.fn("Deploys.wake")(function* (storage: DurableObjectStorage) {
  const due = Date.now() + WATCH_MS;
  const set = yield* Effect.promise(() => storage.getAlarm());

  if (set === null || set > due) {
    yield* Effect.promise(() => storage.setAlarm(due));
  }
});

/** What the release that starts a deploy says of it: the node released before, and whether it moved back. */
export type ReleaseNote = Pick<DeployRecord, "previous" | "rollback" | "rollback_of">;

/** Start deploying a released node; `undefined` when this stage does not deploy. */
export const start = Effect.fn("Deploys.start")(function* (
  storage: DurableObjectStorage,
  deploys: Workflow<DeployParams> | undefined,
  params: DeployParams,
  note: ReleaseNote,
) {
  if (deploys === undefined) {
    return undefined;
  }

  const n = ((yield* Effect.promise(() => storage.get<number>(DEPLOY_COUNT_KEY))) ?? 0) + 1;
  const record = DeployRecord.make({ id: deployId(params.tree, n), node: params.node, commit: params.commit, started_at: Date.now(), ...note });

  // Counted before the instance exists: a retried release takes a fresh id rather than colliding with this one.
  yield* Effect.promise(() => storage.put(DEPLOY_COUNT_KEY, n));
  yield* Effect.tryPromise({
    try: () => deploys.create({ id: record.id, params }),
    catch: (cause) => refuse(502, `could not start the deploy: ${String(cause)}`),
  });

  const kept = yield* records(storage);

  yield* Effect.promise(() => storage.put(DEPLOYS_KEY, [...kept, record].slice(-MAX_RECORDS)));
  yield* wake(storage);

  return record;
});

/** A deploy as the list answers it: its record, the Workflow's status and report, and any automatic rollback. */
export type Deploy = DeployRecord & {
  readonly status: string;
  readonly report?: DeployOutcome | undefined;
  readonly error?: string | undefined;
  readonly rolled_back?: RolledBack | undefined;
};

/** How one deploy stands: the Workflow's status, and the sandbox's report once there is one; kept once it has ended. */
const statusOf = Effect.fn("Deploys.statusOf")(function* (storage: DurableObjectStorage, deploys: Workflow<DeployParams>, record: DeployRecord): Effect.fn.Return<Deploy> {
  const status = yield* Effect.tryPromise(async () => (await deploys.get(record.id)).status()).pipe(Effect.option);

  if (Option.isNone(status)) {
    return { ...record, status: "unknown" };
  }

  const { status: state, error, output } = status.value;
  const report = Option.getOrUndefined(Schema.decodeUnknownOption(DeployOutcome)(output));
  const ended = ending(state, report, error?.message);

  if (ended !== undefined) {
    yield* Effect.promise(() => storage.put(endingKey(record.id), ended));
  }

  return { ...record, status: state, report, error: error?.message };
});

const decodeEnding = Schema.decodeUnknownOption(DeployEnding);

const decodeRolledBack = Schema.decodeUnknownOption(RolledBack);

/**
 * `GET /trees/<t>/deploys`: every kept deploy, newest first, with how it went.
 * A deploy that has ended reads from storage; only those still going ask their
 * Workflow, so the list stays quick as the tree releases.
 */
export const list = Effect.fn("Deploys.list")(function* (storage: DurableObjectStorage, deploys: Workflow<DeployParams> | undefined) {
  if (deploys === undefined) {
    return { deploys: [], enabled: false };
  }

  const kept = (yield* records(storage)).toReversed();
  const stored = yield* Effect.promise(() => storage.get(kept.flatMap((record) => [endingKey(record.id), rollbackKey(record.id)])));

  const read = (record: DeployRecord): Effect.Effect<Deploy> =>
    Option.match(decodeEnding(stored.get(endingKey(record.id))), {
      onNone: () => statusOf(storage, deploys, record),
      onSome: (ended): Effect.Effect<Deploy> => Effect.succeed({ ...record, ...ended }),
    }).pipe(Effect.map((deploy) => ({ ...deploy, rolled_back: Option.getOrUndefined(decodeRolledBack(stored.get(rollbackKey(record.id)))) })));

  return { deploys: yield* Effect.forEach(kept, read, { concurrency: 5 }), enabled: true };
});

export type Listed = Effect.Success<ReturnType<typeof list>>;

/**
 * The automatic rollback the newest deploy calls for, if any, claimed in
 * storage before it is answered: a second reader (the alarm and a page at
 * once) finds the claim and leaves it. The caller moves the release, then
 * `settleRollback`s what came of it.
 */
export const claimRollback = Effect.fn("Deploys.claimRollback")(function* (storage: DurableObjectStorage, listed: Listed, released: NodeId | null) {
  const newest = listed.deploys[0];
  const rollback = newest === undefined ? undefined : automaticRollback(newest, released);

  if (newest === undefined || rollback === undefined) {
    return undefined;
  }

  // Storage alone between this read and the write: no other request runs in between.
  if ((yield* Effect.promise(() => storage.get(rollbackKey(newest.id)))) !== undefined) {
    return undefined;
  }

  yield* Effect.promise(() => storage.put(rollbackKey(newest.id), RolledBack.make(rollback)));

  return { deploy: newest.id, ...rollback };
});

/** Keep what the rollback of `deploy` came to: the deploy it started, or why the release did not move. */
export const settleRollback = Effect.fn("Deploys.settleRollback")(function* (storage: DurableObjectStorage, deploy: string, rolledBack: RolledBack) {
  yield* Effect.promise(() => storage.put(rollbackKey(deploy), rolledBack));
});

/**
 * Have the alarm read the deploys again within `WATCH_MS` while one is
 * going, without postponing an earlier alarm. A deploy whose status the
 * Workflow cannot give is watched only until `WATCH_FOR_MS` after it started.
 */
export const watch = Effect.fn("Deploys.watch")(function* (storage: DurableObjectStorage, listed: Listed) {
  const now = Date.now();
  const going = listed.deploys.some((deploy) => ending(deploy.status, undefined, undefined) === undefined && now - deploy.started_at < WATCH_FOR_MS);

  if (going) {
    yield* wake(storage);
  }
});
