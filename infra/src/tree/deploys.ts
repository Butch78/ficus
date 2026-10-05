/**
 * A tree's deploys: one `Deploy` Workflow instance (src/deploys) per release,
 * started when the release pointer moves, read back when asked. The tree
 * keeps a record of each (which node, which instance); how one went is the
 * Workflow's to say.
 *
 * A stage without the deploys Worker has no `DEPLOYS` binding: its trees
 * release without deploying.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DeployOutcome, DeployRecord, deployId, type DeployParams } from "../core/deploy.ts";
import { refuse } from "./http.ts";

/** The tree's deploy records, newest last. */
const DEPLOYS_KEY = "deploys";

/** How many deploys the tree has started: the next one's number. */
const DEPLOY_COUNT_KEY = "deploy-count";

/** The most deploy records a tree keeps. */
const MAX_RECORDS = 50;

const Records = Schema.Array(DeployRecord);

const records = Effect.fn("Deploys.records")(function* (storage: DurableObjectStorage) {
  const stored = yield* Effect.promise(() => storage.get(DEPLOYS_KEY));

  return Option.getOrElse(Schema.decodeUnknownOption(Records)(stored), () => []);
});

/** Start deploying a released node; `undefined` when this stage does not deploy. */
export const start = Effect.fn("Deploys.start")(function* (storage: DurableObjectStorage, deploys: Workflow<DeployParams> | undefined, params: DeployParams) {
  if (deploys === undefined) {
    return undefined;
  }

  const n = ((yield* Effect.promise(() => storage.get<number>(DEPLOY_COUNT_KEY))) ?? 0) + 1;
  const record = DeployRecord.make({ id: deployId(params.tree, n), node: params.node, commit: params.commit, started_at: Date.now() });

  // Counted before the instance exists: a retried release takes a fresh id rather than colliding with this one.
  yield* Effect.promise(() => storage.put(DEPLOY_COUNT_KEY, n));
  yield* Effect.tryPromise({
    try: () => deploys.create({ id: record.id, params }),
    catch: (cause) => refuse(502, `could not start the deploy: ${String(cause)}`),
  });

  const kept = yield* records(storage);

  yield* Effect.promise(() => storage.put(DEPLOYS_KEY, [...kept, record].slice(-MAX_RECORDS)));

  return record;
});

/** How one deploy stands: the Workflow's status, and the sandbox's report once there is one. */
const statusOf = Effect.fn("Deploys.statusOf")(function* (deploys: Workflow<DeployParams>, record: DeployRecord) {
  const status = yield* Effect.tryPromise(async () => (await deploys.get(record.id)).status()).pipe(Effect.option);

  if (Option.isNone(status)) {
    return { ...record, status: "unknown" };
  }

  const { status: state, error, output } = status.value;
  const report = Option.getOrUndefined(Schema.decodeUnknownOption(DeployOutcome)(output));

  return { ...record, status: state, report, error: error?.message };
});

/** `GET /trees/<t>/deploys`: every kept deploy, newest first, with how it went. */
export const list = Effect.fn("Deploys.list")(function* (storage: DurableObjectStorage, deploys: Workflow<DeployParams> | undefined) {
  if (deploys === undefined) {
    return { deploys: [], enabled: false };
  }

  const kept = (yield* records(storage)).toReversed();

  return { deploys: yield* Effect.forEach(kept, (record) => statusOf(deploys, record), { concurrency: 5 }), enabled: true };
});
