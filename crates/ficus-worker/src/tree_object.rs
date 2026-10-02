//! `TreeObject`: one Durable Object per tree, holding the `ficus_core` tree
//! and driving Artifacts as the tree changes.
//!
//! Requests interleave at every await on Artifacts, so each handler changes
//! the tree only between awaits: load, mutate, save with no await in between.
//! Where a handler needs Artifacts both before and after a change, it reloads
//! the tree after the await rather than reusing the copy it read before.

use std::rc::Rc;
use std::time::Duration;

use ficus_core::browse::{FilePath, GitRef, Subject};
use ficus_core::progress::{CONTENT_TYPE as PROGRESS, InitStep, StepState};
use ficus_core::scoring::{CheckSpec, RebaseReport, RebaseRequest, ScoreReport, ScoreRequest};
use ficus_core::tree::{AttemptId, HistoryEntry, NodeId, Oid, RepoName, TaskId, Tree, TreeError};
use futures_util::StreamExt;
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Headers, Method, Request, RequestInit, Response, Result, State,
    durable_object,
};

use crate::artifacts::{ArtifactsError, CommitMetadata, Namespace, Repo, Scope};
use crate::progress::Progress;

const TREE_KEY: &str = "tree";
/// How long `init` waits for an import before giving up: 30 polls, 2s apart.
const IMPORT_POLLS: u32 = 30;
const IMPORT_POLL_MS: u64 = 2000;
/// Deep enough to find a attempt's base under any sensible amount of work.
const HISTORY_DEPTH: u32 = 1000;
/// What a reader may page through, and the largest file it may read.
const LOG_PAGE_DEFAULT: u32 = 30;
const LOG_PAGE_MAX: u32 = 100;
const FILE_MAX_BYTES: u32 = 1024 * 1024;
/// The scorer's read token outlives any scoring run, including a cold devenv.
const SCORER_TOKEN_TTL_SECS: u32 = 3600;
/// A attempt whose scoring fails this many times for the scorer's own reasons
/// is abandoned rather than retried forever. The same goes for a behind attempt
/// whose rebase keeps failing for the sandbox's reasons.
const SCORING_ATTEMPTS: u32 = 5;
const SCORING_RETRY: Duration = Duration::from_secs(60);

#[durable_object]
pub struct TreeObject {
    /// Shared, so work that outlives a request (a streamed init) can hold it.
    state: Rc<State>,
    env: Env,
}

/// `source` imports an HTTPS git remote as the root. Without it, the first
/// call creates an empty root repo and returns a write token to push the root
/// with; the next call initializes the tree on whatever was pushed.
#[derive(Deserialize)]
struct InitBody {
    source: Option<String>,
    branch: Option<String>,
}

/// `intent` says what the task is for; `checks` say when it is done, on top
/// of the root's. They run in the scorer, never from the repo.
#[derive(Deserialize)]
struct TaskBody {
    intent: String,
    #[serde(default)]
    checks: Vec<CheckSpec>,
}

#[derive(Deserialize)]
struct StartBody {
    agent: String,
}

#[derive(Deserialize)]
struct AbandonBody {
    note: String,
}

/// `node` defaults to the head.
#[derive(Deserialize)]
struct ReleaseBody {
    node: Option<NodeId>,
}

/// Everything an agent needs to start working a attempt.
#[derive(Serialize)]
struct Started {
    attempt: AttemptId,
    task: TaskId,
    intent: String,
    checks: Vec<CheckSpec>,
    agent: String,
    repo: String,
    remote: String,
    token: String,
    base_commit: String,
    history: Vec<HistoryEntry>,
}

impl DurableObject for TreeObject {
    fn new(state: State, env: Env) -> Self {
        Self {
            state: Rc::new(state),
            env,
        }
    }

    /// Rebases first: they turn behind attempts into checking ones, which
    /// the scoring that follows picks up in the same alarm.
    async fn alarm(&self) -> Result<Response> {
        self.rebase_behind().await?;
        self.score_checking().await
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let path = req.path();
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        let Some((&"trees", rest)) = segments.split_first() else {
            return Response::error("not found", 404);
        };
        let Some((&tree_name, route)) = rest.split_first() else {
            return Response::error("not found", 404);
        };
        let tenant = match crate::tenant_of(&req)? {
            Ok(tenant) => tenant,
            Err(response) => return Ok(response),
        };
        let name = match RepoName::try_from(tenant.scope(tree_name)) {
            Ok(name) => name,
            Err(error) => return Response::error(error.to_string(), 400),
        };
        match (req.method(), route) {
            (Method::Get, []) => self.show().await,
            (Method::Get, ["behind"]) => self.show_behind().await,
            (Method::Get, ["release"]) => self.show_release().await,
            (Method::Post, ["release"]) => self.release(req.json().await?).await,
            (Method::Get, ["attempts", attempt]) => match attempt.parse() {
                Ok(attempt) => self.show_attempt(attempt).await,
                Err(_) => Response::error("attempt id must be a number", 400),
            },
            (Method::Get, ["attempts", attempt, read]) => match attempt.parse() {
                Ok(attempt) => self.read(Subject::Attempt(attempt), read, &req).await,
                Err(_) => Response::error("attempt id must be a number", 400),
            },
            (Method::Get, ["nodes", node, read]) => match node.parse() {
                Ok(node) => self.read(Subject::Node(node), read, &req).await,
                Err(_) => Response::error("node id must be a number", 400),
            },
            (Method::Post, ["init"]) => {
                let body = req.json().await?;
                if wants_progress(&req)? {
                    self.init_streaming(name, body)
                } else {
                    self.init(name, body, &Progress::silent()).await
                }
            }
            (Method::Post, ["tasks"]) => self.task(req.json().await?).await,
            (Method::Post, ["tasks", task, "attempts"]) => match task.parse() {
                Ok(task) => self.start(task, req.json().await?).await,
                Err(_) => Response::error("task id must be a number", 400),
            },
            (Method::Post, ["accept"]) => self.accept(None).await,
            (Method::Post, ["tasks", task, "accept"]) => match task.parse() {
                Ok(task) => self.accept(Some(task)).await,
                Err(_) => Response::error("task id must be a number", 400),
            },
            (Method::Post, ["attempts", attempt, action]) => match attempt.parse() {
                Ok(attempt) => match *action {
                    "submit" => self.submit(attempt).await,
                    "abandon" => self.abandon(attempt, req.json().await?).await,
                    "retry" => self.retry(attempt).await,
                    _ => Response::error("not found", 404),
                },
                Err(_) => Response::error("attempt id must be a number", 400),
            },
            _ => Response::error("not found", 404),
        }
    }
}

impl TreeObject {
    /// Score every attempt waiting for its checks, in parallel, one scorer
    /// container per attempt. Runs from the alarm `submit` sets.
    async fn score_checking(&self) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::ok("no tree");
        };
        let pending: Vec<Pending> = tree
            .checking()
            .map(|(attempt, head)| Pending {
                attempt: attempt.id,
                repo: attempt.repo.clone(),
                intent: tree
                    .task(attempt.task)
                    .expect("a attempt's task is in its tree")
                    .intent
                    .clone(),
                base: tree
                    .node(attempt.base)
                    .expect("a attempt's base is a node of its tree")
                    .commit
                    .clone(),
                head: head.clone(),
                checks: tree
                    .task(attempt.task)
                    .expect("a attempt's task is in its tree")
                    .checks
                    .clone(),
            })
            .collect();
        if pending.is_empty() {
            return Response::ok("nothing to score");
        }
        let outcomes = join_all(pending.iter().map(|job| self.score_one(job))).await;

        // Scoring awaited; other requests may have changed the tree since.
        let Some(mut tree) = self.load().await? else {
            return Response::ok("no tree");
        };
        let mut retry = false;
        for (job, outcome) in pending.iter().zip(outcomes) {
            let attempts_key = format!("attempts:{}", job.attempt);
            match outcome {
                SandboxOutcome::Report(report) => {
                    self.state
                        .storage()
                        .put(
                            &format!("report:{}", job.attempt),
                            serde_json::to_string(&report)?,
                        )
                        .await?;
                    match report.score() {
                        Ok(score) => settle(
                            job.attempt,
                            tree.scored(job.attempt, score, report.touched.clone()),
                        ),
                        Err(error) => settle(
                            job.attempt,
                            tree.abandon(job.attempt, format!("unscorable report: {error}")),
                        ),
                    }
                }
                SandboxOutcome::Unscorable(reason) => settle(
                    job.attempt,
                    tree.abandon(job.attempt, format!("unscorable: {reason}")),
                ),
                SandboxOutcome::Failed(reason) => {
                    let attempts = self
                        .state
                        .storage()
                        .get::<u32>(&attempts_key)
                        .await?
                        .unwrap_or(0)
                        + 1;
                    if attempts >= SCORING_ATTEMPTS {
                        settle(
                            job.attempt,
                            tree.abandon(
                                job.attempt,
                                format!("scorer failed {attempts} times; last: {reason}"),
                            ),
                        );
                    } else {
                        self.state.storage().put(&attempts_key, attempts).await?;
                        retry = true;
                    }
                }
            }
        }
        self.save(&tree).await?;
        if retry {
            self.state.storage().set_alarm(SCORING_RETRY).await?;
        }
        Response::ok("scored")
    }

    /// Mint a short-lived read token, ask a scorer container, revoke the token.
    async fn score_one(&self, job: &Pending) -> SandboxOutcome {
        let artifacts = match self.artifacts() {
            Ok(artifacts) => artifacts,
            Err(error) => return SandboxOutcome::Failed(error.to_string()),
        };
        let repo = match artifacts.repo(&job.repo).await {
            Ok(repo) => repo,
            Err(error) => return SandboxOutcome::Failed(error.to_string()),
        };
        let (info, token) = match (
            repo.info().await,
            repo.create_token(Scope::Read, SCORER_TOKEN_TTL_SECS).await,
        ) {
            (Ok(info), Ok(token)) => (info, token),
            (Err(error), _) | (_, Err(error)) => return SandboxOutcome::Failed(error.to_string()),
        };
        let request = ScoreRequest {
            remote: info.remote,
            token: token.plaintext,
            base: job.base.clone(),
            head: job.head.clone(),
            intent: job.intent.clone(),
            checks: job.checks.clone(),
        };
        let scored = self.ask_sandbox(&job.repo, "score", &request).await;
        if let Err(error) = repo.revoke_token(&token.id).await {
            worker::console_error!(
                "revoking the scorer's token on {}: {error}",
                job.repo.as_str()
            );
        }
        scored
    }

    /// Replay every behind submitted attempt onto the head, in parallel, one
    /// sandbox per attempt. A attempt that applies cleanly is scored on the head
    /// without its agent; one that conflicts is left for its agent to
    /// retry, with the conflict in the history.
    async fn rebase_behind(&self) -> Result<()> {
        let Some(mut tree) = self.load().await? else {
            return Ok(());
        };
        let behind: Vec<AttemptId> = tree.rebaseable().map(|attempt| attempt.id).collect();
        if behind.is_empty() {
            return Ok(());
        }
        let mut jobs = Vec::with_capacity(behind.len());
        for attempt in behind {
            match tree.rebase_start(attempt) {
                Ok((fresh, commit)) => {
                    let old = tree.attempt(attempt).expect("rebase_start found it");
                    jobs.push(Rebase {
                        behind: attempt,
                        fresh,
                        from_repo: old.repo.clone(),
                        from_base: tree
                            .node(old.base)
                            .expect("a attempt's base is a node of its tree")
                            .commit
                            .clone(),
                        from_head: commit,
                        onto_head: tree.head().commit.clone(),
                    });
                }
                Err(error) => {
                    worker::console_error!("starting rebase of attempt {attempt}: {error}")
                }
            }
        }
        self.save(&tree).await?;

        let outcomes = join_all(jobs.iter().map(|job| self.rebase_one(&tree, job))).await;

        // Rebases awaited; other requests may have changed the tree since.
        let Some(mut tree) = self.load().await? else {
            return Ok(());
        };
        let mut retry = false;
        for (job, outcome) in jobs.iter().zip(outcomes) {
            let attempts_key = format!("rebase-attempts:{}", job.behind);
            match outcome {
                RebaseOutcome::Report(report) => {
                    settle(job.fresh, tree.rebase_done(job.fresh, report.commit));
                    self.state.storage().delete(&attempts_key).await?;
                }
                RebaseOutcome::Conflict(reason) => {
                    // The agent's turn: the behind attempt stays, pointing at
                    // the abandoned rebase, and the alarm attempts it be.
                    settle(
                        job.fresh,
                        tree.rebase_failed(job.fresh, format!("rebase: {reason}")),
                    );
                    self.state.storage().delete(&attempts_key).await?;
                }
                RebaseOutcome::Failed(reason) => {
                    let attempts = self
                        .state
                        .storage()
                        .get::<u32>(&attempts_key)
                        .await?
                        .unwrap_or(0)
                        + 1;
                    let note = format!("rebase attempt {attempts} failed: {reason}");
                    if attempts >= SCORING_ATTEMPTS {
                        settle(job.fresh, tree.rebase_failed(job.fresh, note));
                        self.state.storage().delete(&attempts_key).await?;
                    } else {
                        settle(job.fresh, tree.rebase_retry(job.fresh, note));
                        self.state.storage().put(&attempts_key, attempts).await?;
                        retry = true;
                    }
                }
            }
        }
        self.save(&tree).await?;
        if retry {
            self.state.storage().set_alarm(SCORING_RETRY).await?;
        }
        Ok(())
    }

    /// Fork the head's repo for the fresh attempt, lend the sandbox a read
    /// token on the behind one, replay, then revoke both.
    async fn rebase_one(&self, tree: &Tree, job: &Rebase) -> RebaseOutcome {
        let fresh = tree.attempt(job.fresh).expect("rebase_start created it");
        let artifacts = match self.artifacts() {
            Ok(artifacts) => artifacts,
            Err(error) => return RebaseOutcome::Failed(error.to_string()),
        };
        let forked = match artifacts.repo(&tree.head().repo).await {
            Ok(head_repo) => head_repo.fork(&fresh.repo, "ficus rebase").await,
            Err(error) => Err(error),
        };
        let onto = match forked {
            Ok(created) => created,
            Err(error) => return RebaseOutcome::Failed(format!("fork: {error}")),
        };
        let from_repo = match artifacts.repo(&job.from_repo).await {
            Ok(repo) => repo,
            Err(error) => return RebaseOutcome::Failed(error.to_string()),
        };
        let (from_info, from_token) = match (
            from_repo.info().await,
            from_repo
                .create_token(Scope::Read, SCORER_TOKEN_TTL_SECS)
                .await,
        ) {
            (Ok(info), Ok(token)) => (info, token),
            (Err(error), _) | (_, Err(error)) => return RebaseOutcome::Failed(error.to_string()),
        };
        let request = RebaseRequest {
            from: from_info.remote,
            from_token: from_token.plaintext,
            from_base: job.from_base.clone(),
            from_head: job.from_head.clone(),
            onto: onto.remote,
            onto_token: onto.token,
            onto_head: job.onto_head.clone(),
            onto_branch: onto.default_branch,
        };
        let outcome = match self.ask_sandbox(&fresh.repo, "rebase", &request).await {
            SandboxOutcome::Report(report) => RebaseOutcome::Report(report),
            SandboxOutcome::Unscorable(reason) => RebaseOutcome::Conflict(reason),
            SandboxOutcome::Failed(reason) => RebaseOutcome::Failed(reason),
        };
        if let Err(error) = from_repo.revoke_token(&from_token.id).await {
            worker::console_error!(
                "revoking the rebase's token on {}: {error}",
                job.from_repo.as_str()
            );
        }
        // The fresh attempt is frozen from the start: nobody pushes to it.
        match artifacts.repo(&fresh.repo).await {
            Ok(repo) => {
                if let Err(error) = repo.revoke_active_tokens().await {
                    worker::console_error!(
                        "revoking the fresh attempt's tokens on {}: {error}",
                        fresh.repo.as_str()
                    );
                }
            }
            Err(error) => worker::console_error!("reaching {}: {error}", fresh.repo.as_str()),
        }
        outcome
    }

    /// Ask the sandbox named after `repo` for `action`; 422 means the input
    /// is at fault and retrying will not help.
    async fn ask_sandbox<Req: Serialize, Rep: for<'de> Deserialize<'de>>(
        &self,
        repo: &RepoName,
        action: &str,
        request: &Req,
    ) -> SandboxOutcome<Rep> {
        let attempt = async {
            let stub = self
                .env
                .durable_object("SANDBOX")?
                .get_by_name(repo.as_str())?;
            // axum's Json extractor refuses a body without this (415).
            let headers = Headers::new();
            headers.set("content-type", "application/json")?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post)
                .with_headers(headers)
                .with_body(Some(serde_json::to_string(request)?.into()));
            let mut response = stub
                .fetch_with_request(Request::new_with_init(
                    &format!("http://sandbox/{action}"),
                    &init,
                )?)
                .await?;
            Ok::<_, worker::Error>((response.status_code(), response.text().await?))
        };
        match attempt.await {
            Ok((200, body)) => match serde_json::from_str::<Rep>(&body) {
                Ok(report) => SandboxOutcome::Report(report),
                Err(error) => SandboxOutcome::Failed(format!(
                    "sandbox answered {action} with an unreadable report: {error}"
                )),
            },
            Ok((422, reason)) => SandboxOutcome::Unscorable(reason),
            Ok((status, body)) => {
                SandboxOutcome::Failed(format!("sandbox answered {status}: {body}"))
            }
            Err(error) => SandboxOutcome::Failed(error.to_string()),
        }
    }

    async fn show_behind(&self) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        Response::from_json(&tree.all_behind().collect::<Vec<_>>())
    }

    async fn show_release(&self) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        Response::from_json(&serde_json::json!({
            "released": tree.released(),
            "head": tree.head(),
        }))
    }

    /// Point the release at a node (the head by default). A deployment
    /// follows the pointer; moving it back is a rollback.
    async fn release(&self, body: ReleaseBody) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let node = body.node.unwrap_or(tree.head().id);
        let release = match tree.release(node) {
            Ok(release) => release,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        let released = tree.released().expect("just released");
        Response::from_json(&serde_json::json!({
            "release": release,
            "commit": released.commit.as_str(),
            "repo": released.repo.as_str(),
        }))
    }

    async fn show_attempt(&self, attempt: AttemptId) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let Some(entry) = tree.attempt(attempt) else {
            return tree_error(&TreeError::UnknownAttempt(attempt));
        };
        let report = match self
            .state
            .storage()
            .get::<String>(&format!("report:{attempt}"))
            .await?
        {
            Some(json) => Some(serde_json::from_str::<ScoreReport>(&json)?),
            None => None,
        };
        Response::from_json(&serde_json::json!({ "attempt": entry, "report": report }))
    }

    /// Read the repo behind an attempt or node through Artifacts: `log`, `tree`
    /// or `file`, at `?ref=` (default: the commit the subject is pinned to,
    /// else its repo's HEAD) and, for `tree` and `file`, `?path=`.
    async fn read(&self, subject: Subject, what: &str, req: &Request) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let view = match tree.view(subject) {
            Ok(view) => view,
            Err(error) => return tree_error(&error),
        };
        let query = Query::of(req)?;
        let git_ref = match query.get("ref").map(GitRef::parse).transpose() {
            Ok(Some(git_ref)) => Some(git_ref.as_str().to_owned()),
            Ok(None) => view.pinned.map(String::from),
            Err(error) => return Response::error(error.to_string(), 400),
        };
        let path = match FilePath::parse(query.get("path").unwrap_or_default()) {
            Ok(path) => path,
            Err(error) => return Response::error(error.to_string(), 400),
        };
        let repo = match self.artifacts()?.repo(&view.repo).await {
            Ok(repo) => repo,
            Err(error) => return artifacts_error(&error),
        };
        let at = git_ref.as_deref();
        let label = at.unwrap_or("HEAD");
        match what {
            "log" => {
                let limit = query
                    .number("limit")
                    .unwrap_or(LOG_PAGE_DEFAULT)
                    .clamp(1, LOG_PAGE_MAX);
                let offset = query.number("offset").unwrap_or(0);
                match repo.log(at, limit, offset).await {
                    Ok(commits) => Response::from_json(&serde_json::json!({
                        "repo": view.repo,
                        "ref": label,
                        "commits": commits,
                    })),
                    Err(error) => artifacts_error(&error),
                }
            }
            "tree" | "file" => {
                // Resolve the ref once, so the listing and every file read
                // from it describe the same commit.
                let commit = match repo.log(at, 1, 0).await {
                    Ok(commits) => match commits.into_iter().next() {
                        Some(commit) => commit,
                        None => return Response::error(format!("no commit at {label}"), 404),
                    },
                    Err(error) => return artifacts_error(&error),
                };
                if what == "tree" {
                    list_dir(&repo, &view.repo, commit, &path).await
                } else {
                    read_file(&repo, &commit.hash, &path).await
                }
            }
            _ => Response::error("not found", 404),
        }
    }

    fn artifacts(&self) -> Result<Namespace> {
        self.env.get_binding::<Namespace>("ARTIFACTS")
    }

    async fn load(&self) -> Result<Option<Tree>> {
        match self.state.storage().get::<String>(TREE_KEY).await? {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    async fn save(&self, tree: &Tree) -> Result<()> {
        self.state
            .storage()
            .put(TREE_KEY, serde_json::to_string(tree)?)
            .await
    }

    async fn show(&self) -> Result<Response> {
        match self.load().await? {
            Some(tree) => Response::from_json(&tree),
            None => Response::error("no such tree", 404),
        }
    }

    /// Another handle on this object, for work that outlives the request.
    fn handle(&self) -> Self {
        Self {
            state: Rc::clone(&self.state),
            env: self.env.clone(),
        }
    }

    /// Init, answering at once with a stream of its steps as they happen
    /// and, last, the answer `init` would have given.
    fn init_streaming(&self, name: RepoName, body: InitBody) -> Result<Response> {
        let (sender, receiver) = futures_channel::mpsc::unbounded::<Vec<u8>>();
        let this = self.handle();
        wasm_bindgen_futures::spawn_local(async move {
            let progress = Progress::to(sender);
            let answer = match this.init(name, body, &progress).await {
                Ok(answer) => answer,
                Err(error) => match Response::error(error.to_string(), 500) {
                    Ok(answer) => answer,
                    Err(_) => return,
                },
            };
            progress.outcome(answer).await;
        });
        let headers = Headers::new();
        headers.set("content-type", PROGRESS)?;
        headers.set("cache-control", "no-store")?;
        Ok(Response::from_stream(receiver.map(Ok::<_, worker::Error>))?.with_headers(headers))
    }

    /// Import `source` as the tree's root repo and init the tree on its head,
    /// telling `progress` each step as it starts and ends.
    async fn init(
        &self,
        name: RepoName,
        body: InitBody,
        progress: &Progress,
    ) -> Result<Response> {
        if self.load().await?.is_some() {
            return Response::error("tree already initialized", 409);
        }
        let artifacts = self.artifacts()?;
        let failed = |step: InitStep, error: &ArtifactsError| {
            progress.step(step, StepState::Error, Some(&error.to_string()));
            artifacts_error(error)
        };
        let head = match body.source {
            Some(source) => {
                progress.step(InitStep::Import, StepState::Active, Some(&source));
                // ALREADY_EXISTS means an earlier init got this far and then
                // timed out; carry on and pick up the repo it imported.
                match artifacts
                    .import(&source, body.branch.as_deref(), &name)
                    .await
                {
                    Ok(_) => {}
                    Err(error) if error.is("ALREADY_EXISTS") => {}
                    Err(error) => return failed(InitStep::Import, &error),
                }
                progress.step(InitStep::Import, StepState::Complete, None);
                progress.step(InitStep::Settle, StepState::Active, None);
                match settled_head(&artifacts, &name, progress).await? {
                    Some(head) => {
                        progress.step(InitStep::Settle, StepState::Complete, Some(head.as_str()));
                        head
                    }
                    None => {
                        let late = "import has not finished; init again to pick it up";
                        progress.step(InitStep::Settle, StepState::Error, Some(late));
                        return Response::error(late, 504);
                    }
                }
            }
            None => match artifacts.repo(&name).await {
                Ok(repo) => match repo.history(1).await {
                    Ok(history) => match history.first() {
                        Some(head) => match Oid::try_from(head.hash.clone()) {
                            Ok(head) => {
                                progress.step(
                                    InitStep::ReadHead,
                                    StepState::Complete,
                                    Some(head.as_str()),
                                );
                                head
                            }
                            Err(error) => return tree_error(&error),
                        },
                        None => {
                            return Response::error(
                                "the root repo is empty: push the root, then init again",
                                409,
                            );
                        }
                    },
                    Err(error) => return failed(InitStep::ReadHead, &error),
                },
                Err(error) if error.is("NOT_FOUND") => {
                    progress.step(InitStep::Create, StepState::Active, None);
                    return match artifacts.create(&name, "ficus root").await {
                        Ok(created) => {
                            progress.step(
                                InitStep::Create,
                                StepState::Complete,
                                Some(&created.remote),
                            );
                            let mut response = Response::from_json(&serde_json::json!({
                                "state": "awaiting root",
                                "remote": created.remote,
                                "token": created.token,
                                "next": "push the root to `remote` (http.extraHeader=\"Authorization: Bearer <token>\"), then POST init again",
                            }))?;
                            response = response.with_status(202);
                            Ok(response)
                        }
                        Err(error) => failed(InitStep::Create, &error),
                    };
                }
                Err(error) => return failed(InitStep::ReadHead, &error),
            },
        };
        progress.step(InitStep::Lock, StepState::Active, None);
        let repo = match artifacts.repo(&name).await {
            Ok(repo) => repo,
            Err(error) => return failed(InitStep::Lock, &error),
        };
        // The root repo is only ever read through forks; nobody pushes to it.
        if let Err(error) = repo.revoke_active_tokens().await {
            return failed(InitStep::Lock, &error);
        }
        progress.step(InitStep::Lock, StepState::Complete, None);
        if self.load().await?.is_some() {
            return Response::error("tree already initialized", 409);
        }
        let tree = match Tree::init(name, head) {
            Ok(tree) => tree,
            Err(error) => return tree_error(&error),
        };
        progress.step(InitStep::Save, StepState::Active, None);
        self.save(&tree).await?;
        progress.step(InitStep::Save, StepState::Complete, None);
        Response::from_json(&tree)
    }

    async fn task(&self, body: TaskBody) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        match tree.task_new(body.intent, body.checks) {
            Ok(task) => {
                self.save(&tree).await?;
                Response::from_json(&serde_json::json!({ "task": task }))
            }
            Err(error) => tree_error(&error),
        }
    }

    /// Record a new attempt, then fork its base node's repo for it.
    async fn start(&self, task: TaskId, body: StartBody) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let attempt = match tree.start(task, body.agent) {
            Ok(attempt) => attempt,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        self.provision(&tree, attempt).await
    }

    /// Fork the base node's repo into `attempt`'s repo and hand out its token.
    /// A failed fork abandons the attempt so it does not sit working forever.
    async fn provision(&self, tree: &Tree, attempt: AttemptId) -> Result<Response> {
        let entry = tree
            .attempt(attempt)
            .expect("the caller just created this attempt");
        let base = tree
            .node(entry.base)
            .expect("a attempt's base is a node of its tree");
        let task = tree
            .task(entry.task)
            .expect("a attempt's task is in its tree");
        let (intent, checks) = (task.intent.clone(), task.checks.clone());
        let artifacts = self.artifacts()?;
        let forked = match artifacts.repo(&base.repo).await {
            Ok(base_repo) => base_repo.fork(&entry.repo, &intent).await,
            Err(error) => Err(error),
        };
        match forked {
            Ok(created) => Response::from_json(&Started {
                attempt,
                task: entry.task,
                intent,
                checks,
                agent: entry.agent.clone(),
                repo: created.name,
                remote: created.remote,
                token: created.token,
                base_commit: base.commit.as_str().to_owned(),
                history: tree.history_of(entry.task).cloned().collect(),
            }),
            Err(error) => {
                if let Some(mut tree) = self.load().await?
                    && tree
                        .abandon(attempt, format!("fork failed: {error}"))
                        .is_ok()
                {
                    self.save(&tree).await?;
                }
                artifacts_error(&error)
            }
        }
    }

    /// Freeze the attempt (revoke its tokens), read its head commit from
    /// Artifacts, and queue it for the root's checks. The commit is never
    /// taken from the caller, and must descend from the attempt's base. Scoring
    /// runs from the alarm; poll `GET /trees/<t>/attempts/<attempt>` for the result.
    async fn submit(&self, attempt: AttemptId) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let Some(entry) = tree.attempt(attempt) else {
            return tree_error(&TreeError::UnknownAttempt(attempt));
        };
        let base_commit = tree
            .node(entry.base)
            .expect("a attempt's base is a node of its tree")
            .commit
            .clone();
        let artifacts = self.artifacts()?;
        let repo = match artifacts.repo(&entry.repo).await {
            Ok(repo) => repo,
            Err(error) => return artifacts_error(&error),
        };
        if let Err(error) = repo.revoke_active_tokens().await {
            return artifacts_error(&error);
        }
        let history = match repo.history(HISTORY_DEPTH).await {
            Ok(history) => history,
            Err(error) => return artifacts_error(&error),
        };
        let Some(head) = history.first() else {
            return Response::error("attempt repo has no commits", 409);
        };
        if head.hash == base_commit.as_str() {
            return Response::error("attempt has no commits beyond its base", 409);
        }
        if !history
            .iter()
            .any(|commit| commit.hash == base_commit.as_str())
        {
            return Response::error("attempt head does not descend from its base commit", 409);
        }
        let head = match Oid::try_from(head.hash.clone()) {
            Ok(head) => head,
            Err(error) => return tree_error(&error),
        };
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        if let Err(error) = tree.submit(attempt, head.clone()) {
            return tree_error(&error);
        }
        self.save(&tree).await?;
        self.state.storage().set_alarm(Duration::ZERO).await?;
        let mut response = Response::from_json(
            &serde_json::json!({ "attempt": attempt, "commit": head.as_str(), "state": "checking" }),
        )?;
        response = response.with_status(202);
        Ok(response)
    }

    /// Acceptance `task`, or with `None` the oldest task that is ready. The head
    /// moves, so every other submitted attempt is behind: the alarm set here
    /// rebases them onto the new head.
    async fn accept(&self, task: Option<TaskId>) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let accepted = match task {
            Some(task) => tree.accept(task),
            None => tree.accept_next(),
        };
        let acceptance = match accepted {
            Ok(accept) => accept,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        if !acceptance.behind.is_empty() {
            self.state.storage().set_alarm(Duration::ZERO).await?;
        }
        let revoke_failures = self.revoke_all(&tree, &acceptance.closed).await?;
        let head = tree.head();
        let accepted = tree
            .attempt(acceptance.accepted)
            .expect("the accepted is a attempt of this tree");
        Response::from_json(&serde_json::json!({
            "task": accepted.task,
            "node": acceptance.node,
            "accepted": acceptance.accepted,
            "commit": head.commit.as_str(),
            "repo": head.repo.as_str(),
            "closed": acceptance.closed,
            "behind": tree.all_behind().collect::<Vec<_>>(),
            "revoke_failures": revoke_failures,
        }))
    }

    async fn abandon(&self, attempt: AttemptId, body: AbandonBody) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        if let Err(error) = tree.abandon(attempt, body.note) {
            return tree_error(&error);
        }
        self.save(&tree).await?;
        let revoke_failures = self.revoke_all(&tree, &[attempt]).await?;
        Response::from_json(
            &serde_json::json!({ "attempt": attempt, "revoke_failures": revoke_failures }),
        )
    }

    /// Start a behind attempt again from the head, in a fresh repo.
    async fn retry(&self, behind: AttemptId) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let fresh = match tree.retry(behind) {
            Ok(fresh) => fresh,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        let revoke_failures = self.revoke_all(&tree, &[behind]).await?;
        if !revoke_failures.is_empty() {
            return Response::error(
                format!("could not revoke the behind attempt's tokens: {revoke_failures:?}"),
                502,
            );
        }
        self.provision(&tree, fresh).await
    }

    /// Revoke the tokens of each attempt's repo. Failures are returned, not
    /// dropped: the tree has already moved on, so the caller decides.
    async fn revoke_all(&self, tree: &Tree, attempts: &[AttemptId]) -> Result<Vec<String>> {
        let artifacts = self.artifacts()?;
        let mut failures = Vec::new();
        for &attempt in attempts {
            let repo = &tree
                .attempt(attempt)
                .expect("callers pass attempts of this tree")
                .repo;
            let revoked = match artifacts.repo(repo).await {
                Ok(handle) => handle.revoke_active_tokens().await.map(|_| ()),
                // A attempt whose fork never happened has nothing to revoke.
                Err(error) if error.is("NOT_FOUND") => Ok(()),
                Err(error) => Err(error),
            };
            if let Err(error) = revoked {
                failures.push(format!("{}: {error}", repo.as_str()));
            }
        }
        Ok(failures)
    }
}

/// Apply a scoring result to a attempt that may have moved on while its checks
/// ran: abandoned or closed meanwhile is expected and the result is moot;
/// anything else is a bug worth seeing in the logs.
fn settle(attempt: AttemptId, applied: std::result::Result<(), TreeError>) {
    match applied {
        Ok(()) | Err(TreeError::NotChecking(_) | TreeError::NotOpen(_)) => {}
        Err(error) => worker::console_error!("applying the score of attempt {attempt}: {error}"),
    }
}

struct Pending {
    attempt: AttemptId,
    repo: RepoName,
    /// The task's intent, for the root's judges.
    intent: String,
    base: Oid,
    head: Oid,
    checks: Vec<CheckSpec>,
}

/// A behind attempt being replayed onto the head in a fresh one.
struct Rebase {
    behind: AttemptId,
    fresh: AttemptId,
    from_repo: RepoName,
    from_base: Oid,
    from_head: Oid,
    onto_head: Oid,
}

enum SandboxOutcome<Report = ScoreReport> {
    Report(Report),
    /// The sandbox says the input cannot be handled (no ficus.toml, head
    /// not descending from base, a conflict): retrying will not help.
    Unscorable(String),
    /// The sandbox or the path to it failed: worth another attempt.
    Failed(String),
}

enum RebaseOutcome {
    Report(RebaseReport),
    /// The commits do not apply on the head: the agent's turn.
    Conflict(String),
    Failed(String),
}

/// Whether the caller asked to hear an operation's steps as they happen.
fn wants_progress(req: &Request) -> Result<bool> {
    Ok(req
        .headers()
        .get("accept")?
        .is_some_and(|accept| accept.contains(PROGRESS)))
}

/// The head of `name` once its import has landed, or `None` if it has not
/// within `IMPORT_POLLS`. Each wait is a `Settle` step with its attempt.
async fn settled_head(
    artifacts: &Namespace,
    name: &RepoName,
    progress: &Progress,
) -> Result<Option<Oid>> {
    for attempt in 1..=IMPORT_POLLS {
        match artifacts.repo(name).await {
            Ok(repo) => match repo.history(1).await {
                Ok(history) => {
                    if let Some(head) = history.first() {
                        return Oid::try_from(head.hash.clone())
                            .map(Some)
                            .map_err(|error| worker::Error::RustError(error.to_string()));
                    }
                }
                Err(error) => return Err(worker::Error::RustError(error.to_string())),
            },
            Err(error) if error.is("IMPORT_IN_PROGRESS") || error.is("CREATE_IN_PROGRESS") => {}
            Err(error) => return Err(worker::Error::RustError(error.to_string())),
        }
        progress.step(
            InitStep::Settle,
            StepState::Active,
            Some(&format!(
                "still importing, check {attempt} of {IMPORT_POLLS}"
            )),
        );
        worker::Delay::from(std::time::Duration::from_millis(IMPORT_POLL_MS)).await;
    }
    Ok(None)
}

/// A request's query string, by name.
struct Query(Vec<(String, String)>);

impl Query {
    fn of(req: &Request) -> Result<Self> {
        Ok(Self(req.url()?.query_pairs().into_owned().collect()))
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn number(&self, name: &str) -> Option<u32> {
        self.get(name).and_then(|value| value.parse().ok())
    }
}

/// The directory at `path` in `commit`, walking down from its root tree.
async fn list_dir(
    repo: &Repo,
    name: &RepoName,
    commit: CommitMetadata,
    path: &FilePath,
) -> Result<Response> {
    let mut hash = commit.tree_hash.clone();
    for segment in path.names() {
        let entries = match repo.read_tree(&hash).await {
            Ok(Some(entries)) => entries,
            Ok(None) => return Response::error(format!("no tree {hash}"), 404),
            Err(error) => return artifacts_error(&error),
        };
        match entries
            .into_iter()
            .find(|entry| entry.name == *segment && entry.is_tree())
        {
            Some(entry) => hash = entry.hash,
            None => return Response::error(format!("no directory {}", path.joined()), 404),
        }
    }
    let mut entries = match repo.read_tree(&hash).await {
        Ok(Some(entries)) => entries,
        Ok(None) => return Response::error(format!("no tree {hash}"), 404),
        Err(error) => return artifacts_error(&error),
    };
    // Directories first, then by name: how a reader expects a listing.
    entries.sort_by(|a, b| b.is_tree().cmp(&a.is_tree()).then(a.name.cmp(&b.name)));
    Response::from_json(&serde_json::json!({
        "repo": name,
        "commit": commit,
        "path": path.joined(),
        "entries": entries,
    }))
}

/// The file at `path` in `commit`, as bytes. Never served as anything a
/// browser would run: these are untrusted bytes leaving through the
/// origin that holds the session cookie.
async fn read_file(repo: &Repo, commit: &str, path: &FilePath) -> Result<Response> {
    if path.is_root() {
        return Response::error("a file read needs a path", 400);
    }
    let file = match repo.read_file(commit, &path.joined(), FILE_MAX_BYTES).await {
        Ok(Some(file)) => file,
        Ok(None) => return Response::error(format!("no file {}", path.joined()), 404),
        Err(error) => return artifacts_error(&error),
    };
    let is_text = file.content_type.starts_with("text/")
        || ["json", "xml", "javascript", "toml", "yaml"]
            .iter()
            .any(|kind| file.content_type.contains(kind));
    let headers = Headers::new();
    headers.set(
        "content-type",
        if is_text {
            "text/plain; charset=utf-8"
        } else {
            "application/octet-stream"
        },
    )?;
    headers.set("x-ficus-content-type", &file.content_type)?;
    headers.set("x-ficus-commit", commit)?;
    headers.set("x-content-type-options", "nosniff")?;
    headers.set("content-security-policy", "sandbox; default-src 'none'")?;
    Ok(Response::from_bytes(file.bytes)?.with_headers(headers))
}

fn tree_error(error: &TreeError) -> Result<Response> {
    let status = match error {
        TreeError::MalformedOid(_)
        | TreeError::MalformedRepoName(_)
        | TreeError::ImpossibleScore { .. }
        | TreeError::EmptyIntent
        | TreeError::TaskChecks(_) => 400,
        TreeError::UnknownTask(_) | TreeError::UnknownAttempt(_) | TreeError::UnknownNode(_) => 404,
        TreeError::TaskDone(_)
        | TreeError::NotGrowing(_)
        | TreeError::NotChecking(_)
        | TreeError::NotOpen(_)
        | TreeError::NotBehind(_)
        | TreeError::NothingToRebase(_)
        | TreeError::Rebaseing(_, _)
        | TreeError::NotRebase(_)
        | TreeError::NothingToAccept(_)
        | TreeError::NothingScored
        | TreeError::TaskExhausted(_, _) => 409,
        TreeError::Full => 507,
    };
    Response::error(error.to_string(), status)
}

fn artifacts_error(error: &ArtifactsError) -> Result<Response> {
    let status = match error.code.as_str() {
        "NOT_FOUND" => 404,
        "ALREADY_EXISTS" | "CREATE_IN_PROGRESS" | "IMPORT_IN_PROGRESS" | "FORK_IN_PROGRESS" => 409,
        "INVALID_INPUT" | "INVALID_REPO_NAME" | "INVALID_URL" | "INVALID_TTL" => 400,
        "REMOTE_AUTH_REQUIRED" => 403,
        "MEMORY_LIMIT" => 413,
        _ => 502,
    };
    Response::error(error.to_string(), status)
}
