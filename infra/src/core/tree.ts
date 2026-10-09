/**
 * The Ficus tree: work grows outward from an accepted node and never merges
 * back.
 *
 * A **task** is stated as intent rather than as a diff. Agents start competing
 * **attempts** at a task, each from the current head node. A scored attempt
 * carries a commit and the score the root's checks gave it. **Accepting** a
 * task turns its best passing attempt into a new node that becomes the head;
 * the task's other attempts are closed.
 *
 * There is no merge. An attempt of another task that started from an older
 * node is *behind*: its commit was never checked against the new head. A
 * behind attempt with a commit is first **rebased**: the machine replays its
 * commits onto the head in a fresh attempt and the checks run again there.
 * Only when the replay conflicts is the attempt **retried**: its agent starts
 * again from the head, with the history of earlier attempts. After
 * `MAX_RETRIES` retries a task takes no more, and its owner decides.
 *
 * Every closed attempt goes to the **history**: who worked it, why it closed
 * and how it scored, the context later attempts start from. A task says what
 * done means with its own **checks**, run after the root's. Acceptance takes
 * the oldest ready task first, so no task starves. A **release** is a pointer
 * at a node, and a rollback is the pointer moving back. A **graft** is an
 * outside commit (a mirror's `main`) made the head.
 *
 * The tree is a value: the shape `TreeObject` stores, decoded by `Tree`, the
 * same JSON every tree saved so far (legacy.ts reads the older names). Every
 * operation is a pure function that answers the changed tree, or a
 * `TreeError`.
 */
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { renameLegacy } from "./legacy.ts";
import { CheckSpec, type ChecksError, validateChecks } from "./scoring.ts";
import { AttemptId, Id, NodeId, Oid, RepoName, Score, TaskId, TreeError, type TreeErrorKind, U32_MAX } from "./values.ts";

export { AttemptId, judged, makeScore, NodeId, Oid, passes, RepoName, Score, TaskId, TreeError, TreeErrorKind } from "./values.ts";

/** Retries a task takes before it stops competing and its owner decides. Rebases are free. */
export const MAX_RETRIES = 5;

export const Node = Schema.Struct({
  id: NodeId,
  /** `null` only for the root, which was initialized rather than accepted. */
  parent: Schema.NullOr(NodeId),
  commit: Oid,
  /** The repo holding `commit`: the tree's own for the root, the accepted attempt's after it, a graft's own for a graft. */
  repo: RepoName,
  /** The attempt this node was accepted from; `null` for the root and for a graft. */
  accepted_from: Schema.NullOr(AttemptId),
  /** Paths the accepted attempt changed against its parent; empty for the root and a graft. */
  touched: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Where a graft came from (`<remote>` or `<remote>#<branch>`). */
  grafted_from: Schema.optionalKey(Schema.String),
});

export type Node = typeof Node.Type;

export const TaskState = Schema.Union([
  Schema.Literal("Open"),
  Schema.Struct({ Done: Schema.Struct({ attempt: AttemptId, node: NodeId }) }),
  /** Closed by its owner without an accept. */
  Schema.Struct({ Closed: Schema.Struct({ note: Schema.String }) }),
]);

export type TaskState = typeof TaskState.Type;

export const Task = Schema.Struct({
  id: TaskId,
  intent: Schema.String,
  state: TaskState,
  /** What done means for this task, on top of the root's checks; never in the repo. */
  checks: Schema.optionalKey(Schema.Array(CheckSpec)),
  /** Attempts an agent started over from a newer head. */
  retries: Schema.optionalKey(Id),
});

export type Task = typeof Task.Type;

export const CloseReason = Schema.Union([
  /** Another attempt of the same task was accepted. */
  Schema.Struct({ Lost: Schema.Struct({ to: AttemptId }) }),
  /** The head moved past this attempt's base and it was started again. */
  Schema.Struct({ Retried: Schema.Struct({ into: AttemptId }) }),
  /** The head moved past this attempt's base and its commits were replayed onto the head, in `into`. */
  Schema.Struct({ Rebased: Schema.Struct({ into: AttemptId }) }),
  /** The agent gave up, or the tree's owner cut it. */
  Schema.Struct({ Abandoned: Schema.Struct({ note: Schema.String }) }),
]);

export type CloseReason = typeof CloseReason.Type;

export const AttemptState = Schema.Union([
  Schema.Literal("Working"),
  /** Submitted at `commit` and frozen; the checks have not run yet. */
  Schema.Struct({ Checking: Schema.Struct({ commit: Oid }) }),
  Schema.Struct({ Scored: Schema.Struct({ commit: Oid, score: Score }) }),
  Schema.Struct({ Accepted: Schema.Struct({ node: NodeId }) }),
  Schema.Struct({ Closed: Schema.Struct({ reason: CloseReason }) }),
]);

export type AttemptState = typeof AttemptState.Type;

export const Attempt = Schema.Struct({
  id: AttemptId,
  task: TaskId,
  agent: Schema.String,
  /** The node this attempt started from. */
  base: NodeId,
  /** The attempt's own repo, forked from the base node's. */
  repo: RepoName,
  state: AttemptState,
  /** Paths the attempt changed against its base, known once it is scored. */
  touched: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The fresh attempt a rebase of this one went into, if any. */
  rebase: Schema.optionalKey(Schema.NullOr(AttemptId)),
  /** The behind attempt this one is a rebase of, if any. */
  rebase_of: Schema.optionalKey(Schema.NullOr(AttemptId)),
});

export type Attempt = typeof Attempt.Type;

/** A closed attempt, kept as context for the next attempt at its task. */
export const HistoryEntry = Schema.Struct({
  attempt: AttemptId,
  task: TaskId,
  agent: Schema.String,
  reason: CloseReason,
  /** `null` if the attempt was closed before it scored. */
  score: Schema.NullOr(Score),
});

export type HistoryEntry = typeof HistoryEntry.Type;

/** The tree, as stored. Maps are keyed by the id as text. */
export const Tree = Schema.Struct({
  name: RepoName,
  head: NodeId,
  next_id: Id,
  nodes: Schema.Record(Schema.String, Node),
  tasks: Schema.Record(Schema.String, Task),
  attempts: Schema.Record(Schema.String, Attempt),
  history: Schema.Array(HistoryEntry),
  /** The node a deployment should follow; `null` until the first release. */
  released: Schema.optionalKey(Schema.NullOr(NodeId)),
  /** Whether anyone may read the tree (visibility.ts); absent, as in trees stored before it, is private. */
  public: Schema.optionalKey(Schema.Boolean),
});

export type Tree = typeof Tree.Type;

/** A stored tree, in either vocabulary; old names are read and never written. */
export const decodeTree = (stored: Schema.Json) => Schema.decodeUnknownResult(Tree)(renameLegacy(stored));

/** What an acceptance changed. */
export interface Acceptance {
  readonly node: NodeId;
  readonly accepted: AttemptId;
  /** The task's other attempts, now in the history. */
  readonly closed: ReadonlyArray<AttemptId>;
  /** Other tasks' live attempts whose base is no longer the head. */
  readonly behind: ReadonlyArray<AttemptId>;
}

/** A behind attempt as the head sees it: what it would have to be replayed over. */
export interface Behind {
  readonly attempt: AttemptId;
  /** Nodes between the attempt's base and the head. */
  readonly behind: number;
  /** Paths both the attempt and those nodes changed; empty means the rebase should apply cleanly. */
  readonly overlap: ReadonlyArray<string>;
  /** The fresh attempt a rebase went into, if any. */
  readonly rebase: AttemptId | null;
}

/** What moving the release pointer changed. */
export interface Release {
  readonly node: NodeId;
  readonly previous: NodeId | null;
  /** Whether `node` is older than `previous`. */
  readonly rollback: boolean;
}

/** Where an attempt stands in its task, as of now (`standings`), as the tree Worker answers it. */
export type Standing =
  | "Best"
  | "Behind"
  | "Working"
  | "Checking"
  | { readonly Outscored: { readonly by: AttemptId } }
  | { readonly Failing: { readonly checks_passed: number; readonly checks_total: number } }
  | { readonly Accepted: { readonly node: NodeId } }
  | { readonly Closed: { readonly reason: CloseReason } };

const refuse = (kind: TreeErrorKind, message: string) => Result.fail(new TreeError({ kind, message }));

/** An attempt's state as a tagged value, for exhaustive matching. */
export type Phase = Data.TaggedEnum<{
  Working: {};
  Checking: { readonly commit: Oid };
  Scored: { readonly commit: Oid; readonly score: Score };
  Accepted: { readonly node: NodeId };
  Closed: { readonly reason: CloseReason };
}>;

export const Phase = Data.taggedEnum<Phase>();

export const phase = (state: AttemptState): Phase => {
  if (state === "Working") {
    return Phase.Working();
  }

  if ("Checking" in state) {
    return Phase.Checking(state.Checking);
  }

  if ("Scored" in state) {
    return Phase.Scored(state.Scored);
  }

  if ("Accepted" in state) {
    return Phase.Accepted(state.Accepted);
  }

  return Phase.Closed(state.Closed);
};

/** Whether the attempt can still be accepted or closed: working, checking or scored. */
export const isOpen = (attempt: Attempt) =>
  Phase.$match(phase(attempt.state), {
    Working: () => true,
    Checking: () => true,
    Scored: () => true,
    Accepted: () => false,
    Closed: () => false,
  });

/** The commit a live attempt was submitted at, once it has one. */
export const attemptCommit = (attempt: Attempt): Oid | undefined =>
  Phase.$match(phase(attempt.state), {
    Working: () => undefined,
    Checking: ({ commit }) => commit,
    Scored: ({ commit }) => commit,
    Accepted: () => undefined,
    Closed: () => undefined,
  });

// --- Construction and lookup ---

const longestSuffix = `-a${U32_MAX}`;

/**
 * A tree whose root is `commit`. A tree is named by its root repo; attempt
 * repos are named after it, so the name must leave room for the longest
 * attempt suffix.
 */
export const init = (name: RepoName, commit: Oid): Result.Result<Tree, TreeError> => {
  if (`${name}${longestSuffix}`.length > 63) {
    return refuse("MalformedRepoName", `not an Artifacts repo name with room for attempts: ${JSON.stringify(name)}`);
  }

  const root = NodeId.make(0);

  return Result.succeed({
    name,
    head: root,
    next_id: 1,
    nodes: { [root]: { id: root, parent: null, commit, repo: name, accepted_from: null, touched: [] } },
    tasks: {},
    attempts: {},
    history: [],
    released: null,
  });
};

export const head = (tree: Tree): Node => {
  const node = tree.nodes[tree.head];

  if (node === undefined) {
    throw new Error("a tree's head always names one of its nodes");
  }

  return node;
};

export const node = (tree: Tree, id: NodeId): Node | undefined => tree.nodes[id];

export const task = (tree: Tree, id: TaskId): Task | undefined => tree.tasks[id];

export const attempt = (tree: Tree, id: AttemptId): Attempt | undefined => tree.attempts[id];

const byId = <A extends { readonly id: number }>(values: Iterable<A>) => [...values].sort((one, other) => one.id - other.id);

/** Every attempt, oldest first. */
export const attempts = (tree: Tree): ReadonlyArray<Attempt> => byId(Object.values(tree.attempts));

export const attemptsOf = (tree: Tree, taskId: TaskId): ReadonlyArray<Attempt> => attempts(tree).filter((entry) => entry.task === taskId);

/** Every closed attempt of `task`, oldest first. */
export const historyOf = (tree: Tree, taskId: TaskId): ReadonlyArray<HistoryEntry> => tree.history.filter((entry) => entry.task === taskId);

/** Whether `attempt` is live but started from a node that is no longer the head. */
export const isBehind = (tree: Tree, entry: Attempt) => isOpen(entry) && entry.base !== tree.head;

/** The nodes from the head back to the root, newest first. */
export const trunk = (tree: Tree): ReadonlyArray<Node> => {
  const nodes: Array<Node> = [];

  for (let current: Node | undefined = head(tree); current !== undefined; current = current.parent === null ? undefined : tree.nodes[current.parent]) {
    nodes.push(current);
  }

  return nodes;
};

/** How far behind the head `attempt` is, and where its diff meets what the head gained meanwhile. */
export const behind = (tree: Tree, entry: Attempt): Behind | undefined => {
  if (!isBehind(tree, entry)) {
    return undefined;
  }

  let count = 0;
  const gained = new Set<string>();

  for (const passed of trunk(tree)) {
    if (passed.id === entry.base) {
      break;
    }

    count += 1;

    for (const path of passed.touched ?? []) {
      gained.add(path);
    }
  }

  return {
    attempt: entry.id,
    behind: count,
    overlap: (entry.touched ?? []).filter((path) => gained.has(path)),
    rebase: entry.rebase ?? null,
  };
};

/** Every behind attempt, oldest first. */
export const allBehind = (tree: Tree): ReadonlyArray<Behind> => attempts(tree).flatMap((entry) => behind(tree, entry) ?? []);

/** Open tasks, oldest first. */
export const openTasks = (tree: Tree): ReadonlyArray<Task> => byId(Object.values(tree.tasks)).filter((entry) => entry.state === "Open");

// --- Changes ---

const takeId = (tree: Tree): Result.Result<readonly [number, Tree], TreeError> =>
  tree.next_id >= U32_MAX ? refuse("Full", "the tree has run out of ids") : Result.succeed([tree.next_id, { ...tree, next_id: tree.next_id + 1 }] as const);

const withAttempt = (tree: Tree, entry: Attempt): Tree => ({ ...tree, attempts: { ...tree.attempts, [entry.id]: entry } });

const withTask = (tree: Tree, entry: Task): Tree => ({ ...tree, tasks: { ...tree.tasks, [entry.id]: entry } });

const lookupAttempt = (tree: Tree, id: AttemptId) => {
  const found = tree.attempts[id];

  return found === undefined ? refuse("UnknownAttempt", `no attempt ${id}`) : Result.succeed(found);
};

const openTask = (tree: Tree, id: TaskId) => {
  const found = tree.tasks[id];

  if (found === undefined) {
    return refuse("UnknownTask", `no task ${id}`);
  }

  if (found.state === "Open") {
    return Result.succeed(found);
  }

  return "Done" in found.state ? refuse("TaskDone", `task ${id} is already done`) : refuse("TaskClosed", `task ${id} is closed: ${found.state.Closed.note}`);
};

const checksRefused = (error: ChecksError) => new TreeError({ kind: "TaskChecks", message: `task checks: ${error.message}` });

/** A task with `checks` of its own on top of the root's. */
export const taskNew = (tree: Tree, intent: string, checks: ReadonlyArray<CheckSpec>) =>
  Result.gen(function* () {
    if (intent.trim() === "") {
      return yield* refuse("EmptyIntent", "an intent must say what the task is for");
    }

    yield* validateChecks(checks).pipe(Result.mapError(checksRefused));

    const [raw, taken] = yield* takeId(tree);
    const id = TaskId.make(raw);

    return { tree: withTask(taken, { id, intent, state: "Open", checks: [...checks], retries: 0 }), task: id };
  });

/** Close `task` without accepting it, recording `note`: only once none of its attempts is working, checking, rebasing or scored. */
export const closeTask = (tree: Tree, taskId: TaskId, note: string) =>
  Result.gen(function* () {
    const owner = yield* openTask(tree, taskId);
    const live = attemptsOf(tree, taskId).filter(isOpen);

    if (live.length > 0) {
      return yield* refuse("TaskBusy", `task ${taskId} still has open attempts: ${live.map((entry) => entry.id).join(", ")}`);
    }

    return withTask(tree, { ...owner, state: { Closed: { note } } });
  });

/** Start an attempt at `task` from the current head. */
export const start = (tree: Tree, taskId: TaskId, agent: string) =>
  Result.gen(function* () {
    yield* openTask(tree, taskId);

    const [raw, taken] = yield* takeId(tree);
    const id = AttemptId.make(raw);
    const repo = RepoName.make(`${tree.name}-a${id}`);

    const entry: Attempt = { id, task: taskId, agent, base: tree.head, repo, state: "Working", touched: [], rebase: null, rebase_of: null };

    return { tree: withAttempt(taken, entry), attempt: id };
  });

/**
 * The commit a submit of attempt `id` would freeze: the newest in its repo's
 * `log` (hashes, newest first), which has to be beyond the attempt's base and
 * descend from it. Asked before the attempt's tokens are revoked, so a refused
 * submit leaves its agent able to push and submit again.
 */
export const submittable = (tree: Tree, id: AttemptId, log: ReadonlyArray<string>) =>
  Result.gen(function* () {
    const entry = yield* lookupAttempt(tree, id);

    if (entry.state !== "Working") {
      return yield* refuse("NotWorking", `attempt ${id} is no longer working`);
    }

    const base = node(tree, entry.base)?.commit;
    const [latest] = log;

    if (latest === undefined) {
      return yield* refuse("NothingToSubmit", "attempt repo has no commits");
    }

    if (latest === base) {
      return yield* refuse("NothingToSubmit", "attempt has no commits beyond its base");
    }

    if (base === undefined || !log.includes(base)) {
      return yield* refuse("NothingToSubmit", "attempt head does not descend from its base commit");
    }

    return yield* Schema.decodeUnknownResult(Oid)(latest).pipe(
      Result.mapError(() => new TreeError({ kind: "MalformedOid", message: `not a git object id: ${latest}` })),
    );
  });

/** Record that `attempt` finished working at `commit`. Its checks run next. */
export const submit = (tree: Tree, id: AttemptId, commit: Oid) =>
  Result.gen(function* () {
    const entry = yield* lookupAttempt(tree, id);

    if (entry.state !== "Working") {
      return yield* refuse("NotWorking", `attempt ${id} is no longer working`);
    }

    return withAttempt(tree, { ...entry, state: { Checking: { commit } } });
  });

/** Record how the checks scored a submitted attempt, and the paths it changed against its base. */
export const scored = (tree: Tree, id: AttemptId, score: Score, touched: ReadonlyArray<string>) =>
  Result.gen(function* () {
    const entry = yield* lookupAttempt(tree, id);

    const commit = Phase.$match(phase(entry.state), {
      Working: () => undefined,
      Checking: (checking) => checking.commit,
      Scored: () => undefined,
      Accepted: () => undefined,
      Closed: () => undefined,
    });

    if (commit === undefined) {
      return yield* refuse("NotChecking", `attempt ${id} is not waiting for its checks`);
    }

    return withAttempt(tree, { ...entry, state: { Scored: { commit, score } }, touched: [...touched] });
  });

/** Attempts waiting for their checks, with the commit each was submitted at. */
export const checking = (tree: Tree): ReadonlyArray<{ readonly attempt: Attempt; readonly commit: Oid }> =>
  attempts(tree).flatMap((entry) =>
    Phase.$match(phase(entry.state), {
      Working: () => [],
      Checking: ({ commit }) => [{ attempt: entry, commit }],
      Scored: () => [],
      Accepted: () => [],
      Closed: () => [],
    }),
  );

const close = (tree: Tree, id: AttemptId, reason: CloseReason) =>
  Result.gen(function* () {
    const entry = yield* lookupAttempt(tree, id);

    const score = Phase.$match(phase(entry.state), {
      Working: () => null,
      Checking: () => null,
      Scored: (scoredState) => scoredState.score,
      Accepted: () => undefined,
      Closed: () => undefined,
    });

    if (score === undefined) {
      return yield* refuse("NotOpen", `attempt ${id} is already accepted or closed`);
    }

    const history: HistoryEntry = { attempt: id, task: entry.task, agent: entry.agent, reason, score };

    return { ...withAttempt(tree, { ...entry, state: { Closed: { reason } } }), history: [...tree.history, history] };
  });

/** Cut a live attempt, for example because its agent gave up. */
export const abandon = (tree: Tree, id: AttemptId, note: string) => close(tree, id, { Abandoned: { note } });

/** The fresh attempt `behind` is being rebased into right now. */
const rebaseInFlight = (tree: Tree, entry: Attempt): AttemptId | undefined => {
  const into = entry.rebase ?? undefined;
  const fresh = into === undefined ? undefined : tree.attempts[into];

  return fresh !== undefined && isOpen(fresh) ? into : undefined;
};

/** The checks every rebase and retry make of the attempt behind. */
const behindAndFree = (tree: Tree, id: AttemptId) =>
  Result.gen(function* () {
    const old = yield* lookupAttempt(tree, id);

    if (!isOpen(old)) {
      return yield* refuse("NotOpen", `attempt ${id} is already accepted or closed`);
    }

    if (old.base === tree.head) {
      return yield* refuse("NotBehind", `attempt ${id} started from the head, so there is nothing to retry`);
    }

    const into = rebaseInFlight(tree, old);

    if (into !== undefined) {
      return yield* refuse("Rebasing", `attempt ${id} is already being rebased into ${into}`);
    }

    return old;
  });

/**
 * Start `behind` again from the head: same task, same agent. The old attempt
 * goes to the history, which is what the new one should read first. A task
 * retries at most `MAX_RETRIES` times.
 */
export const retry = (tree: Tree, id: AttemptId) =>
  Result.gen(function* () {
    const old = yield* behindAndFree(tree, id);
    const owner = tree.tasks[old.task];
    const retries = owner?.retries ?? 0;

    if (retries >= MAX_RETRIES) {
      return yield* refuse("TaskExhausted", `task ${old.task} has retried ${retries} times; its owner should split or abandon it`);
    }

    const started = yield* start(tree, old.task, old.agent);
    const closed = yield* close(started.tree, id, { Retried: { into: started.attempt } });
    const counted = owner === undefined ? closed : withTask(closed, { ...owner, retries: retries + 1 });

    return { tree: counted, attempt: started.attempt };
  });

/**
 * Behind attempts with a commit to replay that no rebase has been tried on.
 * A conflicted one keeps pointing at its abandoned rebase, so the machine
 * does not try again: that is the agent's turn.
 */
export const rebaseable = (tree: Tree): ReadonlyArray<Attempt> =>
  attempts(tree).filter((entry) => isBehind(tree, entry) && (entry.rebase ?? null) === null && attemptCommit(entry) !== undefined);

/**
 * Begin replaying `behind`'s commits onto the head: a fresh attempt of the
 * same task and agent, working from the head, that the machine fills.
 */
export const rebaseStart = (tree: Tree, id: AttemptId) =>
  Result.gen(function* () {
    const old = yield* behindAndFree(tree, id);
    const commit = attemptCommit(old);

    if (commit === undefined) {
      return yield* refuse("NothingToRebase", `attempt ${id} has no commit to rebase`);
    }

    const started = yield* start(tree, old.task, old.agent);
    const fresh = yield* lookupAttempt(started.tree, started.attempt);
    const marked = withAttempt(withAttempt(started.tree, { ...fresh, rebase_of: id }), { ...old, rebase: started.attempt });

    return { tree: marked, fresh: started.attempt, commit };
  });

const rebaseSource = (tree: Tree, fresh: AttemptId) =>
  Result.gen(function* () {
    const entry = yield* lookupAttempt(tree, fresh);
    const behindId = entry.rebase_of ?? null;

    if (entry.state !== "Working" || behindId === null) {
      return yield* refuse("NotRebase", `attempt ${fresh} is not a rebase in progress`);
    }

    return { entry, behind: behindId };
  });

/** The replay landed at `commit` in the fresh attempt: submit it for its checks and close the behind one. */
export const rebaseDone = (tree: Tree, fresh: AttemptId, commit: Oid) =>
  Result.gen(function* () {
    const source = yield* rebaseSource(tree, fresh);
    const submitted = yield* submit(tree, fresh, commit);
    const settled = yield* lookupAttempt(submitted, fresh);
    const cleared = withAttempt(submitted, { ...settled, rebase_of: null });
    const old = cleared.attempts[source.behind];

    return old !== undefined && isOpen(old) ? yield* close(cleared, source.behind, { Rebased: { into: fresh } }) : cleared;
  });

/**
 * The replay did not apply: the fresh attempt is abandoned with `note`, and
 * the behind one stays live, still pointing at it, for its agent to retry.
 */
export const rebaseFailed = (tree: Tree, fresh: AttemptId, note: string) =>
  Result.gen(function* () {
    yield* rebaseSource(tree, fresh);

    return yield* close(tree, fresh, { Abandoned: { note } });
  });

/**
 * The replay could not be run (the sandbox's fault, not the attempt's): the
 * fresh attempt is abandoned with `note` and the behind one is offered to
 * the machine again.
 */
export const rebaseRetry = (tree: Tree, fresh: AttemptId, note: string) =>
  Result.gen(function* () {
    const source = yield* rebaseSource(tree, fresh);
    const closed = yield* close(tree, fresh, { Abandoned: { note } });
    const old = closed.attempts[source.behind];

    return old === undefined ? closed : withAttempt(closed, { ...old, rebase: null });
  });

/** Where a deployment should be, if a release has been made. */
export const released = (tree: Tree): Node | undefined => {
  const id = tree.released ?? null;

  return id === null ? undefined : tree.nodes[id];
};

/** Point the release at `node`. Pointing at an older one is a rollback. */
export const release = (tree: Tree, id: NodeId) =>
  Result.gen(function* () {
    if (tree.nodes[id] === undefined) {
      return yield* refuse("UnknownNode", `no node ${id}`);
    }

    const previous = tree.released ?? null;
    const moved: Release = { node: id, previous, rollback: previous !== null && id < previous };

    return { tree: { ...tree, released: id }, release: moved };
  });

/**
 * The attempt `accept` would pick for `task`: scored on the head, passing
 * every check, cheapest; on equal cost the one the judges were surest of,
 * then the earliest.
 */
const bestAttempt = (tree: Tree, taskId: TaskId): Attempt | undefined => {
  const candidates = attemptsOf(tree, taskId).flatMap((entry) =>
    entry.base !== tree.head
      ? []
      : Phase.$match(phase(entry.state), {
          Working: () => [],
          Checking: () => [],
          Scored: ({ score }) => (score.checks_passed === score.checks_total ? [{ entry, score }] : []),
          Accepted: () => [],
          Closed: () => [],
        }),
  );

  const ranked = candidates.sort(
    (one, other) =>
      one.score.cost - other.score.cost || (other.score.confidence ?? 0) - (one.score.confidence ?? 0) || one.entry.id - other.entry.id,
  );

  return ranked[0]?.entry;
};

/** Open tasks with an acceptable attempt, oldest first. */
export const acceptable = (tree: Tree): ReadonlyArray<TaskId> => openTasks(tree).flatMap((entry) => (bestAttempt(tree, entry.id) === undefined ? [] : [entry.id]));

/**
 * Turn the best scored attempt of `task` into a node and move the head onto
 * it. Only attempts that started from the head are candidates: anything
 * older was checked against a tree that no longer exists.
 */
export const accept = (tree: Tree, taskId: TaskId) =>
  Result.gen(function* () {
    const owner = yield* openTask(tree, taskId);
    const best = bestAttempt(tree, taskId);
    const commit = best === undefined ? undefined : attemptCommit(best);

    if (best === undefined || commit === undefined) {
      return yield* refuse("NothingToAccept", `task ${taskId} has no scored attempt on the head that passes every check`);
    }

    const [raw, taken] = yield* takeId(tree);
    const id = NodeId.make(raw);
    const accepted: Node = { id, parent: tree.head, commit, repo: best.repo, accepted_from: best.id, touched: [...(best.touched ?? [])] };

    let changed: Tree = withTask(withAttempt({ ...taken, head: id, nodes: { ...taken.nodes, [id]: accepted } }, { ...best, state: { Accepted: { node: id } } }), {
      ...owner,
      state: { Done: { attempt: best.id, node: id } },
    });

    const siblings = attemptsOf(changed, taskId).filter(isOpen).map((entry) => entry.id);

    for (const sibling of siblings) {
      changed = yield* close(changed, sibling, { Lost: { to: best.id } });
    }

    const acceptance: Acceptance = {
      node: id,
      accepted: best.id,
      closed: siblings,
      behind: attempts(changed).flatMap((entry) => (isBehind(changed, entry) ? [entry.id] : [])),
    };

    return { tree: changed, acceptance };
  });

/** Accept the oldest task that can be, so no task starves. */
export const acceptNext = (tree: Tree) =>
  Result.gen(function* () {
    const next = acceptable(tree)[0];

    if (next === undefined) {
      return yield* refuse("NothingScored", "no task has a scored attempt on the head that passes every check");
    }

    return yield* accept(tree, next);
  });

/**
 * Where each of `task`'s attempts stands if the task were accepted now, in
 * attempt order. The best one is `bestAttempt`'s, so this and `accept`
 * cannot disagree.
 */
export const standings = (tree: Tree, taskId: TaskId) =>
  Result.gen(function* () {
    if (tree.tasks[taskId] === undefined) {
      return yield* refuse("UnknownTask", `no task ${taskId}`);
    }

    const best = bestAttempt(tree, taskId)?.id;

    return attemptsOf(tree, taskId).map((entry): readonly [AttemptId, Standing] => {
      const standing = Phase.$match(phase(entry.state), {
        Accepted: ({ node: accepted }): Standing => ({ Accepted: { node: accepted } }),
        Closed: ({ reason }): Standing => ({ Closed: { reason } }),
        Working: (): Standing => (isBehind(tree, entry) ? "Behind" : "Working"),
        Checking: (): Standing => (isBehind(tree, entry) ? "Behind" : "Checking"),
        Scored: ({ score }): Standing => {
          if (isBehind(tree, entry)) {
            return "Behind";
          }

          if (score.checks_passed !== score.checks_total) {
            return { Failing: { checks_passed: score.checks_passed, checks_total: score.checks_total } };
          }

          return best === undefined || best === entry.id ? "Best" : { Outscored: { by: best } };
        },
      });

      return [entry.id, standing];
    });
  });

/**
 * Take a node id and repo name for an outside commit about to be grafted:
 * the import into `<tree>-g<id>` takes a while, and nothing started
 * meanwhile may take the name.
 */
export const reserveGraft = (tree: Tree) =>
  Result.gen(function* () {
    const [raw, taken] = yield* takeId(tree);

    return { tree: taken, node: NodeId.make(raw), repo: RepoName.make(`${tree.name}-g${raw}`) };
  });

/**
 * Make `commit`, imported into `repo` under a reserved `node`, the new head
 * on top of the current one. Every open attempt is then behind: the machine
 * rebases the submitted ones, as after an acceptance.
 */
export const graft = (tree: Tree, id: NodeId, commit: Oid, repo: RepoName, source: string) =>
  Result.gen(function* () {
    if (id >= tree.next_id || tree.nodes[id] !== undefined) {
      return yield* refuse("NotReserved", `node id ${id} was not reserved for a graft, or is taken`);
    }

    const grafted: Node = { id, parent: tree.head, commit, repo, accepted_from: null, touched: [], grafted_from: source };

    return { ...tree, head: id, nodes: { ...tree.nodes, [id]: grafted } };
  });

export const name = (tree: Tree) => tree.name;

/** An attempt waiting for its checks, with what the sandbox needs to score it. */
export interface ScoringJob {
  readonly attempt: AttemptId;
  readonly repo: RepoName;
  /** The task's intent, for the root's judges. */
  readonly intent: string;
  readonly base: Oid;
  readonly head: Oid;
  readonly checks: ReadonlyArray<CheckSpec>;
}

/** Every attempt waiting for its checks, as a job for a sandbox. */
export const scoringJobs = (tree: Tree): ReadonlyArray<ScoringJob> =>
  checking(tree).flatMap(({ attempt: entry, commit }) => {
    const [owner, base] = [tree.tasks[entry.task], tree.nodes[entry.base]];

    return owner === undefined || base === undefined
      ? []
      : [{ attempt: entry.id, repo: entry.repo, intent: owner.intent, base: base.commit, head: commit, checks: owner.checks ?? [] }];
  });

/** A behind attempt being replayed onto the head in a fresh one. */
export interface RebaseJob {
  readonly behind: AttemptId;
  readonly fresh: AttemptId;
  readonly fromRepo: RepoName;
  readonly fromBase: Oid;
  readonly fromHead: Oid;
  readonly ontoHead: Oid;
}

/** Start a rebase of every rebaseable attempt: the tree with each fresh attempt, the jobs, and any that could not start. */
export const startRebases = (tree: Tree) => {
  let changed = tree;
  const jobs: Array<RebaseJob> = [];
  const failures: Array<TreeError> = [];

  for (const old of rebaseable(tree)) {
    const started = rebaseStart(changed, old.id);
    const base = tree.nodes[old.base];

    if (Result.isFailure(started)) {
      failures.push(started.failure);
    } else if (base !== undefined) {
      changed = started.success.tree;
      jobs.push({ behind: old.id, fresh: started.success.fresh, fromRepo: old.repo, fromBase: base.commit, fromHead: started.success.commit, ontoHead: head(changed).commit });
    }
  }

  return { tree: changed, jobs, failures };
};
