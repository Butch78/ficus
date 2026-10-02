//! `TreeObject`: one Durable Object per tree, holding the `ficus_core` tree
//! and driving Artifacts as the tree changes.
//!
//! Requests interleave at every await on Artifacts, so each handler changes
//! the tree only between awaits: load, mutate, save with no await in between.
//! Where a handler needs Artifacts both before and after a change, it reloads
//! the tree after the await rather than reusing the copy it read before.

use std::time::Duration;

use ficus_core::scoring::{
    CheckSpec, ScoreReport, ScoreRequest, TransplantReport, TransplantRequest,
};
use ficus_core::tree::{BudId, Compost, LeafId, NodeId, Oid, RepoName, Tree, TreeError};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Headers, Method, Request, RequestInit, Response, Result, State,
    durable_object,
};

use crate::artifacts::{ArtifactsError, Namespace, Scope};

const TREE_KEY: &str = "tree";
/// How long `plant` waits for an import before giving up: 30 polls, 2s apart.
const IMPORT_POLLS: u32 = 30;
const IMPORT_POLL_MS: u64 = 2000;
/// Deep enough to find a leaf's base under any sensible amount of work.
const HISTORY_DEPTH: u32 = 1000;
/// The scorer's read token outlives any scoring run, including a cold devenv.
const SCORER_TOKEN_TTL_SECS: u32 = 3600;
/// A leaf whose scoring fails this many times for the scorer's own reasons
/// is withered rather than retried forever. The same goes for a stale leaf
/// whose transplant keeps failing for the sandbox's reasons.
const SCORING_ATTEMPTS: u32 = 5;
const SCORING_RETRY: Duration = Duration::from_secs(60);

#[durable_object]
pub struct TreeObject {
    state: State,
    env: Env,
}

/// `source` imports an HTTPS git remote as the root. Without it, the first
/// call creates an empty root repo and returns a write token to push the root
/// with; the next call plants the tree on whatever was pushed.
#[derive(Deserialize)]
struct PlantBody {
    source: Option<String>,
    branch: Option<String>,
}

/// `intent` says what the bud is for; `checks` say when it is done, on top
/// of the root's. They run in the scorer, never from the repo.
#[derive(Deserialize)]
struct BudBody {
    intent: String,
    #[serde(default)]
    checks: Vec<CheckSpec>,
}

#[derive(Deserialize)]
struct SproutBody {
    agent: String,
}

#[derive(Deserialize)]
struct WitherBody {
    note: String,
}

/// `node` defaults to the head.
#[derive(Deserialize)]
struct ReleaseBody {
    node: Option<NodeId>,
}

/// Everything an agent needs to start growing a leaf.
#[derive(Serialize)]
struct Growing {
    leaf: LeafId,
    bud: BudId,
    intent: String,
    checks: Vec<CheckSpec>,
    agent: String,
    repo: String,
    remote: String,
    token: String,
    base_commit: String,
    compost: Vec<Compost>,
}

impl DurableObject for TreeObject {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    /// Transplants first: they turn stale leaves into ripening ones, which
    /// the scoring that follows picks up in the same alarm.
    async fn alarm(&self) -> Result<Response> {
        self.transplant_stale().await?;
        self.score_ripening().await
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
            (Method::Get, ["stale"]) => self.show_stale().await,
            (Method::Get, ["release"]) => self.show_release().await,
            (Method::Post, ["release"]) => self.release(req.json().await?).await,
            (Method::Get, ["leaves", leaf]) => match leaf.parse() {
                Ok(leaf) => self.show_leaf(leaf).await,
                Err(_) => Response::error("leaf id must be a number", 400),
            },
            (Method::Post, ["plant"]) => self.plant(name, req.json().await?).await,
            (Method::Post, ["buds"]) => self.bud(req.json().await?).await,
            (Method::Post, ["buds", bud, "leaves"]) => match bud.parse() {
                Ok(bud) => self.sprout(bud, req.json().await?).await,
                Err(_) => Response::error("bud id must be a number", 400),
            },
            (Method::Post, ["harvest"]) => self.harvest(None).await,
            (Method::Post, ["buds", bud, "harvest"]) => match bud.parse() {
                Ok(bud) => self.harvest(Some(bud)).await,
                Err(_) => Response::error("bud id must be a number", 400),
            },
            (Method::Post, ["leaves", leaf, action]) => match leaf.parse() {
                Ok(leaf) => match *action {
                    "ripe" => self.submit(leaf).await,
                    "wither" => self.wither(leaf, req.json().await?).await,
                    "regrow" => self.regrow(leaf).await,
                    _ => Response::error("not found", 404),
                },
                Err(_) => Response::error("leaf id must be a number", 400),
            },
            _ => Response::error("not found", 404),
        }
    }
}

impl TreeObject {
    /// Score every leaf waiting for its checks, in parallel, one scorer
    /// container per leaf. Runs from the alarm `submit` sets.
    async fn score_ripening(&self) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::ok("no tree");
        };
        let pending: Vec<Pending> = tree
            .ripening()
            .map(|(leaf, head)| Pending {
                leaf: leaf.id,
                repo: leaf.repo.clone(),
                intent: tree
                    .bud(leaf.bud)
                    .expect("a leaf's bud is in its tree")
                    .intent
                    .clone(),
                base: tree
                    .node(leaf.base)
                    .expect("a leaf's base is a node of its tree")
                    .commit
                    .clone(),
                head: head.clone(),
                checks: tree
                    .bud(leaf.bud)
                    .expect("a leaf's bud is in its tree")
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
            let attempts_key = format!("attempts:{}", job.leaf);
            match outcome {
                Scored::Report(report) => {
                    self.state
                        .storage()
                        .put(
                            &format!("report:{}", job.leaf),
                            serde_json::to_string(&report)?,
                        )
                        .await?;
                    match report.score() {
                        Ok(score) => settle(
                            job.leaf,
                            tree.ripen(job.leaf, score, report.touched.clone()),
                        ),
                        Err(error) => settle(
                            job.leaf,
                            tree.wither(job.leaf, format!("unscorable report: {error}")),
                        ),
                    }
                }
                Scored::Unscorable(reason) => settle(
                    job.leaf,
                    tree.wither(job.leaf, format!("unscorable: {reason}")),
                ),
                Scored::Failed(reason) => {
                    let attempts = self
                        .state
                        .storage()
                        .get::<u32>(&attempts_key)
                        .await?
                        .unwrap_or(0)
                        + 1;
                    if attempts >= SCORING_ATTEMPTS {
                        settle(
                            job.leaf,
                            tree.wither(
                                job.leaf,
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
    async fn score_one(&self, job: &Pending) -> Scored {
        let artifacts = match self.artifacts() {
            Ok(artifacts) => artifacts,
            Err(error) => return Scored::Failed(error.to_string()),
        };
        let repo = match artifacts.repo(&job.repo).await {
            Ok(repo) => repo,
            Err(error) => return Scored::Failed(error.to_string()),
        };
        let (info, token) = match (
            repo.info().await,
            repo.create_token(Scope::Read, SCORER_TOKEN_TTL_SECS).await,
        ) {
            (Ok(info), Ok(token)) => (info, token),
            (Err(error), _) | (_, Err(error)) => return Scored::Failed(error.to_string()),
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

    /// Replay every stale submitted leaf onto the head, in parallel, one
    /// sandbox per leaf. A leaf that applies cleanly ripens on the head
    /// without its agent; one that conflicts is left for its agent to
    /// regrow, with the conflict in the compost.
    async fn transplant_stale(&self) -> Result<()> {
        let Some(mut tree) = self.load().await? else {
            return Ok(());
        };
        let stale: Vec<LeafId> = tree.transplantable().map(|leaf| leaf.id).collect();
        if stale.is_empty() {
            return Ok(());
        }
        let mut jobs = Vec::with_capacity(stale.len());
        for leaf in stale {
            match tree.transplant_start(leaf) {
                Ok((fresh, commit)) => {
                    let old = tree.leaf(leaf).expect("transplant_start found it");
                    jobs.push(Transplant {
                        stale: leaf,
                        fresh,
                        from_repo: old.repo.clone(),
                        from_base: tree
                            .node(old.base)
                            .expect("a leaf's base is a node of its tree")
                            .commit
                            .clone(),
                        from_head: commit,
                        onto_head: tree.head().commit.clone(),
                    });
                }
                Err(error) => worker::console_error!("starting transplant of leaf {leaf}: {error}"),
            }
        }
        self.save(&tree).await?;

        let outcomes = join_all(jobs.iter().map(|job| self.transplant_one(&tree, job))).await;

        // Transplants awaited; other requests may have changed the tree since.
        let Some(mut tree) = self.load().await? else {
            return Ok(());
        };
        let mut retry = false;
        for (job, outcome) in jobs.iter().zip(outcomes) {
            let attempts_key = format!("transplant-attempts:{}", job.stale);
            match outcome {
                Transplanted::Report(report) => {
                    settle(job.fresh, tree.transplant_done(job.fresh, report.commit));
                    self.state.storage().delete(&attempts_key).await?;
                }
                Transplanted::Conflict(reason) => {
                    // The agent's turn: the stale leaf stays, pointing at
                    // the withered transplant, and the alarm leaves it be.
                    settle(
                        job.fresh,
                        tree.transplant_failed(job.fresh, format!("transplant: {reason}")),
                    );
                    self.state.storage().delete(&attempts_key).await?;
                }
                Transplanted::Failed(reason) => {
                    let attempts = self
                        .state
                        .storage()
                        .get::<u32>(&attempts_key)
                        .await?
                        .unwrap_or(0)
                        + 1;
                    let note = format!("transplant attempt {attempts} failed: {reason}");
                    if attempts >= SCORING_ATTEMPTS {
                        settle(job.fresh, tree.transplant_failed(job.fresh, note));
                        self.state.storage().delete(&attempts_key).await?;
                    } else {
                        settle(job.fresh, tree.transplant_retry(job.fresh, note));
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

    /// Fork the head's repo for the fresh leaf, lend the sandbox a read
    /// token on the stale one, replay, then revoke both.
    async fn transplant_one(&self, tree: &Tree, job: &Transplant) -> Transplanted {
        let fresh = tree.leaf(job.fresh).expect("transplant_start created it");
        let artifacts = match self.artifacts() {
            Ok(artifacts) => artifacts,
            Err(error) => return Transplanted::Failed(error.to_string()),
        };
        let forked = match artifacts.repo(&tree.head().repo).await {
            Ok(head_repo) => head_repo.fork(&fresh.repo, "ficus transplant").await,
            Err(error) => Err(error),
        };
        let onto = match forked {
            Ok(created) => created,
            Err(error) => return Transplanted::Failed(format!("fork: {error}")),
        };
        let from_repo = match artifacts.repo(&job.from_repo).await {
            Ok(repo) => repo,
            Err(error) => return Transplanted::Failed(error.to_string()),
        };
        let (from_info, from_token) = match (
            from_repo.info().await,
            from_repo
                .create_token(Scope::Read, SCORER_TOKEN_TTL_SECS)
                .await,
        ) {
            (Ok(info), Ok(token)) => (info, token),
            (Err(error), _) | (_, Err(error)) => return Transplanted::Failed(error.to_string()),
        };
        let request = TransplantRequest {
            from: from_info.remote,
            from_token: from_token.plaintext,
            from_base: job.from_base.clone(),
            from_head: job.from_head.clone(),
            onto: onto.remote,
            onto_token: onto.token,
            onto_head: job.onto_head.clone(),
            onto_branch: onto.default_branch,
        };
        let outcome = match self.ask_sandbox(&fresh.repo, "transplant", &request).await {
            Scored::Report(report) => Transplanted::Report(report),
            Scored::Unscorable(reason) => Transplanted::Conflict(reason),
            Scored::Failed(reason) => Transplanted::Failed(reason),
        };
        if let Err(error) = from_repo.revoke_token(&from_token.id).await {
            worker::console_error!(
                "revoking the transplant's token on {}: {error}",
                job.from_repo.as_str()
            );
        }
        // The fresh leaf is frozen from the start: nobody pushes to it.
        match artifacts.repo(&fresh.repo).await {
            Ok(repo) => {
                if let Err(error) = repo.revoke_active_tokens().await {
                    worker::console_error!(
                        "revoking the fresh leaf's tokens on {}: {error}",
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
    ) -> Scored<Rep> {
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
                Ok(report) => Scored::Report(report),
                Err(error) => Scored::Failed(format!(
                    "sandbox answered {action} with an unreadable report: {error}"
                )),
            },
            Ok((422, reason)) => Scored::Unscorable(reason),
            Ok((status, body)) => Scored::Failed(format!("sandbox answered {status}: {body}")),
            Err(error) => Scored::Failed(error.to_string()),
        }
    }

    async fn show_stale(&self) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        Response::from_json(&tree.stale().collect::<Vec<_>>())
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

    async fn show_leaf(&self, leaf: LeafId) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let Some(entry) = tree.leaf(leaf) else {
            return tree_error(&TreeError::UnknownLeaf(leaf));
        };
        let report = match self
            .state
            .storage()
            .get::<String>(&format!("report:{leaf}"))
            .await?
        {
            Some(json) => Some(serde_json::from_str::<ScoreReport>(&json)?),
            None => None,
        };
        Response::from_json(&serde_json::json!({ "leaf": entry, "report": report }))
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

    /// Import `source` as the tree's root repo and plant the tree on its head.
    async fn plant(&self, name: RepoName, body: PlantBody) -> Result<Response> {
        if self.load().await?.is_some() {
            return Response::error("tree already planted", 409);
        }
        let artifacts = self.artifacts()?;
        let head = match body.source {
            Some(source) => {
                // ALREADY_EXISTS means an earlier plant got this far and then
                // timed out; carry on and pick up the repo it imported.
                match artifacts
                    .import(&source, body.branch.as_deref(), &name)
                    .await
                {
                    Ok(_) => {}
                    Err(error) if error.is("ALREADY_EXISTS") => {}
                    Err(error) => return artifacts_error(&error),
                }
                match settled_head(&artifacts, &name).await? {
                    Some(head) => head,
                    None => {
                        return Response::error(
                            "import has not finished; plant again to pick it up",
                            504,
                        );
                    }
                }
            }
            None => match artifacts.repo(&name).await {
                Ok(repo) => match repo.history(1).await {
                    Ok(history) => match history.first() {
                        Some(head) => match Oid::try_from(head.hash.clone()) {
                            Ok(head) => head,
                            Err(error) => return tree_error(&error),
                        },
                        None => {
                            return Response::error(
                                "the root repo is empty: push the root, then plant again",
                                409,
                            );
                        }
                    },
                    Err(error) => return artifacts_error(&error),
                },
                Err(error) if error.is("NOT_FOUND") => {
                    return match artifacts.create(&name, "ficus root").await {
                        Ok(created) => {
                            let mut response = Response::from_json(&serde_json::json!({
                                "state": "awaiting root",
                                "remote": created.remote,
                                "token": created.token,
                                "next": "push the root to `remote` (http.extraHeader=\"Authorization: Bearer <token>\"), then POST plant again",
                            }))?;
                            response = response.with_status(202);
                            Ok(response)
                        }
                        Err(error) => artifacts_error(&error),
                    };
                }
                Err(error) => return artifacts_error(&error),
            },
        };
        let repo = match artifacts.repo(&name).await {
            Ok(repo) => repo,
            Err(error) => return artifacts_error(&error),
        };
        // The root repo is only ever read through forks; nobody pushes to it.
        if let Err(error) = repo.revoke_active_tokens().await {
            return artifacts_error(&error);
        }
        if self.load().await?.is_some() {
            return Response::error("tree already planted", 409);
        }
        let tree = match Tree::plant(name, head) {
            Ok(tree) => tree,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        Response::from_json(&tree)
    }

    async fn bud(&self, body: BudBody) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        match tree.bud_new(body.intent, body.checks) {
            Ok(bud) => {
                self.save(&tree).await?;
                Response::from_json(&serde_json::json!({ "bud": bud }))
            }
            Err(error) => tree_error(&error),
        }
    }

    /// Record a new leaf, then fork its base node's repo for it.
    async fn sprout(&self, bud: BudId, body: SproutBody) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let leaf = match tree.sprout(bud, body.agent) {
            Ok(leaf) => leaf,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        self.grow(&tree, leaf).await
    }

    /// Fork the base node's repo into `leaf`'s repo and hand out its token.
    /// A failed fork withers the leaf so it does not sit growing forever.
    async fn grow(&self, tree: &Tree, leaf: LeafId) -> Result<Response> {
        let entry = tree.leaf(leaf).expect("the caller just created this leaf");
        let base = tree
            .node(entry.base)
            .expect("a leaf's base is a node of its tree");
        let bud = tree.bud(entry.bud).expect("a leaf's bud is in its tree");
        let (intent, checks) = (bud.intent.clone(), bud.checks.clone());
        let artifacts = self.artifacts()?;
        let forked = match artifacts.repo(&base.repo).await {
            Ok(base_repo) => base_repo.fork(&entry.repo, &intent).await,
            Err(error) => Err(error),
        };
        match forked {
            Ok(created) => Response::from_json(&Growing {
                leaf,
                bud: entry.bud,
                intent,
                checks,
                agent: entry.agent.clone(),
                repo: created.name,
                remote: created.remote,
                token: created.token,
                base_commit: base.commit.as_str().to_owned(),
                compost: tree.compost_of(entry.bud).cloned().collect(),
            }),
            Err(error) => {
                if let Some(mut tree) = self.load().await?
                    && tree.wither(leaf, format!("fork failed: {error}")).is_ok()
                {
                    self.save(&tree).await?;
                }
                artifacts_error(&error)
            }
        }
    }

    /// Freeze the leaf (revoke its tokens), read its head commit from
    /// Artifacts, and queue it for the root's checks. The commit is never
    /// taken from the caller, and must descend from the leaf's base. Scoring
    /// runs from the alarm; poll `GET /trees/<t>/leaves/<leaf>` for the result.
    async fn submit(&self, leaf: LeafId) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let Some(entry) = tree.leaf(leaf) else {
            return tree_error(&TreeError::UnknownLeaf(leaf));
        };
        let base_commit = tree
            .node(entry.base)
            .expect("a leaf's base is a node of its tree")
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
            return Response::error("leaf repo has no commits", 409);
        };
        if head.hash == base_commit.as_str() {
            return Response::error("leaf has no commits beyond its base", 409);
        }
        if !history
            .iter()
            .any(|commit| commit.hash == base_commit.as_str())
        {
            return Response::error("leaf head does not descend from its base commit", 409);
        }
        let head = match Oid::try_from(head.hash.clone()) {
            Ok(head) => head,
            Err(error) => return tree_error(&error),
        };
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        if let Err(error) = tree.submit(leaf, head.clone()) {
            return tree_error(&error);
        }
        self.save(&tree).await?;
        self.state.storage().set_alarm(Duration::ZERO).await?;
        let mut response = Response::from_json(
            &serde_json::json!({ "leaf": leaf, "commit": head.as_str(), "state": "ripening" }),
        )?;
        response = response.with_status(202);
        Ok(response)
    }

    /// Harvest `bud`, or with `None` the oldest bud that is ready. The head
    /// moves, so every other submitted leaf is stale: the alarm set here
    /// transplants them onto the new head.
    async fn harvest(&self, bud: Option<BudId>) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let harvested = match bud {
            Some(bud) => tree.harvest(bud),
            None => tree.harvest_next(),
        };
        let harvest = match harvested {
            Ok(harvest) => harvest,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        if !harvest.stale.is_empty() {
            self.state.storage().set_alarm(Duration::ZERO).await?;
        }
        let revoke_failures = self.revoke_all(&tree, &harvest.pruned).await?;
        let head = tree.head();
        let fruit = tree
            .leaf(harvest.fruit)
            .expect("the fruit is a leaf of this tree");
        Response::from_json(&serde_json::json!({
            "bud": fruit.bud,
            "node": harvest.node,
            "fruit": harvest.fruit,
            "commit": head.commit.as_str(),
            "repo": head.repo.as_str(),
            "pruned": harvest.pruned,
            "stale": tree.stale().collect::<Vec<_>>(),
            "revoke_failures": revoke_failures,
        }))
    }

    async fn wither(&self, leaf: LeafId, body: WitherBody) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        if let Err(error) = tree.wither(leaf, body.note) {
            return tree_error(&error);
        }
        self.save(&tree).await?;
        let revoke_failures = self.revoke_all(&tree, &[leaf]).await?;
        Response::from_json(
            &serde_json::json!({ "leaf": leaf, "revoke_failures": revoke_failures }),
        )
    }

    /// Start a stale leaf again from the head, in a fresh repo.
    async fn regrow(&self, stale: LeafId) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let fresh = match tree.regrow(stale) {
            Ok(fresh) => fresh,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        let revoke_failures = self.revoke_all(&tree, &[stale]).await?;
        if !revoke_failures.is_empty() {
            return Response::error(
                format!("could not revoke the stale leaf's tokens: {revoke_failures:?}"),
                502,
            );
        }
        self.grow(&tree, fresh).await
    }

    /// Revoke the tokens of each leaf's repo. Failures are returned, not
    /// dropped: the tree has already moved on, so the caller decides.
    async fn revoke_all(&self, tree: &Tree, leaves: &[LeafId]) -> Result<Vec<String>> {
        let artifacts = self.artifacts()?;
        let mut failures = Vec::new();
        for &leaf in leaves {
            let repo = &tree
                .leaf(leaf)
                .expect("callers pass leaves of this tree")
                .repo;
            let revoked = match artifacts.repo(repo).await {
                Ok(handle) => handle.revoke_active_tokens().await.map(|_| ()),
                // A leaf whose fork never happened has nothing to revoke.
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

/// Apply a scoring result to a leaf that may have moved on while its checks
/// ran: withered or pruned meanwhile is expected and the result is moot;
/// anything else is a bug worth seeing in the logs.
fn settle(leaf: LeafId, applied: std::result::Result<(), TreeError>) {
    match applied {
        Ok(()) | Err(TreeError::NotRipening(_) | TreeError::NotLive(_)) => {}
        Err(error) => worker::console_error!("applying the score of leaf {leaf}: {error}"),
    }
}

struct Pending {
    leaf: LeafId,
    repo: RepoName,
    /// The bud's intent, for the root's judges.
    intent: String,
    base: Oid,
    head: Oid,
    checks: Vec<CheckSpec>,
}

/// A stale leaf being replayed onto the head in a fresh one.
struct Transplant {
    stale: LeafId,
    fresh: LeafId,
    from_repo: RepoName,
    from_base: Oid,
    from_head: Oid,
    onto_head: Oid,
}

enum Scored<Report = ScoreReport> {
    Report(Report),
    /// The sandbox says the input cannot be handled (no ficus.toml, head
    /// not descending from base, a conflict): retrying will not help.
    Unscorable(String),
    /// The sandbox or the path to it failed: worth another attempt.
    Failed(String),
}

enum Transplanted {
    Report(TransplantReport),
    /// The commits do not apply on the head: the agent's turn.
    Conflict(String),
    Failed(String),
}

/// The head of `name` once its import has landed, or `None` if it has not
/// within `IMPORT_POLLS`.
async fn settled_head(artifacts: &Namespace, name: &RepoName) -> Result<Option<Oid>> {
    for _ in 0..IMPORT_POLLS {
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
        worker::Delay::from(std::time::Duration::from_millis(IMPORT_POLL_MS)).await;
    }
    Ok(None)
}

fn tree_error(error: &TreeError) -> Result<Response> {
    let status = match error {
        TreeError::MalformedOid(_)
        | TreeError::MalformedRepoName(_)
        | TreeError::ImpossibleScore { .. }
        | TreeError::EmptyIntent
        | TreeError::BudChecks(_) => 400,
        TreeError::UnknownBud(_) | TreeError::UnknownLeaf(_) | TreeError::UnknownNode(_) => 404,
        TreeError::BudFruited(_)
        | TreeError::NotGrowing(_)
        | TreeError::NotRipening(_)
        | TreeError::NotLive(_)
        | TreeError::NotStale(_)
        | TreeError::NothingToTransplant(_)
        | TreeError::Transplanting(_, _)
        | TreeError::NotTransplant(_)
        | TreeError::NothingToHarvest(_)
        | TreeError::NothingRipe
        | TreeError::BudExhausted(_, _) => 409,
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
        _ => 502,
    };
    Response::error(error.to_string(), status)
}
