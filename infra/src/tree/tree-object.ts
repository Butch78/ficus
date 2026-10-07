/**
 * `TreeObject`: one Durable Object per tree, holding the core tree and
 * driving Artifacts as the tree changes.
 *
 * Requests interleave at every await on Artifacts, so each handler changes
 * the tree only between awaits: load, change, save with nothing awaited in
 * between. Where a handler needs Artifacts both before and after a change,
 * it loads the tree again after the await rather than reusing its copy.
 *
 * Storage, key for key as trees already hold it: the tree and each report as
 * JSON text, ledgers, counters and the agents' bookkeeping as values.
 */
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { change, parsePath, parseRef, Subject, view } from "../core/browse.ts";
import { applyStep, closeLedger, CONTENT_TYPE as PROGRESS, emptyLedger, type InitStep, Ledger, outcomeBody, outcomeLine, parseLine, stepLine, type StepState, textOf } from "../core/progress.ts";
import { CheckSpec, RebaseReport, type RebaseRequest, ScoreReport, scoreOf, type ScoreRequest } from "../core/scoring.ts";
import type { DeployParams } from "../core/deploy.ts";
import * as T from "../core/tree.ts";
import { AttemptId, NodeId, Oid, RepoName, TaskId, type TreeError } from "../core/values.ts";
import { ANONYMOUS_HEADER, anonymousMay, isPublic, NO_SUCH_TREE } from "../core/visibility.ts";
import * as Agents from "./agents.ts";
import * as Deploys from "./deploys.ts";
import * as Artifacts from "./artifacts.ts";
import { answerRefused, artifactsRefused, browseRefused, json, refuse, Refused, text, treeRefused } from "./http.ts";
import { committed, diffTrees, listDirectory, readFile } from "./reads.ts";
import { pattern, type Route } from "./routes.ts";
import { scopedName } from "./tenant.ts";

export interface Bindings {
  readonly ARTIFACTS: Artifacts;
  readonly SANDBOX: DurableObjectNamespace;
  readonly AGENTS: DurableObjectNamespace;
  /** The `Deploy` Workflow (src/deploys); absent on a stage that does not deploy. */
  readonly DEPLOYS?: Workflow<DeployParams>;
}

const TREE_KEY = "tree";

/** What `GET /trees/<t>/export` answers: its version, for whatever restores it. */
const EXPORT_FORMAT = "ficus-tree-export/1";

/** Storage keys of agents' assignments (agents.ts), left out of exports. */
const ASSIGNMENT_PREFIX = "assignment:";

/** How long `init` waits for an import before giving up: 30 polls, 2 s apart. */
const IMPORT_POLLS = 30;

const IMPORT_POLL = "2 seconds";

/** Deep enough to find an attempt's base under any sensible amount of work. */
const HISTORY_DEPTH = 1000;

/** What a reader may page through. */
const LOG_PAGE_DEFAULT = 30;

const LOG_PAGE_MAX = 100;

/** The sandbox's read token outlives any scoring run, including a cold devenv. */
const SANDBOX_TOKEN_TTL_SECS = 3600;

/** An attempt whose scoring (or rebase) fails this many times for the sandbox's own reasons is abandoned. */
const SANDBOX_ATTEMPTS = 5;

const SANDBOX_RETRY_MS = 60_000;

const InitBody = Schema.Struct({ source: Schema.optional(Schema.String), branch: Schema.optional(Schema.String) });

const GraftBody = Schema.Struct({ source: Schema.String, branch: Schema.optional(Schema.String) });

const TaskBody = Schema.Struct({ intent: Schema.String, checks: Schema.optional(Schema.Array(CheckSpec)) });

const StartBody = Schema.Struct({ agent: Schema.String });

const AbandonBody = Schema.Struct({ note: Schema.String });

const ReleaseBody = Schema.Struct({ node: Schema.optional(Schema.NullOr(NodeId)) });

const VisibilityBody = Schema.Struct({ public: Schema.Boolean });

/** Everything an agent needs to start working an attempt. */
export const Started = Schema.Struct({
  attempt: AttemptId,
  task: TaskId,
  intent: Schema.String,
  checks: Schema.Array(CheckSpec),
  agent: Schema.String,
  repo: Schema.String,
  remote: Schema.String,
  token: Schema.String,
  base_commit: Schema.String,
  history: Schema.Array(T.HistoryEntry),
});

export type Started = typeof Started.Type;

/** How a sandbox answered. */
type SandboxOutcome<Report> =
  | { readonly kind: "report"; readonly report: Report }
  /** The input cannot be handled (no ficus.toml, head not descending from base, a conflict): retrying will not help. */
  | { readonly kind: "unscorable"; readonly reason: string }
  /** The sandbox, or the way to it, failed: worth another attempt. */
  | { readonly kind: "failed"; readonly reason: string };

/** Where an init's steps go: the caller's stream, or nowhere. */
interface Progress {
  readonly step: (step: InitStep, state: StepState, detail?: string) => void;
}

const silent: Progress = { step: () => undefined };

const decodeBody = <A>(schema: Schema.Decoder<A>, request: Request) =>
  Effect.tryPromise({ try: () => request.json(), catch: () => refuse(400, "the body is not JSON") }).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
    Effect.mapError((error) => (error instanceof Refused ? error : refuse(400, `not the expected body: ${error.message}`))),
  );

const fromTree = <A>(result: Result.Result<A, TreeError>) => Effect.fromResult(result).pipe(Effect.mapError(treeRefused));

const idOf = <A>(schema: Schema.Decoder<A>, raw: string, what: string) =>
  Schema.decodeUnknownEffect(schema)(Number(raw)).pipe(Effect.mapError(() => refuse(400, `${what} id must be a number`)));

/** Apply a scoring or rebase result to an attempt that may have moved on meanwhile: closed or abandoned since is expected, and moot. */
const settle = (tree: T.Tree, attempt: AttemptId, applied: Result.Result<T.Tree, TreeError>) => {
  if (Result.isSuccess(applied)) {
    return applied.success;
  }

  if (applied.failure.kind !== "NotChecking" && applied.failure.kind !== "NotOpen") {
    console.error(`applying the result of attempt ${attempt}: ${applied.failure.message}`);
  }

  return tree;
};

export class TreeObject extends DurableObject<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      this.#route(request).pipe(
        Effect.catchTag("Tree.Refused", (refused) => Effect.succeed(answerRefused(refused))),
        Effect.catchDefect((defect) => Effect.succeed(text(`the tree failed: ${String(defect)}`, 500))),
      ),
    );
  }

  /** Agents first: a submission they report is checked in this alarm. Then rebases, which turn behind attempts into checking ones for the scoring that follows. */
  override async alarm(): Promise<void> {
    await Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* Agents.tend(this.#agentsHost());
        yield* this.#rebaseBehind();
        yield* this.#scoreChecking();
      }),
    );
  }

  readonly #route = Effect.fn("Tree.route")(function* (this: TreeObject, request: Request) {
    const url = new URL(request.url);
    const [first, treeName, kind, id, action] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");

    if (first !== "trees" || treeName === undefined) {
      return yield* refuse(404, "not found");
    }

    const name = yield* scopedName(request, treeName);
    const route: Route = { kind: kind ?? "", id: id ?? "", action: action ?? "" };

    // An anonymous caller (core/visibility.ts) reads a public tree or nothing: anything else is the 404 of a tree that does not exist.
    if (request.headers.has(ANONYMOUS_HEADER) && !(anonymousMay(request.method, url.pathname.slice(`/trees/${treeName}`.length)) && isPublic(yield* this.#load()))) {
      return yield* refuse(404, NO_SUCH_TREE);
    }

    if (request.method === "GET") {
      return yield* this.#get(route, url);
    }

    return request.method === "POST" ? yield* this.#post(route, name, request) : yield* refuse(404, "not found");
  });

  readonly #get = Effect.fn("Tree.get")(function* (this: TreeObject, route: Route, url: URL) {
    const { id, action } = route;

    switch (pattern(route)) {
      case "":
        return yield* this.#show();
      case "behind":
        return yield* this.#showBehind();
      case "release":
        return yield* this.#showRelease();
      case "deploys":
        return json(yield* Deploys.list(this.ctx.storage, this.env.DEPLOYS));
      case "export":
        return yield* this.#export();
      case "attempts/:id":
        return yield* this.#showAttempt(yield* idOf(AttemptId, id, "attempt"));
      case "tasks/:id":
        return yield* this.#showTask(yield* idOf(TaskId, id, "task"));
      case "attempts/:id/agent":
        return yield* Agents.status(this.#agentsHost(), yield* idOf(AttemptId, id, "attempt"));
      case "attempts/:id/:read":
        return yield* this.#read(Subject.Attempt({ id: yield* idOf(AttemptId, id, "attempt") }), action, url);
      case "nodes/:id/:read":
        return yield* this.#read(Subject.Node({ id: yield* idOf(NodeId, id, "node") }), action, url);
      default:
        return yield* refuse(404, "not found");
    }
  });

  readonly #post = Effect.fn("Tree.post")(function* (this: TreeObject, route: Route, name: RepoName, request: Request) {
    const { id } = route;

    switch (pattern(route)) {
      case "init": {
        const body = yield* decodeBody(InitBody, request);

        return request.headers.get("accept")?.includes(PROGRESS) === true ? this.#initStreaming(name, body) : yield* this.#init(name, body, silent);
      }

      case "tasks":
        return yield* this.#task(yield* decodeBody(TaskBody, request));
      case "release":
        return yield* this.#release(yield* decodeBody(ReleaseBody, request));
      case "graft":
        return yield* this.#graft(yield* decodeBody(GraftBody, request));
      case "visibility":
        return yield* this.#visibility(yield* decodeBody(VisibilityBody, request));
      case "accept":
        return yield* this.#accept(undefined);
      case "tasks/:id/attempts":
        return yield* this.#start(yield* idOf(TaskId, id, "task"), yield* decodeBody(StartBody, request));
      case "tasks/:id/accept":
        return yield* this.#accept(yield* idOf(TaskId, id, "task"));
      case "tasks/:id/agents":
        return yield* Agents.start(this.#agentsHost(), name, yield* idOf(TaskId, id, "task"), request);
      case "tasks/:id/close":
        return yield* this.#closeTask(yield* idOf(TaskId, id, "task"), yield* decodeBody(AbandonBody, request));
      case "attempts/:id/submit":
        return yield* this.#submit(yield* idOf(AttemptId, id, "attempt"));
      case "attempts/:id/abandon":
        return yield* this.#abandon(yield* idOf(AttemptId, id, "attempt"), yield* decodeBody(AbandonBody, request));
      case "attempts/:id/retry":
        return yield* this.#retry(yield* idOf(AttemptId, id, "attempt"));
      default:
        return yield* refuse(404, "not found");
    }
  });

  // --- Storage ---

  readonly #load = Effect.fn("Tree.load")(function* (this: TreeObject) {
    const stored = yield* Effect.promise(() => this.ctx.storage.get<string>(TREE_KEY));

    if (stored === undefined) {
      return undefined;
    }

    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(stored).pipe(Effect.orDie);

    return yield* Effect.fromResult(T.decodeTree(parsed)).pipe(Effect.orDie);
  });

  /** The tree, or a 404: most routes have nothing to say about a tree that was never initialized. */
  readonly #tree = Effect.fn("Tree.tree")(function* (this: TreeObject) {
    const tree = yield* this.#load();

    return tree === undefined ? yield* refuse(404, NO_SUCH_TREE) : tree;
  });

  #save(tree: T.Tree) {
    return Effect.promise(() => this.ctx.storage.put(TREE_KEY, JSON.stringify(tree)));
  }

  #alarmNow() {
    return Effect.promise(() => this.ctx.storage.setAlarm(Date.now()));
  }

  readonly #report = Effect.fn("Tree.report")(function* (this: TreeObject, attempt: AttemptId) {
    const stored = yield* Effect.promise(() => this.ctx.storage.get<string>(`report:${attempt}`));

    return stored === undefined ? null : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ScoreReport))(stored).pipe(Effect.orDie);
  });

  /** An attempt's scoring steps so far, if it has been scored or is being scored. */
  readonly #scoring = Effect.fn("Tree.scoring")(function* (this: TreeObject, attempt: AttemptId) {
    const stored = yield* Effect.promise(() => this.ctx.storage.get(`scoring:${attempt}`));

    return stored === undefined ? null : yield* Schema.decodeUnknownEffect(Ledger)(stored).pipe(Effect.orElseSucceed(() => null));
  });

  #artifacts() {
    return this.env.ARTIFACTS;
  }

  /** What agents.ts needs of this object. */
  #agentsHost(): Agents.Host {
    return {
      storage: this.ctx.storage,
      agents: this.env.AGENTS,
      load: this.#load(),
      forkAttempt: (tree, attempt) => this.#forkAttempt(tree, attempt),
      submit: (attempt) => this.#submit(attempt),
      abandon: (attempt, note) => this.#abandon(attempt, { note }),
    };
  }

  // --- Reading ---

  readonly #show = Effect.fn("Tree.show")(function* (this: TreeObject) {
    return json(yield* this.#tree());
  });

  readonly #showBehind = Effect.fn("Tree.showBehind")(function* (this: TreeObject) {
    return json(T.allBehind(yield* this.#tree()));
  });

  readonly #showRelease = Effect.fn("Tree.showRelease")(function* (this: TreeObject) {
    const tree = yield* this.#tree();

    return json({ released: T.released(tree) ?? null, head: T.head(tree) });
  });

  readonly #showAttempt = Effect.fn("Tree.showAttempt")(function* (this: TreeObject, attempt: AttemptId) {
    const tree = yield* this.#tree();
    const entry = T.attempt(tree, attempt);

    if (entry === undefined) {
      return yield* refuse(404, `no attempt ${attempt}`);
    }

    return json({ attempt: entry, report: yield* this.#report(attempt), scoring: yield* this.#scoring(attempt) });
  });

  /** A task and its attempts: where each stands if the task were accepted now, its report and steps, its agent, and the history. */
  readonly #showTask = Effect.fn("Tree.showTask")(function* (this: TreeObject, task: TaskId) {
    const tree = yield* this.#tree();
    const standings = yield* fromTree(T.standings(tree, task));

    const attempts = yield* Effect.forEach(standings, ([id, standing]) =>
      Effect.gen({ self: this }, function* () {
        return {
          attempt: T.attempt(tree, id),
          standing,
          report: yield* this.#report(id),
          scoring: yield* this.#scoring(id),
          agent: (yield* Agents.model(this.ctx.storage, id)) ?? null,
        };
      }),
    );

    return json({ task: T.task(tree, task), head: T.head(tree).id, attempts, history: T.historyOf(tree, task) });
  });

  /**
   * Read the repo behind an attempt or node through Artifacts: `log`, `tree`
   * or `file`, at `?ref=` (default: the commit the subject is pinned to, else
   * its repo's HEAD) and, for `tree` and `file`, `?path=`; or `diff`.
   */
  readonly #read = Effect.fn("Tree.read")(function* (this: TreeObject, subject: Subject, what: string, url: URL) {
    const tree = yield* this.#tree();
    const seen = yield* fromTree(view(tree, subject));
    const asked = url.searchParams.get("ref");
    const ref = asked === null ? seen.pinned : yield* Effect.fromResult(parseRef(asked)).pipe(Effect.mapError(browseRefused));
    const names = yield* Effect.fromResult(parsePath(url.searchParams.get("path") ?? "")).pipe(Effect.mapError(browseRefused));
    const on = yield* Artifacts.repo(this.#artifacts(), seen.repo).pipe(Effect.mapError(artifactsRefused));
    const label = ref ?? "HEAD";

    if (what === "diff") {
      return yield* this.#diff(tree, subject, on);
    }

    if (what === "log") {
      const limit = Math.min(LOG_PAGE_MAX, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || LOG_PAGE_DEFAULT));
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "", 10) || 0;
      const commits = yield* Artifacts.log(on, ref, limit, offset).pipe(Effect.mapError(artifactsRefused));

      return json({ repo: seen.repo, ref: label, commits: commits.map(committed) });
    }

    if (what === "tree" || what === "file") {
      // Resolve the ref once, so the listing and every file read from it describe the same commit.
      const [commit] = yield* Artifacts.log(on, ref, 1).pipe(Effect.mapError(artifactsRefused));

      if (commit === undefined) {
        return yield* refuse(404, `no commit at ${label}`);
      }

      return what === "tree" ? yield* listDirectory(on, seen.repo, commit, names) : yield* readFile(on, commit.hash, names);
    }

    return yield* refuse(404, "not found");
  });

  /** What an attempt changed since the node it started from, or a node since its parent: the changed files and their hunks. */
  readonly #diff = Effect.fn("Tree.diff")(function* (this: TreeObject, tree: T.Tree, subject: Subject, on: ArtifactsRepo) {
    const changed = yield* fromTree(change(tree, subject));

    if (changed.base === undefined) {
      return yield* refuse(400, "the root has no base to compare: browse it instead");
    }

    const base = changed.base;
    const old = yield* Artifacts.readCommit(on, base).pipe(Effect.mapError(artifactsRefused));
    const head = changed.head === undefined ? (yield* Artifacts.log(on, undefined, 1).pipe(Effect.mapError(artifactsRefused)))[0] : yield* Artifacts.readCommit(on, changed.head).pipe(Effect.mapError(artifactsRefused));

    if (head === undefined || head === null) {
      return yield* refuse(404, "no head commit to compare");
    }

    const diff = yield* diffTrees(on, old?.treeHash, head.treeHash).pipe(Effect.mapError(artifactsRefused));

    return json({ repo: changed.repo, base, head: head.hash, files: diff.files, truncated: diff.truncated });
  });

  // --- Init ---

  /** Init, answering at once with its steps as they happen and, last, the answer `init` would have given. */
  #initStreaming(name: RepoName, body: typeof InitBody.Type) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const write = (line: string) => void writer.write(encoder.encode(line));
    const progress: Progress = { step: (step, state, detail) => write(stepLine(step, state, undefined, detail)) };

    const outcome = this.#init(name, body, progress).pipe(
      Effect.catchTag("Tree.Refused", (refused) => Effect.succeed(answerRefused(refused))),
      Effect.catchDefect((defect) => Effect.succeed(text(String(defect), 500))),
      Effect.flatMap((answer) => Effect.promise(async () => outcomeLine(answer.status, outcomeBody(await answer.text())))),
    );

    this.ctx.waitUntil(
      Effect.runPromise(outcome).then(
        (line) => {
          write(line);

          return writer.close();
        },
        (cause) => writer.abort(cause),
      ),
    );

    return new Response(readable, { headers: { "content-type": PROGRESS, "cache-control": "no-store" } });
  }

  /** The head of `name` once its import has landed, or `undefined` if it has not within `IMPORT_POLLS`. */
  readonly #settledHead = Effect.fn("Tree.settledHead")(function* (this: TreeObject, name: string, progress: Progress) {
    for (let poll = 1; poll <= IMPORT_POLLS; poll += 1) {
      const found = yield* Artifacts.repo(this.#artifacts(), name).pipe(Effect.result);

      if (Result.isSuccess(found)) {
        const [head] = yield* Artifacts.log(found.success, undefined, 1).pipe(Effect.mapError(artifactsRefused));

        if (head !== undefined) {
          return yield* Schema.decodeUnknownEffect(Oid)(head.hash).pipe(Effect.mapError(() => refuse(502, `Artifacts gave a malformed commit id: ${head.hash}`)));
        }
      } else if (!Artifacts.isCode(found.failure, "IMPORT_IN_PROGRESS") && !Artifacts.isCode(found.failure, "CREATE_IN_PROGRESS")) {
        return yield* artifactsRefused(found.failure);
      }

      progress.step("settle", "active", `still importing, check ${poll} of ${IMPORT_POLLS}`);
      yield* Effect.sleep(IMPORT_POLL);
    }

    return undefined;
  });

  /** The root's head: imported from `source`, or read from the root repo that was pushed (created empty first). */
  readonly #rootHead = Effect.fn("Tree.rootHead")(function* (this: TreeObject, name: RepoName, body: typeof InitBody.Type, progress: Progress) {
    const failed = (step: InitStep) => (error: Artifacts.ArtifactsError) => {
      progress.step(step, "error", `Artifacts ${error.code}: ${error.message}`);

      return artifactsRefused(error);
    };

    if (body.source !== undefined) {
      progress.step("import", "active", body.source);

      // ALREADY_EXISTS means an earlier init got this far and then timed out: pick up the repo it imported.
      yield* Artifacts.importRepo(this.#artifacts(), body.source, body.branch, name).pipe(
        Effect.asVoid,
        Effect.catchTag("Artifacts.Error", (error) => (Artifacts.isCode(error, "ALREADY_EXISTS") ? Effect.void : Effect.fail(failed("import")(error)))),
      );

      progress.step("import", "complete");
      progress.step("settle", "active");

      const head = yield* this.#settledHead(name, progress);

      if (head === undefined) {
        const late = "import has not finished; init again to pick it up";

        progress.step("settle", "error", late);

        return yield* refuse(504, late);
      }

      progress.step("settle", "complete", head);

      return { head };
    }

    const found = yield* Artifacts.repo(this.#artifacts(), name).pipe(Effect.result);

    if (Result.isFailure(found)) {
      if (!Artifacts.isCode(found.failure, "NOT_FOUND")) {
        return yield* failed("read_head")(found.failure);
      }

      progress.step("create", "active");

      const created = yield* Artifacts.create(this.#artifacts(), name, "ficus root").pipe(Effect.mapError(failed("create")));

      progress.step("create", "complete", created.remote);

      return {
        awaiting: json(
          {
            state: "awaiting root",
            remote: created.remote,
            token: created.token,
            next: 'push the root to `remote` (http.extraHeader="Authorization: Bearer <token>"), then POST init again',
          },
          202,
        ),
      };
    }

    const [latest] = yield* Artifacts.log(found.success, undefined, 1).pipe(Effect.mapError(failed("read_head")));

    if (latest === undefined) {
      return yield* refuse(409, "the root repo is empty: push the root, then init again");
    }

    const head = yield* Schema.decodeUnknownEffect(Oid)(latest.hash).pipe(Effect.mapError(() => refuse(400, `not a git object id: ${latest.hash}`)));

    progress.step("read_head", "complete", head);

    return { head };
  });

  /** Import `source` as the tree's root repo (or use the one pushed) and init the tree on its head, telling `progress` each step. */
  readonly #init = Effect.fn("Tree.init")(function* (this: TreeObject, name: RepoName, body: typeof InitBody.Type, progress: Progress) {
    if ((yield* this.#load()) !== undefined) {
      return yield* refuse(409, "tree already initialized");
    }

    const root = yield* this.#rootHead(name, body, progress);

    if ("awaiting" in root) {
      return root.awaiting;
    }

    progress.step("lock", "active");

    // The root repo is only ever read through forks; nobody pushes to it.
    const locked = yield* Artifacts.repo(this.#artifacts(), name).pipe(Effect.flatMap(Artifacts.revokeActiveTokens), Effect.result);

    if (Result.isFailure(locked)) {
      progress.step("lock", "error", locked.failure.message);

      return yield* artifactsRefused(locked.failure);
    }

    progress.step("lock", "complete");

    if ((yield* this.#load()) !== undefined) {
      return yield* refuse(409, "tree already initialized");
    }

    const tree = yield* fromTree(T.init(name, root.head));

    progress.step("save", "active");
    yield* this.#save(tree);
    progress.step("save", "complete");

    return json(tree);
  });

  // --- Changes ---

  readonly #task = Effect.fn("Tree.task")(function* (this: TreeObject, body: typeof TaskBody.Type) {
    const made = yield* fromTree(T.taskNew(yield* this.#tree(), body.intent, body.checks ?? []));

    yield* this.#save(made.tree);

    return json({ task: made.task });
  });

  /** Record a new attempt, then fork its base node's repo for it. */
  readonly #start = Effect.fn("Tree.start")(function* (this: TreeObject, task: TaskId, body: typeof StartBody.Type) {
    const started = yield* fromTree(T.start(yield* this.#tree(), task, body.agent));

    yield* this.#save(started.tree);

    return json(yield* this.#forkAttempt(started.tree, started.attempt));
  });

  /** Fork the base node's repo for a new attempt: what its agent starts from. A failed fork abandons the attempt so it does not sit working forever. */
  readonly #forkAttempt = Effect.fn("Tree.forkAttempt")(function* (this: TreeObject, tree: T.Tree, attempt: AttemptId) {
    const entry = T.attempt(tree, attempt);
    const base = entry === undefined ? undefined : T.node(tree, entry.base);
    const owner = entry === undefined ? undefined : T.task(tree, entry.task);

    if (entry === undefined || base === undefined || owner === undefined) {
      return yield* Effect.die(new Error(`attempt ${attempt} is not whole in its tree`));
    }

    const forked = yield* Artifacts.repo(this.#artifacts(), base.repo).pipe(
      Effect.flatMap((from) => Artifacts.fork(from, entry.repo, owner.intent)),
      Effect.result,
    );

    if (Result.isFailure(forked)) {
      const latest = yield* this.#load();
      const abandoned = latest === undefined ? undefined : T.abandon(latest, attempt, `fork failed: ${forked.failure.message}`);

      if (abandoned !== undefined && Result.isSuccess(abandoned)) {
        yield* this.#save(abandoned.success);
      }

      return yield* artifactsRefused(forked.failure);
    }

    return Started.make({
      attempt,
      task: entry.task,
      intent: owner.intent,
      checks: owner.checks ?? [],
      agent: entry.agent,
      repo: forked.success.name,
      remote: forked.success.remote,
      token: forked.success.token,
      base_commit: base.commit,
      history: T.historyOf(tree, entry.task),
    });
  });

  /**
   * Freeze the attempt (revoke its tokens), read its head commit from
   * Artifacts, and queue it for the checks. The commit is never taken from
   * the caller, and must descend from the attempt's base.
   */
  readonly #submit = Effect.fn("Tree.submit")(function* (this: TreeObject, attempt: AttemptId) {
    const tree = yield* this.#tree();
    const entry = T.attempt(tree, attempt);

    if (entry === undefined) {
      return yield* refuse(404, `no attempt ${attempt}`);
    }

    const baseCommit = T.node(tree, entry.base)?.commit;
    const on = yield* Artifacts.repo(this.#artifacts(), entry.repo).pipe(Effect.mapError(artifactsRefused));

    yield* Artifacts.revokeActiveTokens(on).pipe(Effect.mapError(artifactsRefused));

    const history = yield* Artifacts.log(on, undefined, HISTORY_DEPTH).pipe(Effect.mapError(artifactsRefused));
    const [latest] = history;

    if (latest === undefined) {
      return yield* refuse(409, "attempt repo has no commits");
    }

    if (latest.hash === baseCommit) {
      return yield* refuse(409, "attempt has no commits beyond its base");
    }

    if (!history.some((commit) => commit.hash === baseCommit)) {
      return yield* refuse(409, "attempt head does not descend from its base commit");
    }

    const head = yield* Schema.decodeUnknownEffect(Oid)(latest.hash).pipe(Effect.mapError(() => refuse(400, `not a git object id: ${latest.hash}`)));
    const submitted = yield* fromTree(T.submit(yield* this.#tree(), attempt, head));

    yield* this.#save(submitted);
    yield* this.#alarmNow();

    return json({ attempt, commit: head, state: "checking" }, 202);
  });

  /** Accept `task`, or the oldest task that is ready. The head moves, so every other submitted attempt is behind: the alarm rebases them. */
  readonly #accept = Effect.fn("Tree.accept")(function* (this: TreeObject, task: TaskId | undefined) {
    const tree = yield* this.#tree();
    const accepted = yield* fromTree(task === undefined ? T.acceptNext(tree) : T.accept(tree, task));
    const { acceptance } = accepted;

    yield* this.#save(accepted.tree);

    if (acceptance.behind.length > 0) {
      yield* this.#alarmNow();
    }

    const revokeFailures = yield* this.#revokeAll(accepted.tree, acceptance.closed);
    const head = T.head(accepted.tree);

    return json({
      task: T.attempt(accepted.tree, acceptance.accepted)?.task,
      node: acceptance.node,
      accepted: acceptance.accepted,
      commit: head.commit,
      repo: head.repo,
      closed: acceptance.closed,
      behind: T.allBehind(accepted.tree),
      revoke_failures: revokeFailures,
    });
  });

  /**
   * Import an outside commit (a mirror's `main`) into its own repo and make
   * it the head. Every open attempt is then behind; the alarm rebases the
   * submitted ones. Grafting the head's own commit again changes nothing.
   */
  readonly #graft = Effect.fn("Tree.graft")(function* (this: TreeObject, body: typeof GraftBody.Type) {
    const reserved = yield* fromTree(T.reserveGraft(yield* this.#tree()));

    // Saved before the import, so nothing started meanwhile takes the id.
    yield* this.#save(reserved.tree);
    yield* Artifacts.importRepo(this.#artifacts(), body.source, body.branch, reserved.repo).pipe(Effect.mapError(artifactsRefused));

    const head = yield* this.#settledHead(reserved.repo, silent);

    if (head === undefined) {
      return yield* refuse(504, `the import into ${reserved.repo} has not finished`);
    }

    // Like the root, a graft is only ever read through forks.
    yield* Artifacts.repo(this.#artifacts(), reserved.repo).pipe(Effect.flatMap(Artifacts.revokeActiveTokens), Effect.mapError(artifactsRefused));

    const tree = yield* this.#tree();

    if (T.head(tree).commit === head) {
      return json({ node: T.head(tree).id, commit: head, grafted: false });
    }

    const source = body.branch === undefined ? body.source : `${body.source}#${body.branch}`;
    const grafted = yield* fromTree(T.graft(tree, reserved.node, head, reserved.repo, source));

    yield* this.#save(grafted);

    const behind = T.allBehind(grafted);

    if (behind.length > 0) {
      yield* this.#alarmNow();
    }

    return json({ node: reserved.node, commit: head, repo: reserved.repo, grafted: true, behind });
  });

  /** Point the release at a node (the head by default). A deployment follows the pointer; moving it back is a rollback. */
  readonly #release = Effect.fn("Tree.release")(function* (this: TreeObject, body: typeof ReleaseBody.Type) {
    const tree = yield* this.#tree();
    const released = yield* fromTree(T.release(tree, body.node ?? T.head(tree).id));
    const node = T.released(released.tree);

    yield* this.#save(released.tree);

    const deploy =
      node === undefined
        ? undefined
        : // The release stands either way: a deploy that did not start is said, not a failed release.
          yield* Deploys.start(this.ctx.storage, this.env.DEPLOYS, { tree: T.name(released.tree), node: node.id, repo: node.repo, commit: node.commit }).pipe(
            Effect.catchTag("Tree.Refused", (refused) => Effect.succeed({ error: refused.message })),
          );

    return json({ release: released.release, commit: node?.commit, repo: node?.repo, deploy: deploy ?? null });
  });

  /** Make the tree public (anyone may read it, core/visibility.ts) or private again. */
  readonly #visibility = Effect.fn("Tree.visibility")(function* (this: TreeObject, body: typeof VisibilityBody.Type) {
    yield* this.#save({ ...(yield* this.#tree()), public: body.public });

    return json({ public: body.public });
  });

  readonly #abandon = Effect.fn("Tree.abandon")(function* (this: TreeObject, attempt: AttemptId, body: typeof AbandonBody.Type) {
    const abandoned = yield* fromTree(T.abandon(yield* this.#tree(), attempt, body.note));

    yield* this.#save(abandoned);

    return json({ attempt, revoke_failures: yield* this.#revokeAll(abandoned, [attempt]) });
  });

  readonly #closeTask = Effect.fn("Tree.closeTask")(function* (this: TreeObject, task: TaskId, body: typeof AbandonBody.Type) {
    yield* this.#save(yield* fromTree(T.closeTask(yield* this.#tree(), task, body.note)));

    return json({ task });
  });

  /** Start a behind attempt again from the head, in a fresh repo; an agent's attempt retries with an agent. */
  readonly #retry = Effect.fn("Tree.retry")(function* (this: TreeObject, behind: AttemptId) {
    const retried = yield* fromTree(T.retry(yield* this.#tree(), behind));

    yield* this.#save(retried.tree);

    const failures = yield* this.#revokeAll(retried.tree, [behind]);

    if (failures.length > 0) {
      return yield* refuse(502, `could not revoke the behind attempt's tokens: ${failures.join("; ")}`);
    }

    const started = yield* this.#forkAttempt(retried.tree, retried.attempt);
    const model = yield* Agents.model(this.ctx.storage, behind);

    if (model === undefined) {
      return json(started);
    }

    yield* Agents.tendStarted(this.ctx.storage, T.name(retried.tree), model, started);
    yield* this.#alarmNow();

    return json({ attempt: retried.attempt, task: started.task, agent: started.agent, remote: started.remote, base_commit: started.base_commit });
  });

  /** Revoke the tokens of each attempt's repo. Failures are returned, not dropped: the tree has moved on, so the caller decides. */
  readonly #revokeAll = Effect.fn("Tree.revokeAll")(function* (this: TreeObject, tree: T.Tree, attempts: ReadonlyArray<AttemptId>) {
    const failures: Array<string> = [];

    for (const attempt of attempts) {
      const repo = T.attempt(tree, attempt)?.repo;

      if (repo === undefined) {
        continue;
      }

      const revoked = yield* Artifacts.repo(this.#artifacts(), repo).pipe(Effect.flatMap(Artifacts.revokeActiveTokens), Effect.result);

      // An attempt whose fork never happened has nothing to revoke.
      if (Result.isFailure(revoked) && !Artifacts.isCode(revoked.failure, "NOT_FOUND")) {
        failures.push(`${repo}: Artifacts ${revoked.failure.code}: ${revoked.failure.message}`);
      }
    }

    return failures;
  });

  /**
   * `GET /trees/<t>/export`: everything the tree keeps, key for key as
   * stored, for backups. Assignments are left out: until an agent has one,
   * it carries the attempt's write token.
   */
  readonly #export = Effect.fn("Tree.export")(function* (this: TreeObject) {
    const tree = yield* this.#load();

    if (tree === undefined) {
      return yield* refuse(404, "no such tree");
    }

    const stored = yield* Effect.promise(() => this.ctx.storage.list());
    const kept = [...stored.entries()].filter(([key]) => !key.startsWith(ASSIGNMENT_PREFIX));

    return json({ format: EXPORT_FORMAT, name: T.name(tree), exported_at: new Date().toISOString(), storage: Object.fromEntries(kept) });
  });

  // --- Sandboxes: scoring and rebasing, from the alarm ---

  /**
   * Ask the sandbox named after `repo` for `action`; 422 means the input is
   * at fault and retrying will not help. With `ledger`, the sandbox streams
   * its steps and each is recorded in that attempt's scoring ledger as it
   * happens, for pages to show live.
   */
  readonly #askSandbox = Effect.fn("Tree.askSandbox")(function* <A>(
    this: TreeObject,
    repo: string,
    action: "score" | "rebase",
    request: ScoreRequest | RebaseRequest,
    report: Schema.Decoder<A>,
    ledger: AttemptId | undefined,
  ) {
    const key = ledger === undefined ? undefined : `scoring:${ledger}`;
    const storage = this.ctx.storage;
    let steps = emptyLedger;

    const answered = yield* Effect.tryPromise({
      try: async () => {
        if (key !== undefined) {
          await storage.put(key, steps);
        }

        const stub = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(repo));
        const headers = new Headers({ "content-type": "application/json" });

        if (key !== undefined) {
          headers.set("accept", PROGRESS);
        }

        const response = await stub.fetch(new Request(`http://sandbox/${action}`, { method: "POST", headers, body: JSON.stringify(request) }));

        if (key === undefined || response.status !== 200 || response.body === null) {
          return { status: response.status, body: outcomeBody(await response.text()) };
        }

        let pending = "";
        let outcome: { readonly status: number; readonly body: Schema.Json } | undefined;

        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          pending += chunk;

          for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
            const line = parseLine(pending.slice(0, end));

            pending = pending.slice(end + 1);

            if (Option.isSome(line) && line.value.kind === "step") {
              steps = applyStep(steps, line.value.step, line.value.state, line.value.item, line.value.detail, Date.now());
              await storage.put(key, steps);
            }

            if (Option.isSome(line) && line.value.kind === "outcome") {
              outcome = { status: line.value.status, body: line.value.body };
            }
          }
        }

        return outcome;
      },
      catch: (cause) => String(cause),
    }).pipe(Effect.result);

    if (key !== undefined) {
      // Whatever was still running when the stream ended did not finish.
      yield* Effect.promise(() => storage.put(key, closeLedger(steps, "error", Date.now())));
    }

    if (Result.isFailure(answered)) {
      return { kind: "failed", reason: answered.failure } satisfies SandboxOutcome<A>;
    }

    const outcome = answered.success;

    if (outcome === undefined) {
      return { kind: "failed", reason: "the sandbox's stream ended without an outcome" } satisfies SandboxOutcome<A>;
    }

    if (outcome.status === 422) {
      return { kind: "unscorable", reason: textOf(outcome.body) } satisfies SandboxOutcome<A>;
    }

    if (outcome.status !== 200) {
      return { kind: "failed", reason: `sandbox answered ${outcome.status}: ${textOf(outcome.body)}` } satisfies SandboxOutcome<A>;
    }

    const decoded = Schema.decodeUnknownResult(report)(outcome.body);

    return Result.isSuccess(decoded)
      ? ({ kind: "report", report: decoded.success } satisfies SandboxOutcome<A>)
      : ({ kind: "failed", reason: `sandbox answered ${action} with an unreadable report: ${decoded.failure.message}` } satisfies SandboxOutcome<A>);
  });

  /** Mint a short-lived read token, ask a sandbox to score, revoke the token. */
  readonly #scoreOne = Effect.fn("Tree.scoreOne")(function* (this: TreeObject, job: T.ScoringJob) {
    const prepared = yield* Artifacts.repo(this.#artifacts(), job.repo).pipe(
      Effect.flatMap((on) => Effect.all({ on: Effect.succeed(on), info: Artifacts.info(on), token: Artifacts.createToken(on, "read", SANDBOX_TOKEN_TTL_SECS) })),
      Effect.result,
    );

    if (Result.isFailure(prepared)) {
      return { kind: "failed", reason: `Artifacts ${prepared.failure.code}: ${prepared.failure.message}` } satisfies SandboxOutcome<ScoreReport>;
    }

    const { on, info, token } = prepared.success;
    const request: ScoreRequest = { remote: info.remote, token: token.plaintext, base: job.base, head: job.head, intent: job.intent, checks: job.checks };
    const scored = yield* this.#askSandbox(job.repo, "score", request, ScoreReport, job.attempt);

    yield* Artifacts.revokeToken(on, token.id).pipe(Effect.catchTag("Artifacts.Error", (error) => Effect.logError(`revoking the scorer's token on ${job.repo}: ${error.message}`)));

    return scored;
  });

  /** Score every attempt waiting for its checks, in parallel, one sandbox per attempt. */
  readonly #scoreChecking = Effect.fn("Tree.scoreChecking")(function* (this: TreeObject) {
    const tree = yield* this.#load();

    if (tree === undefined) {
      return;
    }

    const jobs = T.scoringJobs(tree);

    if (jobs.length === 0) {
      return;
    }

    const outcomes = yield* Effect.forEach(jobs, (job) => this.#scoreOne(job), { concurrency: "unbounded" });

    // Scoring awaited; other requests may have changed the tree since.
    let latest = yield* this.#load();

    if (latest === undefined) {
      return;
    }

    let retry = false;

    for (const [job, outcome] of jobs.map((each, at) => [each, outcomes[at]] as const)) {
      const attemptsKey = `attempts:${job.attempt}`;

      if (outcome?.kind === "report") {
        yield* Effect.promise(() => this.ctx.storage.put(`report:${job.attempt}`, JSON.stringify(outcome.report)));

        const score = scoreOf(outcome.report);

        latest = Result.isSuccess(score)
          ? settle(latest, job.attempt, T.scored(latest, job.attempt, score.success, outcome.report.touched ?? []))
          : settle(latest, job.attempt, T.abandon(latest, job.attempt, `unscorable report: ${score.failure.message}`));
      } else if (outcome?.kind === "unscorable") {
        latest = settle(latest, job.attempt, T.abandon(latest, job.attempt, `unscorable: ${outcome.reason}`));
      } else if (outcome !== undefined) {
        const attempts = ((yield* Effect.promise(() => this.ctx.storage.get<number>(attemptsKey))) ?? 0) + 1;

        if (attempts >= SANDBOX_ATTEMPTS) {
          latest = settle(latest, job.attempt, T.abandon(latest, job.attempt, `scorer failed ${attempts} times; last: ${outcome.reason}`));
        } else {
          yield* Effect.promise(() => this.ctx.storage.put(attemptsKey, attempts));
          retry = true;
        }
      }
    }

    yield* this.#save(latest);

    if (retry) {
      yield* Effect.promise(() => this.ctx.storage.setAlarm(Date.now() + SANDBOX_RETRY_MS));
    }
  });

  /** Fork the head's repo for the fresh attempt, lend the sandbox a read token on the behind one, replay, then revoke both. */
  readonly #rebaseOne = Effect.fn("Tree.rebaseOne")(function* (this: TreeObject, tree: T.Tree, job: T.RebaseJob) {
    const fresh = T.attempt(tree, job.fresh);

    if (fresh === undefined) {
      return { kind: "failed", reason: `no attempt ${job.fresh}` } satisfies SandboxOutcome<RebaseReport>;
    }

    const prepared = yield* Effect.gen({ self: this }, function* () {
      const onto = yield* Artifacts.repo(this.#artifacts(), T.head(tree).repo).pipe(Effect.flatMap((head) => Artifacts.fork(head, fresh.repo, "ficus rebase")));
      const from = yield* Artifacts.repo(this.#artifacts(), job.fromRepo);
      const fromInfo = yield* Artifacts.info(from);
      const fromToken = yield* Artifacts.createToken(from, "read", SANDBOX_TOKEN_TTL_SECS);

      return { onto, from, fromInfo, fromToken };
    }).pipe(Effect.result);

    if (Result.isFailure(prepared)) {
      return { kind: "failed", reason: `Artifacts ${prepared.failure.code}: ${prepared.failure.message}` } satisfies SandboxOutcome<RebaseReport>;
    }

    const { onto, from, fromInfo, fromToken } = prepared.success;

    const request: RebaseRequest = {
      from: fromInfo.remote,
      from_token: fromToken.plaintext,
      from_base: job.fromBase,
      from_head: job.fromHead,
      onto: onto.remote,
      onto_token: onto.token,
      onto_head: job.ontoHead,
      onto_branch: onto.defaultBranch,
    };

    const outcome = yield* this.#askSandbox(fresh.repo, "rebase", request, RebaseReport, undefined);

    yield* Artifacts.revokeToken(from, fromToken.id).pipe(Effect.catchTag("Artifacts.Error", (error) => Effect.logError(`revoking the rebase's token on ${job.fromRepo}: ${error.message}`)));

    // The fresh attempt is frozen from the start: nobody pushes to it.
    yield* Artifacts.repo(this.#artifacts(), fresh.repo).pipe(
      Effect.flatMap(Artifacts.revokeActiveTokens),
      Effect.catchTag("Artifacts.Error", (error) => Effect.logError(`revoking the fresh attempt's tokens on ${fresh.repo}: ${error.message}`)),
    );

    return outcome;
  });

  /**
   * Replay every behind submitted attempt onto the head, in parallel, one
   * sandbox per attempt. One that applies cleanly is scored on the head
   * without its agent; one that conflicts is left for its agent to retry.
   */
  readonly #rebaseBehind = Effect.fn("Tree.rebaseBehind")(function* (this: TreeObject) {
    const tree = yield* this.#load();

    if (tree === undefined) {
      return;
    }

    const started = T.startRebases(tree);

    for (const failure of started.failures) {
      console.error(`starting a rebase: ${failure.message}`);
    }

    if (started.jobs.length === 0) {
      return;
    }

    yield* this.#save(started.tree);

    const outcomes = yield* Effect.forEach(started.jobs, (job) => this.#rebaseOne(started.tree, job), { concurrency: "unbounded" });

    // Rebases awaited; other requests may have changed the tree since.
    let latest = yield* this.#load();

    if (latest === undefined) {
      return;
    }

    let retry = false;

    for (const [job, outcome] of started.jobs.map((each, at) => [each, outcomes[at]] as const)) {
      const attemptsKey = `rebase-attempts:${job.behind}`;

      if (outcome?.kind === "report") {
        latest = settle(latest, job.fresh, T.rebaseDone(latest, job.fresh, outcome.report.commit));
        yield* Effect.promise(() => this.ctx.storage.delete(attemptsKey));
      } else if (outcome?.kind === "unscorable") {
        // The agent's turn: the behind attempt stays, pointing at the abandoned rebase.
        latest = settle(latest, job.fresh, T.rebaseFailed(latest, job.fresh, `rebase: ${outcome.reason}`));
        yield* Effect.promise(() => this.ctx.storage.delete(attemptsKey));
      } else if (outcome !== undefined) {
        const attempts = ((yield* Effect.promise(() => this.ctx.storage.get<number>(attemptsKey))) ?? 0) + 1;
        const note = `rebase attempt ${attempts} failed: ${outcome.reason}`;

        if (attempts >= SANDBOX_ATTEMPTS) {
          latest = settle(latest, job.fresh, T.rebaseFailed(latest, job.fresh, note));
          yield* Effect.promise(() => this.ctx.storage.delete(attemptsKey));
        } else {
          latest = settle(latest, job.fresh, T.rebaseRetry(latest, job.fresh, note));
          yield* Effect.promise(() => this.ctx.storage.put(attemptsKey, attempts));
          retry = true;
        }
      }
    }

    yield* this.#save(latest);

    if (retry) {
      yield* Effect.promise(() => this.ctx.storage.setAlarm(Date.now() + SANDBOX_RETRY_MS));
    }
  });
}
