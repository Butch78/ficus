//! `TreeObject`: one Durable Object per tree, holding the `ficus_core` tree
//! and driving Artifacts as the tree changes.
//!
//! Requests interleave at every await on Artifacts, so each handler changes
//! the tree only between awaits: load, mutate, save with no await in between.
//! Where a handler needs Artifacts both before and after a change, it reloads
//! the tree after the await rather than reusing the copy it read before.

use std::time::Duration;

use ficus_core::scoring::{ScoreReport, ScoreRequest};
use ficus_core::tree::{BudId, Compost, LeafId, Oid, RepoName, Tree, TreeError};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use worker::{
    DurableObject, Env, Method, Request, RequestInit, Response, Result, State, durable_object,
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
/// is withered rather than retried forever.
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

#[derive(Deserialize)]
struct BudBody {
    intent: String,
}

#[derive(Deserialize)]
struct SproutBody {
    agent: String,
}

#[derive(Deserialize)]
struct WitherBody {
    note: String,
}

/// Everything an agent needs to start growing a leaf.
#[derive(Serialize)]
struct Growing {
    leaf: LeafId,
    bud: BudId,
    intent: String,
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

    async fn alarm(&self) -> Result<Response> {
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
        let name = match RepoName::try_from(tree_name.to_owned()) {
            Ok(name) => name,
            Err(error) => return Response::error(error.to_string(), 400),
        };
        match (req.method(), route) {
            (Method::Get, []) => self.show().await,
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
            (Method::Post, ["buds", bud, "harvest"]) => match bud.parse() {
                Ok(bud) => self.harvest(bud).await,
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
                base: tree
                    .node(leaf.base)
                    .expect("a leaf's base is a node of its tree")
                    .commit
                    .clone(),
                head: head.clone(),
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
                        Ok(score) => settle(job.leaf, tree.ripen(job.leaf, score)),
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
        };
        let scored = self.ask_scorer(&job.repo, &request).await;
        if let Err(error) = repo.revoke_token(&token.id).await {
            worker::console_error!(
                "revoking the scorer's token on {}: {error}",
                job.repo.as_str()
            );
        }
        scored
    }

    async fn ask_scorer(&self, repo: &RepoName, request: &ScoreRequest) -> Scored {
        let attempt = async {
            let stub = self
                .env
                .durable_object("SCORER")?
                .get_by_name(repo.as_str())?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post)
                .with_body(Some(serde_json::to_string(request)?.into()));
            let mut response = stub
                .fetch_with_request(Request::new_with_init("http://scorer/score", &init)?)
                .await?;
            Ok::<_, worker::Error>((response.status_code(), response.text().await?))
        };
        match attempt.await {
            Ok((200, body)) => match serde_json::from_str::<ScoreReport>(&body) {
                Ok(report) => Scored::Report(report),
                Err(error) => Scored::Failed(format!(
                    "scorer answered with an unreadable report: {error}"
                )),
            },
            Ok((422, reason)) => Scored::Unscorable(reason),
            Ok((status, body)) => Scored::Failed(format!("scorer answered {status}: {body}")),
            Err(error) => Scored::Failed(error.to_string()),
        }
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
        match tree.bud_new(body.intent) {
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
        let intent = tree
            .bud(entry.bud)
            .expect("a leaf's bud is in its tree")
            .intent
            .clone();
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

    async fn harvest(&self, bud: BudId) -> Result<Response> {
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let harvest = match tree.harvest(bud) {
            Ok(harvest) => harvest,
            Err(error) => return tree_error(&error),
        };
        self.save(&tree).await?;
        let revoke_failures = self.revoke_all(&tree, &harvest.pruned).await?;
        let head = tree.head();
        Response::from_json(&serde_json::json!({
            "node": harvest.node,
            "fruit": harvest.fruit,
            "commit": head.commit.as_str(),
            "repo": head.repo.as_str(),
            "pruned": harvest.pruned,
            "stale": harvest.stale,
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
    base: Oid,
    head: Oid,
}

enum Scored {
    Report(ScoreReport),
    /// The scorer says the leaf or root cannot be scored (no ficus.toml,
    /// head not descending from base): retrying will not help.
    Unscorable(String),
    /// The scorer or the path to it failed: worth another attempt.
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
        | TreeError::EmptyIntent => 400,
        TreeError::UnknownBud(_) | TreeError::UnknownLeaf(_) => 404,
        TreeError::BudFruited(_)
        | TreeError::NotGrowing(_)
        | TreeError::NotRipening(_)
        | TreeError::NotLive(_)
        | TreeError::NotStale(_)
        | TreeError::NothingToHarvest(_) => 409,
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
