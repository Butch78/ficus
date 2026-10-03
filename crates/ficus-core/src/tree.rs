//! The Ficus tree: work grows outward from an accepted node and never merges
//! back.
//!
//! A **task** is a task, stated as intent rather than as a diff. Agents grow
//! competing **attempts** for a task, each starting from the current head node.
//! A scored attempt carries a commit and the score the root's checks gave it.
//! **Accepting** a task turns its best passing attempt into **accepted**: a new
//! node that becomes the head. The task's other attempts are closed.
//!
//! There is no merge. A attempt of another task that grew from an older node is
//! *behind*. It cannot be accepted, because its commit was never checked
//! against the new head. Behind is about what was checked, not about the
//! diff, so a behind attempt with a commit is first **rebased**: the
//! machine replays its commits onto the head in a fresh attempt and the checks
//! run again there. No agent is involved and the result is still a
//! single-parent commit on the head. Only when the replay conflicts is the
//! attempt **retried**: the agent starts again from the head, with the same
//! intent and the history of earlier attempts. A conflict becomes another
//! attempt rather than a three-way merge.
//!
//! Every closed attempt goes to the **history**: who grew it, why it lost and
//! how it scored. That is the context later attempts start from. A task that
//! keeps losing is telling its owner the intent is too big: after
//! [`MAX_RETRIES`] retries it takes no more, and the owner decides.
//!
//! A task says what done means with its own **checks**, run after the root's
//! and just as immutable to the attempt, since they never live in the repo.
//! Acceptance takes the oldest task first, so no task starves.
//!
//! A **release** is a pointer at a node. Every node was scored by the same
//! checks and history is linear, so a rollback is the pointer moving back.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::scoring::{CheckSpec, ChecksError, validate_checks};

/// Retryths a task takes before it stops competing and its owner decides.
/// Rebases are free: they cost no agent's time.
pub const MAX_RETRIES: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct NodeId(u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TaskId(u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct AttemptId(u32);

macro_rules! id_text {
    ($($id:ident),*) => {$(
        impl std::fmt::Display for $id {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        /// Ids appear in URLs; an id that names nothing is caught by the
        /// lookup that uses it, not here.
        impl std::str::FromStr for $id {
            type Err = std::num::ParseIntError;

            fn from_str(text: &str) -> Result<Self, Self::Err> {
                text.parse().map(Self)
            }
        }
    )*};
}

id_text!(NodeId, TaskId, AttemptId);

/// A git object id: 40 hex digits (SHA-1) or 64 (SHA-256), lowercase.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Oid(String);

impl Oid {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Oid {
    type Error = TreeError;

    fn try_from(hex: String) -> Result<Self, Self::Error> {
        let well_formed = matches!(hex.len(), 40 | 64)
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if well_formed {
            Ok(Self(hex))
        } else {
            Err(TreeError::MalformedOid(hex))
        }
    }
}

impl From<Oid> for String {
    fn from(oid: Oid) -> Self {
        oid.0
    }
}

/// An Artifacts repository name: ASCII letters, digits, `.`, `-` and `_`,
/// at most 63 characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RepoName(String);

/// Room left after the longest tree name for a attempt suffix (`-l` + a u32).
const REPO_NAME_MAX: usize = 63;

impl RepoName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for RepoName {
    type Error = TreeError;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        let well_formed = !name.is_empty()
            && name.len() <= REPO_NAME_MAX
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
        if well_formed {
            Ok(Self(name))
        } else {
            Err(TreeError::MalformedRepoName(name))
        }
    }
}

impl From<RepoName> for String {
    fn from(name: RepoName) -> Self {
        name.0
    }
}

/// What the root's checks said about a attempt.
///
/// A attempt can only become accepted if every check passed. Among passing attempts
/// the lowest `cost` wins. What cost measures (diff size, build time, binary
/// size) is the root's choice; the tree only needs it to be comparable. On
/// equal cost the higher `confidence` wins: how sure the root's judges were,
/// on average, in thousandths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Score {
    checks_passed: u32,
    checks_total: u32,
    cost: u64,
    /// `None` when the root has no judges; absent from trees stored before
    /// judges existed.
    #[serde(default)]
    confidence: Option<u16>,
}

impl Score {
    pub fn new(checks_passed: u32, checks_total: u32, cost: u64) -> Result<Self, TreeError> {
        if checks_total == 0 || checks_passed > checks_total {
            return Err(TreeError::ImpossibleScore {
                checks_passed,
                checks_total,
            });
        }
        Ok(Self {
            checks_passed,
            checks_total,
            cost,
            confidence: None,
        })
    }

    /// This score with the judges' mean confidence, in thousandths (at most 1000).
    pub fn judged(self, confidence: u16) -> Self {
        Self {
            confidence: Some(confidence.min(1000)),
            ..self
        }
    }

    pub fn passes(&self) -> bool {
        self.checks_passed == self.checks_total
    }

    pub fn checks_passed(&self) -> u32 {
        self.checks_passed
    }

    pub fn checks_total(&self) -> u32 {
        self.checks_total
    }

    pub fn cost(&self) -> u64 {
        self.cost
    }

    pub fn confidence(&self) -> Option<u16> {
        self.confidence
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    /// `None` only for the root, which was initialized rather than grown.
    pub parent: Option<NodeId>,
    pub commit: Oid,
    /// The repo holding `commit`: the tree's own repo for the root, the
    /// accepted's attempt repo for every node after it.
    pub repo: RepoName,
    /// The attempt this node was accepted from; `None` for the root and for
    /// a graft (`grafted_from`).
    #[serde(alias = "fruit_of")]
    pub accepted_from: Option<AttemptId>,
    /// Paths the accepted attempt changed against its parent; empty for the
    /// root and for a graft.
    #[serde(default)]
    pub touched: Vec<String>,
    /// Where a graft came from (`<remote>` or `<remote>#<branch>`): a commit
    /// made outside the tree, such as a mirror's `main`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grafted_from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskState {
    Open,
    #[serde(alias = "Fruited")]
    Done {
        #[serde(alias = "leaf")]
        attempt: AttemptId,
        node: NodeId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub intent: String,
    pub state: TaskState,
    /// What done means for this task, on top of the root's checks. They are
    /// never in the repo, so a attempt cannot touch them.
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
    /// Attempts an agent started over from a newer head.
    #[serde(default, alias = "regrowths")]
    pub retries: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttemptState {
    #[serde(alias = "Growing")]
    Working,
    /// Submitted at `commit` and frozen; the checks have not run yet.
    #[serde(alias = "Ripening")]
    Checking { commit: Oid },
    #[serde(alias = "Ripe")]
    Scored { commit: Oid, score: Score },
    #[serde(alias = "Fruit")]
    Accepted { node: NodeId },
    #[serde(alias = "Pruned")]
    Closed { reason: CloseReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CloseReason {
    /// Another attempt of the same task was accepted.
    #[serde(alias = "Outgrown")]
    Lost {
        #[serde(alias = "by")]
        to: AttemptId,
    },
    /// The head moved past this attempt's base and it was started again.
    #[serde(alias = "Regrown")]
    Retried { into: AttemptId },
    /// The head moved past this attempt's base and its commits were replayed
    /// onto the head, in `into`, without its agent.
    #[serde(alias = "Transplanted")]
    Rebased { into: AttemptId },
    /// The agent gave up, or the tree's owner cut it.
    #[serde(alias = "Withered")]
    Abandoned { note: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub id: AttemptId,
    #[serde(alias = "bud")]
    pub task: TaskId,
    pub agent: String,
    /// The node this attempt started from.
    pub base: NodeId,
    /// The attempt's own repo, forked from the base node's repo.
    pub repo: RepoName,
    pub state: AttemptState,
    /// Paths the attempt changed against its base, known once it is scored.
    #[serde(default)]
    pub touched: Vec<String>,
    /// The fresh attempt a rebase of this one is in flight into, if any.
    #[serde(default, alias = "transplant")]
    pub rebase: Option<AttemptId>,
    /// The behind attempt this one is a rebase of, if any.
    #[serde(default, alias = "transplant_of")]
    pub rebase_of: Option<AttemptId>,
}

/// A closed attempt, kept as context for the next attempt at its task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    #[serde(alias = "leaf")]
    pub attempt: AttemptId,
    #[serde(alias = "bud")]
    pub task: TaskId,
    pub agent: String,
    pub reason: CloseReason,
    /// `None` if the attempt was closed before it scored.
    pub score: Option<Score>,
}

/// What a accept changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Acceptance {
    pub node: NodeId,
    pub accepted: AttemptId,
    /// The task's other attempts, now in the history.
    pub closed: Vec<AttemptId>,
    /// Other tasks' live attempts whose base is no longer the head.
    pub behind: Vec<AttemptId>,
}

/// A behind attempt as the head sees it: what it would have to be replayed over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Behind {
    pub attempt: AttemptId,
    /// Nodes between the attempt's base and the head.
    pub behind: u32,
    /// Paths both the attempt and those nodes changed. Empty means the
    /// rebase is expected to apply cleanly.
    pub overlap: Vec<String>,
    /// The fresh attempt a rebase went into: still working while the
    /// replay runs, abandoned if it conflicted (then the agent retries).
    pub rebase: Option<AttemptId>,
}

/// Where an attempt stands in its task, as of now (`Tree::standings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Standing {
    /// Accepting the task now would take this attempt.
    Best,
    /// Passes every check, but another passing attempt is cheaper (or as
    /// cheap and the judges surer of it, or as sure and earlier).
    Outscored { by: AttemptId },
    /// Scored, and failed at least one check: it cannot be accepted.
    Failing {
        checks_passed: u32,
        checks_total: u32,
    },
    /// Started from a node that is no longer the head: it is rebased, or
    /// retried, before it can be accepted.
    Behind,
    /// Still being worked on.
    Working,
    /// Submitted; the checks are running.
    Checking,
    /// This attempt was accepted.
    Accepted { node: NodeId },
    /// Out of the running, for this reason.
    Closed { reason: CloseReason },
}

/// What moving the release pointer changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Release {
    pub node: NodeId,
    pub previous: Option<NodeId>,
    /// Whether `node` is older than `previous`.
    pub rollback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TreeError {
    #[error("not a git object id: {0:?}")]
    MalformedOid(String),
    #[error("not an Artifacts repo name: {0:?}")]
    MalformedRepoName(String),
    #[error("{checks_passed} of {checks_total} checks passed is not a score")]
    ImpossibleScore {
        checks_passed: u32,
        checks_total: u32,
    },
    #[error("an intent must say what the task is for")]
    EmptyIntent,
    #[error("no task {0:?}")]
    UnknownTask(TaskId),
    #[error("no attempt {0:?}")]
    UnknownAttempt(AttemptId),
    #[error("task {0:?} has already done")]
    TaskDone(TaskId),
    #[error("attempt {0:?} is no longer working")]
    NotGrowing(AttemptId),
    #[error("attempt {0:?} is not waiting for its checks")]
    NotChecking(AttemptId),
    #[error("attempt {0:?} is already accepted or closed")]
    NotOpen(AttemptId),
    #[error("attempt {0:?} grew from the head, so there is nothing to retry")]
    NotBehind(AttemptId),
    #[error("attempt {0:?} has no commit to rebase")]
    NothingToRebase(AttemptId),
    #[error("attempt {0:?} is already being rebased into {1:?}")]
    Rebaseing(AttemptId, AttemptId),
    #[error("attempt {0:?} is not a rebase in progress")]
    NotRebase(AttemptId),
    #[error("task {0:?} has no scored attempt on the head that passes every check")]
    NothingToAccept(TaskId),
    #[error("no task has a scored attempt on the head that passes every check")]
    NothingScored,
    #[error("task {0:?} has retried {1} times; its owner should split or abandon it")]
    TaskExhausted(TaskId, u32),
    #[error("task checks: {0}")]
    TaskChecks(#[from] ChecksError),
    #[error("no node {0:?}")]
    UnknownNode(NodeId),
    #[error("node id {0:?} was not reserved for a graft, or is taken")]
    NotReserved(NodeId),
    #[error("the tree has run out of ids")]
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tree {
    name: RepoName,
    head: NodeId,
    next_id: u32,
    nodes: BTreeMap<NodeId, Node>,
    #[serde(alias = "buds")]
    tasks: BTreeMap<TaskId, Task>,
    #[serde(alias = "leaves")]
    attempts: BTreeMap<AttemptId, Attempt>,
    #[serde(alias = "compost")]
    history: Vec<HistoryEntry>,
    /// The node a deployment should follow; `None` until the first release.
    #[serde(default)]
    released: Option<NodeId>,
}

impl Tree {
    /// A tree whose root is `commit`: the strict starting point every attempt
    /// grows from until the first acceptance.
    /// A tree is named by its root repo; attempt repos are named after it, so
    /// the name must leave room for the longest attempt suffix.
    pub fn init(name: RepoName, commit: Oid) -> Result<Self, TreeError> {
        let longest_attempt = format!("{}-a{}", name.as_str(), u32::MAX);
        RepoName::try_from(longest_attempt)
            .map_err(|_| TreeError::MalformedRepoName(name.as_str().to_owned()))?;
        let root = NodeId(0);
        let node = Node {
            id: root,
            parent: None,
            commit,
            repo: name.clone(),
            accepted_from: None,
            touched: Vec::new(),
            grafted_from: None,
        };
        Ok(Self {
            name,
            head: root,
            next_id: 1,
            nodes: BTreeMap::from([(root, node)]),
            tasks: BTreeMap::new(),
            attempts: BTreeMap::new(),
            history: Vec::new(),
            released: None,
        })
    }

    pub fn name(&self) -> &RepoName {
        &self.name
    }

    pub fn head(&self) -> &Node {
        self.nodes.get(&self.head).expect(
            "head always names a node: only accept moves it, and only to a node it just inserted",
        )
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn task(&self, id: TaskId) -> Option<&Task> {
        self.tasks.get(&id)
    }

    pub fn attempt(&self, id: AttemptId) -> Option<&Attempt> {
        self.attempts.get(&id)
    }

    pub fn attempts_of(&self, task: TaskId) -> impl Iterator<Item = &Attempt> {
        self.attempts
            .values()
            .filter(move |attempt| attempt.task == task)
    }

    /// Every closed attempt of `task`, oldest first.
    pub fn history_of(&self, task: TaskId) -> impl Iterator<Item = &HistoryEntry> {
        self.history.iter().filter(move |entry| entry.task == task)
    }

    /// Whether `attempt` is live but grew from a node that is no longer the head.
    pub fn is_behind(&self, attempt: &Attempt) -> bool {
        is_open(&attempt.state) && attempt.base != self.head
    }

    /// The nodes from the head back to the root, newest first.
    pub fn trunk(&self) -> impl Iterator<Item = &Node> {
        std::iter::successors(Some(self.head()), |node| {
            node.parent.map(|parent| {
                self.nodes
                    .get(&parent)
                    .expect("a node's parent is a node of its tree")
            })
        })
    }

    /// How far behind the head `attempt` is, and where its diff meets what the
    /// head gained meanwhile. `None` if the attempt is not behind.
    pub fn behind(&self, attempt: &Attempt) -> Option<Behind> {
        if !self.is_behind(attempt) {
            return None;
        }
        let mut behind = 0;
        let mut gained = BTreeSet::new();
        for node in self.trunk().take_while(|node| node.id != attempt.base) {
            behind += 1;
            gained.extend(node.touched.iter().map(String::as_str));
        }
        let overlap = attempt
            .touched
            .iter()
            .filter(|path| gained.contains(path.as_str()))
            .cloned()
            .collect();
        Some(Behind {
            attempt: attempt.id,
            behind,
            overlap,
            rebase: attempt.rebase,
        })
    }

    /// Every behind attempt, oldest first.
    pub fn all_behind(&self) -> impl Iterator<Item = Behind> {
        self.attempts
            .values()
            .filter_map(|attempt| self.behind(attempt))
    }

    /// A task with `checks` of its own on top of the root's. The intent says
    /// what the task is for; the checks say when it is done.
    pub fn task_new(
        &mut self,
        intent: impl Into<String>,
        checks: Vec<CheckSpec>,
    ) -> Result<TaskId, TreeError> {
        let intent = intent.into();
        if intent.trim().is_empty() {
            return Err(TreeError::EmptyIntent);
        }
        validate_checks(&checks)?;
        let id = TaskId(self.take_id()?);
        self.tasks.insert(
            id,
            Task {
                id,
                intent,
                state: TaskState::Open,
                checks,
                retries: 0,
            },
        );
        Ok(id)
    }

    /// Open tasks, oldest first.
    pub fn open_tasks(&self) -> impl Iterator<Item = &Task> {
        self.tasks
            .values()
            .filter(|task| matches!(task.state, TaskState::Open))
    }

    /// Start a attempt for `task` from the current head.
    pub fn start(
        &mut self,
        task: TaskId,
        agent: impl Into<String>,
    ) -> Result<AttemptId, TreeError> {
        self.open_task(task)?;
        let id = AttemptId(self.take_id()?);
        let repo = RepoName::try_from(format!("{}-a{}", self.name.as_str(), id.0))
            .expect("init checked that the tree name attempts room for any attempt suffix");
        let attempt = Attempt {
            id,
            task,
            agent: agent.into(),
            base: self.head,
            repo,
            state: AttemptState::Working,
            touched: Vec::new(),
            rebase: None,
            rebase_of: None,
        };
        self.attempts.insert(id, attempt);
        Ok(id)
    }

    /// Record that `attempt` finished working at `commit`. Its checks run next.
    pub fn submit(&mut self, attempt: AttemptId, commit: Oid) -> Result<(), TreeError> {
        let entry = self
            .attempts
            .get_mut(&attempt)
            .ok_or(TreeError::UnknownAttempt(attempt))?;
        match entry.state {
            AttemptState::Working => {
                entry.state = AttemptState::Checking { commit };
                Ok(())
            }
            AttemptState::Checking { .. }
            | AttemptState::Scored { .. }
            | AttemptState::Accepted { .. }
            | AttemptState::Closed { .. } => Err(TreeError::NotGrowing(attempt)),
        }
    }

    /// Record how the checks scored a submitted attempt, and the paths it
    /// changed against its base.
    pub fn scored(
        &mut self,
        attempt: AttemptId,
        score: Score,
        touched: Vec<String>,
    ) -> Result<(), TreeError> {
        let entry = self
            .attempts
            .get_mut(&attempt)
            .ok_or(TreeError::UnknownAttempt(attempt))?;
        match &entry.state {
            AttemptState::Checking { commit } => {
                entry.state = AttemptState::Scored {
                    commit: commit.clone(),
                    score,
                };
                entry.touched = touched;
                Ok(())
            }
            AttemptState::Working
            | AttemptState::Scored { .. }
            | AttemptState::Accepted { .. }
            | AttemptState::Closed { .. } => Err(TreeError::NotChecking(attempt)),
        }
    }

    /// Attempts waiting for their checks, with the commit each was submitted at.
    pub fn checking(&self) -> impl Iterator<Item = (&Attempt, &Oid)> {
        self.attempts
            .values()
            .filter_map(|attempt| match &attempt.state {
                AttemptState::Checking { commit } => Some((attempt, commit)),
                AttemptState::Working
                | AttemptState::Scored { .. }
                | AttemptState::Accepted { .. }
                | AttemptState::Closed { .. } => None,
            })
    }

    /// Cut a live attempt, for example because its agent gave up.
    pub fn abandon(
        &mut self,
        attempt: AttemptId,
        note: impl Into<String>,
    ) -> Result<(), TreeError> {
        self.close(attempt, CloseReason::Abandoned { note: note.into() })
    }

    /// Start `behind` again from the head: same task, same agent. The old attempt
    /// goes to the history, which is what the new attempt should read first.
    /// A task retries at most [`MAX_RETRIES`] times.
    pub fn retry(&mut self, behind: AttemptId) -> Result<AttemptId, TreeError> {
        let old = self
            .attempts
            .get(&behind)
            .ok_or(TreeError::UnknownAttempt(behind))?;
        if !is_open(&old.state) {
            return Err(TreeError::NotOpen(behind));
        }
        if old.base == self.head {
            return Err(TreeError::NotBehind(behind));
        }
        if let Some(into) = self.rebase_in_flight(old) {
            return Err(TreeError::Rebaseing(behind, into));
        }
        let (task, agent) = (old.task, old.agent.clone());
        let retries = self
            .tasks
            .get(&task)
            .expect("a attempt's task is in its tree")
            .retries;
        if retries >= MAX_RETRIES {
            return Err(TreeError::TaskExhausted(task, retries));
        }
        let fresh = self.start(task, agent)?;
        self.close(behind, CloseReason::Retried { into: fresh })?;
        self.tasks.get_mut(&task).expect("checked above").retries = retries + 1;
        Ok(fresh)
    }

    /// Behind attempts with a commit to replay that no rebase has been
    /// tried on. A conflicted one keeps pointing at its abandoned rebase,
    /// so the machine does not try again: that is the agent's turn.
    pub fn rebaseable(&self) -> impl Iterator<Item = &Attempt> {
        self.attempts.values().filter(|attempt| {
            self.is_behind(attempt) && attempt.rebase.is_none() && attempt_commit(attempt).is_some()
        })
    }

    /// The fresh attempt `behind` is being rebased into right now.
    fn rebase_in_flight(&self, behind: &Attempt) -> Option<AttemptId> {
        behind.rebase.filter(|into| {
            self.attempts
                .get(into)
                .is_some_and(|fresh| is_open(&fresh.state))
        })
    }

    /// Begin replaying `behind`'s commits onto the head: a fresh attempt of the
    /// same task and agent, working from the head, that the machine fills.
    /// Returns the fresh attempt and the commit to replay.
    pub fn rebase_start(&mut self, behind: AttemptId) -> Result<(AttemptId, Oid), TreeError> {
        let old = self
            .attempts
            .get(&behind)
            .ok_or(TreeError::UnknownAttempt(behind))?;
        if !is_open(&old.state) {
            return Err(TreeError::NotOpen(behind));
        }
        if old.base == self.head {
            return Err(TreeError::NotBehind(behind));
        }
        if let Some(into) = self.rebase_in_flight(old) {
            return Err(TreeError::Rebaseing(behind, into));
        }
        let commit = attempt_commit(old)
            .cloned()
            .ok_or(TreeError::NothingToRebase(behind))?;
        let (task, agent) = (old.task, old.agent.clone());
        let fresh = self.start(task, agent)?;
        self.attempts
            .get_mut(&fresh)
            .expect("just started")
            .rebase_of = Some(behind);
        self.attempts
            .get_mut(&behind)
            .expect("looked up above")
            .rebase = Some(fresh);
        Ok((fresh, commit))
    }

    /// The replay landed at `commit` in the fresh attempt: submit it for its
    /// checks and history the behind one.
    pub fn rebase_done(&mut self, fresh: AttemptId, commit: Oid) -> Result<(), TreeError> {
        let behind = self.rebase_source(fresh)?;
        self.submit(fresh, commit)?;
        self.attempts
            .get_mut(&fresh)
            .expect("rebase_source found it")
            .rebase_of = None;
        if self
            .attempts
            .get(&behind)
            .is_some_and(|old| is_open(&old.state))
        {
            self.close(behind, CloseReason::Rebased { into: fresh })?;
        }
        Ok(())
    }

    /// The replay did not apply: the fresh attempt abandons with `note` and the
    /// behind one stays live, still pointing at it, for its agent to retry.
    /// The machine does not try this attempt again.
    pub fn rebase_failed(
        &mut self,
        fresh: AttemptId,
        note: impl Into<String>,
    ) -> Result<(), TreeError> {
        self.rebase_source(fresh)?;
        self.close(fresh, CloseReason::Abandoned { note: note.into() })
    }

    /// The replay could not be run (the sandbox's fault, not the attempt's):
    /// the fresh attempt abandons with `note` and the behind one is offered to
    /// the machine again.
    pub fn rebase_retry(
        &mut self,
        fresh: AttemptId,
        note: impl Into<String>,
    ) -> Result<(), TreeError> {
        let behind = self.rebase_source(fresh)?;
        self.close(fresh, CloseReason::Abandoned { note: note.into() })?;
        if let Some(old) = self.attempts.get_mut(&behind) {
            old.rebase = None;
        }
        Ok(())
    }

    fn rebase_source(&self, fresh: AttemptId) -> Result<AttemptId, TreeError> {
        let entry = self
            .attempts
            .get(&fresh)
            .ok_or(TreeError::UnknownAttempt(fresh))?;
        match (&entry.state, entry.rebase_of) {
            (AttemptState::Working, Some(behind)) => Ok(behind),
            _ => Err(TreeError::NotRebase(fresh)),
        }
    }

    /// Take a node id and repo name for an outside commit about to be
    /// grafted: the import into `<tree>-g<id>` takes a while, and nothing
    /// started meanwhile may take the name.
    pub fn reserve_graft(&mut self) -> Result<(NodeId, RepoName), TreeError> {
        let id = self.take_id()?;
        let repo = RepoName::try_from(format!("{}-g{id}", self.name.as_str()))
            .expect("init checked that the tree name leaves room for any id suffix");
        Ok((NodeId(id), repo))
    }

    /// Make `commit`, imported into `repo` under a reserved `node`, the new
    /// head on top of the current one. Every open attempt is then behind:
    /// the machine rebases the submitted ones, as after an acceptance.
    pub fn graft(
        &mut self,
        node: NodeId,
        commit: Oid,
        repo: RepoName,
        source: impl Into<String>,
    ) -> Result<(), TreeError> {
        if node.0 >= self.next_id || self.nodes.contains_key(&node) {
            return Err(TreeError::NotReserved(node));
        }
        self.nodes.insert(
            node,
            Node {
                id: node,
                parent: Some(self.head),
                commit,
                repo,
                accepted_from: None,
                touched: Vec::new(),
                grafted_from: Some(source.into()),
            },
        );
        self.head = node;
        Ok(())
    }

    /// Where a deployment should be, if a release has been made.
    pub fn released(&self) -> Option<&Node> {
        self.released.map(|id| {
            self.nodes
                .get(&id)
                .expect("release only points at nodes of this tree")
        })
    }

    /// Point the release at `node`. Any node will do: pointing at an older
    /// one is a rollback, and costs the same.
    pub fn release(&mut self, node: NodeId) -> Result<Release, TreeError> {
        if !self.nodes.contains_key(&node) {
            return Err(TreeError::UnknownNode(node));
        }
        let previous = self.released.replace(node);
        Ok(Release {
            node,
            previous,
            rollback: previous.is_some_and(|previous| node < previous),
        })
    }

    /// Open tasks with a acceptable attempt, oldest first.
    pub fn acceptable(&self) -> impl Iterator<Item = TaskId> {
        self.open_tasks()
            .filter(|task| self.best_attempt(task.id).is_some())
            .map(|task| task.id)
    }

    /// Acceptance the oldest task that can be, so no task starves.
    pub fn accept_next(&mut self) -> Result<Acceptance, TreeError> {
        let task = self.acceptable().next().ok_or(TreeError::NothingScored)?;
        self.accept(task)
    }

    /// Where each of `task`'s attempts stands if the task were accepted now,
    /// in attempt order: what a person deciding whether to accept needs. The
    /// best one is `best_attempt`'s, so this and `accept` cannot disagree.
    pub fn standings(&self, task: TaskId) -> Result<Vec<(AttemptId, Standing)>, TreeError> {
        self.tasks.get(&task).ok_or(TreeError::UnknownTask(task))?;
        let best = self.best_attempt(task).map(|attempt| attempt.id);
        Ok(self
            .attempts_of(task)
            .map(|attempt| {
                let standing = match &attempt.state {
                    AttemptState::Accepted { node } => Standing::Accepted { node: *node },
                    AttemptState::Closed { reason } => Standing::Closed {
                        reason: reason.clone(),
                    },
                    _ if self.is_behind(attempt) => Standing::Behind,
                    AttemptState::Working => Standing::Working,
                    AttemptState::Checking { .. } => Standing::Checking,
                    AttemptState::Scored { score, .. } if !score.passes() => Standing::Failing {
                        checks_passed: score.checks_passed(),
                        checks_total: score.checks_total(),
                    },
                    AttemptState::Scored { .. } => match best {
                        Some(by) if by != attempt.id => Standing::Outscored { by },
                        Some(_) | None => Standing::Best,
                    },
                };
                (attempt.id, standing)
            })
            .collect())
    }

    /// The attempt `accept` would pick for `task`: scored on the head, passing
    /// every check, cheapest; on equal cost the one the judges were surest
    /// of, then the earliest.
    fn best_attempt(&self, task: TaskId) -> Option<&Attempt> {
        self.attempts_of(task)
            .filter(|attempt| attempt.base == self.head)
            .filter_map(|attempt| match &attempt.state {
                AttemptState::Scored { score, .. } if score.passes() => Some((attempt, *score)),
                AttemptState::Scored { .. }
                | AttemptState::Working
                | AttemptState::Checking { .. }
                | AttemptState::Accepted { .. }
                | AttemptState::Closed { .. } => None,
            })
            .min_by_key(|&(attempt, score)| {
                let surest = std::cmp::Reverse(score.confidence().unwrap_or(0));
                (score.cost(), surest, attempt.id)
            })
            .map(|(attempt, _)| attempt)
    }

    /// Turn the best scored attempt of `task` into accepted and move the head onto it.
    ///
    /// Only attempts that grew from the head are candidates: anything older was
    /// checked against a tree that no longer exists. The winner passes every
    /// check and has the lowest cost; on equal cost the one the judges were
    /// surest of, then the earliest attempt.
    pub fn accept(&mut self, task: TaskId) -> Result<Acceptance, TreeError> {
        self.open_task(task)?;
        let (accepted, commit, repo, touched) = self
            .best_attempt(task)
            .map(|attempt| {
                let commit = attempt_commit(attempt)
                    .cloned()
                    .expect("best_attempt only picks scored attempts, which have a commit");
                (
                    attempt.id,
                    commit,
                    attempt.repo.clone(),
                    attempt.touched.clone(),
                )
            })
            .ok_or(TreeError::NothingToAccept(task))?;

        let node = NodeId(self.take_id()?);
        self.nodes.insert(
            node,
            Node {
                id: node,
                parent: Some(self.head),
                commit,
                repo,
                accepted_from: Some(accepted),
                touched,
                grafted_from: None,
            },
        );
        self.head = node;

        let accepted_attempt = self
            .attempts
            .get_mut(&accepted)
            .expect("accepted was chosen from this map above");
        accepted_attempt.state = AttemptState::Accepted { node };
        let task_entry = self
            .tasks
            .get_mut(&task)
            .expect("open_task confirmed the task exists");
        task_entry.state = TaskState::Done {
            attempt: accepted,
            node,
        };

        let siblings: Vec<AttemptId> = self
            .attempts_of(task)
            .filter(|attempt| is_open(&attempt.state))
            .map(|attempt| attempt.id)
            .collect();
        for &sibling in &siblings {
            self.close(sibling, CloseReason::Lost { to: accepted })?;
        }

        let behind = self
            .attempts
            .values()
            .filter(|attempt| self.is_behind(attempt))
            .map(|attempt| attempt.id)
            .collect();
        Ok(Acceptance {
            node,
            accepted,
            closed: siblings,
            behind,
        })
    }

    fn open_task(&self, task: TaskId) -> Result<(), TreeError> {
        match self
            .tasks
            .get(&task)
            .ok_or(TreeError::UnknownTask(task))?
            .state
        {
            TaskState::Open => Ok(()),
            TaskState::Done { .. } => Err(TreeError::TaskDone(task)),
        }
    }

    fn close(&mut self, attempt: AttemptId, reason: CloseReason) -> Result<(), TreeError> {
        let entry = self
            .attempts
            .get_mut(&attempt)
            .ok_or(TreeError::UnknownAttempt(attempt))?;
        let score = match &entry.state {
            AttemptState::Working | AttemptState::Checking { .. } => None,
            AttemptState::Scored { score, .. } => Some(*score),
            AttemptState::Accepted { .. } | AttemptState::Closed { .. } => {
                return Err(TreeError::NotOpen(attempt));
            }
        };
        entry.state = AttemptState::Closed {
            reason: reason.clone(),
        };
        self.history.push(HistoryEntry {
            attempt,
            task: entry.task,
            agent: entry.agent.clone(),
            reason,
            score,
        });
        Ok(())
    }

    fn take_id(&mut self) -> Result<u32, TreeError> {
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(TreeError::Full)?;
        Ok(id)
    }
}

fn is_open(state: &AttemptState) -> bool {
    match state {
        AttemptState::Working | AttemptState::Checking { .. } | AttemptState::Scored { .. } => true,
        AttemptState::Accepted { .. } | AttemptState::Closed { .. } => false,
    }
}

/// The commit a live attempt was submitted at, once it has one.
fn attempt_commit(attempt: &Attempt) -> Option<&Oid> {
    match &attempt.state {
        AttemptState::Checking { commit } | AttemptState::Scored { commit, .. } => Some(commit),
        AttemptState::Working | AttemptState::Accepted { .. } | AttemptState::Closed { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(digit: char) -> Oid {
        Oid::try_from(digit.to_string().repeat(40))
            .expect("40 copies of a hex digit is a SHA-1 oid")
    }

    fn repo(name: &str) -> RepoName {
        RepoName::try_from(name.to_owned()).expect("test repo names are well formed")
    }

    /// Submit and score in one step, as the scorer would.
    fn scored(tree: &mut Tree, attempt: AttemptId, commit: Oid, score: Score) {
        tree.submit(attempt, commit).unwrap();
        tree.scored(attempt, score, vec![]).unwrap();
    }

    fn passing(cost: u64) -> Score {
        Score::new(3, 3, cost).expect("3 of 3 is a valid score")
    }

    #[test]
    fn standings_say_which_attempt_accept_would_take_and_why_not_the_rest() {
        let mut tree = Tree::init(repo("t-site"), oid('a')).unwrap();
        let task = tree.task_new("fix slugify", vec![]).unwrap();
        let [costly, cheap, failing, working, checking] =
            ["alpha", "beta", "cheater", "gamma", "delta"]
                .map(|agent| tree.start(task, agent).unwrap());
        scored(&mut tree, costly, oid('b'), passing(12));
        scored(&mut tree, cheap, oid('c'), passing(2));
        scored(&mut tree, failing, oid('d'), Score::new(1, 3, 1).unwrap());
        tree.submit(checking, oid('e')).unwrap();

        assert_eq!(
            tree.standings(task).unwrap(),
            vec![
                (costly, Standing::Outscored { by: cheap }),
                (cheap, Standing::Best),
                (
                    failing,
                    Standing::Failing {
                        checks_passed: 1,
                        checks_total: 3
                    }
                ),
                (working, Standing::Working),
                (checking, Standing::Checking),
            ]
        );

        // The standings' best is the acceptance's: one rule.
        let acceptance = tree.accept(task).unwrap();
        assert_eq!(acceptance.accepted, cheap);
        assert!(matches!(
            tree.standings(task).unwrap().as_slice(),
            [
                (_, Standing::Closed { .. }),
                (_, Standing::Accepted { .. }),
                ..
            ]
        ));
    }

    #[test]
    fn an_attempt_of_another_task_started_from_an_old_head_stands_behind() {
        let mut tree = Tree::init(repo("t-site"), oid('a')).unwrap();
        let first = tree.task_new("first", vec![]).unwrap();
        let second = tree.task_new("second", vec![]).unwrap();
        let accepted = tree.start(first, "alpha").unwrap();
        let behind = tree.start(second, "beta").unwrap();
        scored(&mut tree, accepted, oid('b'), passing(1));
        scored(&mut tree, behind, oid('c'), passing(1));
        tree.accept(first).unwrap();

        assert_eq!(
            tree.standings(second).unwrap(),
            vec![(behind, Standing::Behind)]
        );
        assert_eq!(
            tree.standings(TaskId(99)),
            Err(TreeError::UnknownTask(TaskId(99)))
        );
    }

    #[test]
    fn a_graft_becomes_the_head_and_leaves_open_attempts_behind() {
        let mut tree = Tree::init(repo("t-site"), oid('a')).unwrap();
        let task = tree.task_new("fix it", vec![]).unwrap();
        let submitted = tree.start(task, "alpha").unwrap();
        scored(&mut tree, submitted, oid('b'), passing(1));

        let (node, graft_repo) = tree.reserve_graft().unwrap();
        assert_eq!(graft_repo.as_str(), format!("t-site-g{}", node.0));
        // An attempt started while the import runs takes another id.
        let meanwhile = tree.start(task, "beta").unwrap();
        assert_ne!(meanwhile.0, node.0);

        tree.graft(
            node,
            oid('c'),
            graft_repo.clone(),
            "https://github.com/o/r#main",
        )
        .unwrap();
        let head = tree.head();
        assert_eq!(
            (head.id, &head.commit, &head.repo),
            (node, &oid('c'), &graft_repo)
        );
        assert_eq!(head.parent, Some(NodeId(0)));
        assert_eq!(
            head.grafted_from.as_deref(),
            Some("https://github.com/o/r#main")
        );

        // Nothing accepts from the old head; the submitted attempt gets rebased.
        assert_eq!(tree.accept(task), Err(TreeError::NothingToAccept(task)));
        assert_eq!(
            tree.rebaseable()
                .map(|attempt| attempt.id)
                .collect::<Vec<_>>(),
            vec![submitted]
        );

        // A reservation is used once, and only a reservation can be used.
        assert_eq!(
            tree.graft(node, oid('d'), graft_repo.clone(), "again"),
            Err(TreeError::NotReserved(node))
        );
        assert_eq!(
            tree.graft(NodeId(999), oid('d'), graft_repo, "never reserved"),
            Err(TreeError::NotReserved(NodeId(999)))
        );
    }

    #[test]
    fn oid_rejects_anything_but_lowercase_hex_of_hash_length() {
        assert!(Oid::try_from("a".repeat(40)).is_ok());
        assert!(Oid::try_from("a".repeat(64)).is_ok());
        assert_eq!(
            Oid::try_from("A".repeat(40)),
            Err(TreeError::MalformedOid("A".repeat(40)))
        );
        assert!(Oid::try_from("a".repeat(39)).is_err());
        assert!(Oid::try_from("g".repeat(40)).is_err());
    }

    #[test]
    fn score_rejects_more_passes_than_checks() {
        assert_eq!(
            Score::new(4, 3, 0),
            Err(TreeError::ImpossibleScore {
                checks_passed: 4,
                checks_total: 3
            })
        );
        assert!(Score::new(0, 0, 0).is_err());
        assert!(!Score::new(2, 3, 0).expect("2 of 3 is valid").passes());
    }

    #[test]
    fn on_equal_cost_accept_takes_the_attempt_the_judges_were_surest_of() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("add a /health route", vec![]).unwrap();
        let first = tree.start(task, "agent-a").unwrap();
        let surer = tree.start(task, "agent-b").unwrap();
        let cheaper_but_doubted = tree.start(task, "agent-c").unwrap();
        scored(&mut tree, first, oid('a'), passing(10).judged(600));
        scored(&mut tree, surer, oid('b'), passing(10).judged(900));
        scored(
            &mut tree,
            cheaper_but_doubted,
            oid('c'),
            passing(9).judged(510),
        );

        assert_eq!(tree.accept(task).unwrap().accepted, cheaper_but_doubted);

        let task = tree.task_new("add a /ready route", vec![]).unwrap();
        let first = tree.start(task, "agent-a").unwrap();
        let surer = tree.start(task, "agent-b").unwrap();
        scored(&mut tree, first, oid('d'), passing(10).judged(600));
        scored(&mut tree, surer, oid('e'), passing(10).judged(900));

        assert_eq!(tree.accept(task).unwrap().accepted, surer);
    }

    #[test]
    fn a_score_stored_before_judges_reads_back_unjudged() {
        let stored: Score =
            serde_json::from_str(r#"{"checks_passed":3,"checks_total":3,"cost":7}"#).unwrap();
        assert_eq!(stored, passing(7));
        assert_eq!(passing(7).judged(2000).confidence(), Some(1000));
    }

    #[test]
    fn accept_takes_the_cheapest_passing_attempt_and_closes_the_rest() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let root = tree.head().id;
        let task = tree.task_new("add a /health route", vec![]).unwrap();
        let costly = tree.start(task, "agent-a").unwrap();
        let cheap = tree.start(task, "agent-b").unwrap();
        let failing = tree.start(task, "agent-c").unwrap();
        let unfinished = tree.start(task, "agent-d").unwrap();
        scored(&mut tree, costly, oid('a'), passing(900));
        scored(&mut tree, cheap, oid('b'), passing(120));
        scored(&mut tree, failing, oid('c'), Score::new(2, 3, 1).unwrap());

        let acceptance = tree.accept(task).unwrap();

        assert_eq!(acceptance.accepted, cheap);
        assert_eq!(acceptance.closed, vec![costly, failing, unfinished]);
        assert!(acceptance.behind.is_empty());
        let head = tree.head();
        assert_eq!(
            (head.id, head.parent, &head.commit, head.accepted_from),
            (acceptance.node, Some(root), &oid('b'), Some(cheap))
        );
        assert_eq!(
            tree.task(task).unwrap().state,
            TaskState::Done {
                attempt: cheap,
                node: acceptance.node
            }
        );
        assert_eq!(head.repo, repo(&format!("t-a{}", cheap.0)));
        assert_eq!(
            tree.attempt(cheap).unwrap().state,
            AttemptState::Accepted {
                node: acceptance.node
            }
        );

        let reasons: Vec<_> = tree
            .history_of(task)
            .map(|c| (c.attempt, c.reason.clone(), c.score))
            .collect();
        assert_eq!(
            reasons,
            vec![
                (costly, CloseReason::Lost { to: cheap }, Some(passing(900))),
                (
                    failing,
                    CloseReason::Lost { to: cheap },
                    Some(Score::new(2, 3, 1).unwrap())
                ),
                (unfinished, CloseReason::Lost { to: cheap }, None),
            ]
        );
    }

    #[test]
    fn equal_cost_goes_to_the_earliest_attempt() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("intent", vec![]).unwrap();
        let first = tree.start(task, "a").unwrap();
        let second = tree.start(task, "b").unwrap();
        scored(&mut tree, second, oid('b'), passing(5));
        scored(&mut tree, first, oid('a'), passing(5));
        assert_eq!(tree.accept(task).unwrap().accepted, first);
    }

    #[test]
    fn nothing_to_accept_without_a_passing_scored_attempt() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        assert_eq!(tree.accept(task), Err(TreeError::NothingToAccept(task)));
        scored(&mut tree, attempt, oid('a'), Score::new(0, 1, 0).unwrap());
        assert_eq!(tree.accept(task), Err(TreeError::NothingToAccept(task)));
        assert_eq!(tree.head().id, NodeId(0));
    }

    #[test]
    fn a_accept_makes_other_tasks_behind_and_they_retry_instead_of_merging() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let auth = tree.task_new("add auth", vec![]).unwrap();
        let search = tree.task_new("add search", vec![]).unwrap();
        let auth_leaf = tree.start(auth, "a").unwrap();
        let search_leaf = tree.start(search, "b").unwrap();
        scored(&mut tree, auth_leaf, oid('a'), passing(1));
        scored(&mut tree, search_leaf, oid('b'), passing(1));

        let acceptance = tree.accept(auth).unwrap();
        assert_eq!(acceptance.behind, vec![search_leaf]);

        // Scored and passing, but checked against the old root: not acceptable.
        assert_eq!(tree.accept(search), Err(TreeError::NothingToAccept(search)));

        let retried = tree.retry(search_leaf).unwrap();
        let fresh = tree.attempt(retried).unwrap();
        assert_eq!(
            (fresh.task, fresh.agent.as_str(), fresh.base, &fresh.state),
            (search, "b", acceptance.node, &AttemptState::Working)
        );
        let history: Vec<_> = tree
            .history_of(search)
            .map(|c| (c.attempt, c.reason.clone()))
            .collect();
        assert_eq!(
            history,
            vec![(search_leaf, CloseReason::Retried { into: retried })]
        );

        scored(&mut tree, retried, oid('c'), passing(1));
        let second = tree.accept(search).unwrap();
        assert_eq!(
            tree.node(second.node).unwrap().parent,
            Some(acceptance.node)
        );
    }

    #[test]
    fn retry_refuses_a_attempt_that_is_on_the_head() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        assert_eq!(tree.retry(attempt), Err(TreeError::NotBehind(attempt)));
    }

    #[test]
    fn a_fruited_task_takes_no_more_attempts() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        scored(&mut tree, attempt, oid('a'), passing(1));
        tree.accept(task).unwrap();
        assert_eq!(tree.start(task, "late"), Err(TreeError::TaskDone(task)));
        assert_eq!(tree.accept(task), Err(TreeError::TaskDone(task)));
    }

    #[test]
    fn an_attempt_scores_once_and_abandons_into_the_history() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        tree.submit(attempt, oid('a')).unwrap();
        assert_eq!(
            tree.submit(attempt, oid('b')),
            Err(TreeError::NotGrowing(attempt))
        );
        tree.scored(attempt, passing(1), vec![]).unwrap();
        assert_eq!(
            tree.scored(attempt, passing(0), vec![]),
            Err(TreeError::NotChecking(attempt))
        );
        tree.abandon(attempt, "lost interest").unwrap();
        assert_eq!(
            tree.abandon(attempt, "again"),
            Err(TreeError::NotOpen(attempt))
        );
        let entry = tree.history_of(task).next().unwrap();
        assert_eq!(
            (&entry.reason, entry.score),
            (
                &CloseReason::Abandoned {
                    note: "lost interest".into()
                },
                Some(passing(1))
            )
        );
    }

    #[test]
    fn a_submitted_attempt_waits_for_its_checks_and_cannot_be_accepted_yet() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        assert_eq!(
            tree.scored(attempt, passing(1), vec![]),
            Err(TreeError::NotChecking(attempt))
        );
        tree.submit(attempt, oid('a')).unwrap();
        let waiting: Vec<_> = tree.checking().map(|(l, c)| (l.id, c.clone())).collect();
        assert_eq!(waiting, vec![(attempt, oid('a'))]);
        assert_eq!(tree.accept(task), Err(TreeError::NothingToAccept(task)));
        tree.scored(attempt, passing(1), vec![]).unwrap();
        assert_eq!(tree.checking().count(), 0);
        assert_eq!(tree.accept(task).unwrap().accepted, attempt);
    }

    #[test]
    fn empty_intent_is_refused() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        assert_eq!(tree.task_new("  ", vec![]), Err(TreeError::EmptyIntent));
    }

    #[test]
    fn attempts_get_their_own_repo_and_accept_hands_it_to_the_node() {
        let mut tree = Tree::init(repo("site"), oid('0')).unwrap();
        assert_eq!(tree.head().repo, repo("site"));
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        assert_eq!(
            tree.attempt(attempt).unwrap().repo,
            repo(&format!("site-a{}", attempt.0))
        );
        scored(&mut tree, attempt, oid('a'), passing(1));
        let acceptance = tree.accept(task).unwrap();
        assert_eq!(
            tree.node(acceptance.node).unwrap().repo,
            tree.attempt(attempt).unwrap().repo
        );
    }

    #[test]
    fn repo_names_follow_artifacts_rules_and_leave_room_for_attempts() {
        assert!(RepoName::try_from("my_repo-1.0".to_owned()).is_ok());
        assert!(RepoName::try_from(String::new()).is_err());
        assert!(RepoName::try_from("has space".to_owned()).is_err());
        assert!(RepoName::try_from("a".repeat(64)).is_err());
        let long = repo(&"a".repeat(60));
        assert_eq!(
            Tree::init(long, oid('0')),
            Err(TreeError::MalformedRepoName("a".repeat(60)))
        );
    }

    #[test]
    fn the_tree_round_trips_through_json() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        scored(&mut tree, attempt, oid('a'), passing(1));
        let json = serde_json::to_string(&tree).unwrap();
        assert_eq!(serde_json::from_str::<Tree>(&json).unwrap(), tree);
        let bad = json.replace(&"0".repeat(40), "not-an-oid");
        assert!(serde_json::from_str::<Tree>(&bad).is_err());
    }

    /// Submit and score with the paths the attempt touched.
    fn scored_touching(tree: &mut Tree, attempt: AttemptId, commit: Oid, touched: &[&str]) {
        tree.submit(attempt, commit).unwrap();
        tree.scored(
            attempt,
            passing(1),
            touched.iter().map(|path| (*path).to_owned()).collect(),
        )
        .unwrap();
    }

    #[test]
    fn a_behind_attempt_is_rebased_onto_the_head_without_its_agent() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let auth = tree.task_new("add auth", vec![]).unwrap();
        let search = tree.task_new("add search", vec![]).unwrap();
        let auth_leaf = tree.start(auth, "a").unwrap();
        let search_leaf = tree.start(search, "b").unwrap();
        scored_touching(&mut tree, auth_leaf, oid('a'), &["auth.rs"]);
        scored_touching(&mut tree, search_leaf, oid('b'), &["search.rs"]);
        let first = tree.accept(auth).unwrap();

        // Disjoint paths: the head sees nothing in the way.
        let behind: Vec<_> = tree.all_behind().collect();
        assert_eq!(
            behind,
            vec![Behind {
                attempt: search_leaf,
                behind: 1,
                overlap: vec![],
                rebase: None,
            }]
        );
        assert_eq!(
            tree.rebaseable().map(|l| l.id).collect::<Vec<_>>(),
            vec![search_leaf]
        );

        let (fresh, commit) = tree.rebase_start(search_leaf).unwrap();
        assert_eq!(commit, oid('b'));
        let fresh_leaf = tree.attempt(fresh).unwrap();
        assert_eq!(
            (
                fresh_leaf.task,
                fresh_leaf.agent.as_str(),
                fresh_leaf.base,
                fresh_leaf.rebase_of
            ),
            (search, "b", first.node, Some(search_leaf))
        );
        // In flight: not offered again, and not for an agent to retry either.
        assert_eq!(tree.rebaseable().count(), 0);
        assert_eq!(
            tree.retry(search_leaf),
            Err(TreeError::Rebaseing(search_leaf, fresh))
        );
        assert_eq!(
            tree.rebase_start(search_leaf),
            Err(TreeError::Rebaseing(search_leaf, fresh))
        );

        tree.rebase_done(fresh, oid('c')).unwrap();
        assert_eq!(
            tree.attempt(fresh).unwrap().state,
            AttemptState::Checking { commit: oid('c') }
        );
        assert_eq!(
            tree.attempt(search_leaf).unwrap().state,
            AttemptState::Closed {
                reason: CloseReason::Rebased { into: fresh }
            }
        );
        tree.scored(fresh, passing(1), vec!["search.rs".into()])
            .unwrap();
        let second = tree.accept(search).unwrap();
        assert_eq!(tree.node(second.node).unwrap().parent, Some(first.node));
        assert_eq!(tree.all_behind().count(), 0);
    }

    #[test]
    fn a_failed_rebase_leaves_the_behind_attempt_for_its_agent_to_retry() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let a = tree.task_new("a", vec![]).unwrap();
        let b = tree.task_new("b", vec![]).unwrap();
        let a_leaf = tree.start(a, "x").unwrap();
        let b_leaf = tree.start(b, "y").unwrap();
        scored_touching(&mut tree, a_leaf, oid('a'), &["lib.rs", "a.rs"]);
        scored_touching(&mut tree, b_leaf, oid('b'), &["lib.rs", "b.rs"]);
        tree.accept(a).unwrap();
        assert_eq!(
            tree.behind(tree.attempt(b_leaf).unwrap()).unwrap().overlap,
            vec!["lib.rs"]
        );

        let (fresh, _) = tree.rebase_start(b_leaf).unwrap();
        tree.rebase_failed(fresh, "conflict in lib.rs").unwrap();
        assert_eq!(
            tree.attempt(fresh).unwrap().state,
            AttemptState::Closed {
                reason: CloseReason::Abandoned {
                    note: "conflict in lib.rs".into()
                }
            }
        );
        let old = tree.attempt(b_leaf).unwrap();
        assert!(
            is_open(&old.state),
            "the behind attempt is the agent's to retry"
        );
        assert_eq!(
            old.rebase,
            Some(fresh),
            "and the machine will not try again"
        );
        assert_eq!(tree.rebaseable().count(), 0);
        assert_eq!(tree.behind(old).unwrap().rebase, Some(fresh));
        assert_eq!(
            tree.rebase_done(fresh, oid('c')),
            Err(TreeError::NotRebase(fresh))
        );

        let retried = tree.retry(b_leaf).unwrap();
        assert_eq!(tree.task(b).unwrap().retries, 1);
        let story: Vec<_> = tree
            .history_of(b)
            .map(|c| (c.attempt, c.reason.clone()))
            .collect();
        assert_eq!(
            story,
            vec![
                (
                    fresh,
                    CloseReason::Abandoned {
                        note: "conflict in lib.rs".into()
                    }
                ),
                (b_leaf, CloseReason::Retried { into: retried }),
            ]
        );
    }

    #[test]
    fn a_rebase_the_sandbox_could_not_run_is_offered_again() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let a = tree.task_new("a", vec![]).unwrap();
        let b = tree.task_new("b", vec![]).unwrap();
        let a_leaf = tree.start(a, "x").unwrap();
        let b_leaf = tree.start(b, "y").unwrap();
        scored(&mut tree, a_leaf, oid('a'), passing(1));
        scored(&mut tree, b_leaf, oid('b'), passing(1));
        tree.accept(a).unwrap();
        let (fresh, _) = tree.rebase_start(b_leaf).unwrap();
        tree.rebase_retry(fresh, "sandbox unreachable").unwrap();
        assert_eq!(tree.attempt(b_leaf).unwrap().rebase, None);
        assert_eq!(
            tree.rebaseable().map(|l| l.id).collect::<Vec<_>>(),
            vec![b_leaf]
        );
        let (again, _) = tree.rebase_start(b_leaf).unwrap();
        assert_ne!(again, fresh);
    }

    #[test]
    fn only_a_submitted_attempt_can_be_rebased() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let a = tree.task_new("a", vec![]).unwrap();
        let b = tree.task_new("b", vec![]).unwrap();
        let a_leaf = tree.start(a, "x").unwrap();
        let working = tree.start(b, "y").unwrap();
        scored(&mut tree, a_leaf, oid('a'), passing(1));
        tree.accept(a).unwrap();
        assert!(tree.is_behind(tree.attempt(working).unwrap()));
        assert_eq!(tree.rebaseable().count(), 0);
        assert_eq!(
            tree.rebase_start(working),
            Err(TreeError::NothingToRebase(working))
        );
        let on_head = tree.start(b, "z").unwrap();
        tree.submit(on_head, oid('b')).unwrap();
        assert_eq!(
            tree.rebase_start(on_head),
            Err(TreeError::NotBehind(on_head))
        );
    }

    #[test]
    fn a_task_retries_a_bounded_number_of_times() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let slow = tree.task_new("slow", vec![]).unwrap();
        let mut attempt = tree.start(slow, "s").unwrap();
        for round in 0..MAX_RETRIES {
            let fast = tree.task_new(format!("fast {round}"), vec![]).unwrap();
            let fast_leaf = tree.start(fast, "f").unwrap();
            scored(&mut tree, fast_leaf, oid('a'), passing(1));
            tree.accept(fast).unwrap();
            attempt = tree.retry(attempt).unwrap();
        }
        let last = tree.task_new("last", vec![]).unwrap();
        let last_leaf = tree.start(last, "f").unwrap();
        scored(&mut tree, last_leaf, oid('a'), passing(1));
        tree.accept(last).unwrap();
        assert_eq!(
            tree.retry(attempt),
            Err(TreeError::TaskExhausted(slow, MAX_RETRIES))
        );
        // The task is still open: its owner can abandon it or split it.
        assert!(matches!(tree.task(slow).unwrap().state, TaskState::Open));
        assert!(tree.start(slow, "human").is_ok());
    }

    #[test]
    fn a_task_carries_its_own_checks_and_refuses_broken_ones() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let check = |name: &str, run: &str| CheckSpec {
            name: name.into(),
            run: run.into(),
            timeout_secs: None,
        };
        let task = tree
            .task_new(
                "dark mode",
                vec![check("toggle", "grep -q dark-mode ui.css")],
            )
            .unwrap();
        assert_eq!(tree.task(task).unwrap().checks.len(), 1);
        assert_eq!(
            tree.task_new("x", vec![check("a", "true"), check("a", "true")]),
            Err(TreeError::TaskChecks(ChecksError::DuplicateName(
                "a".into()
            )))
        );
        assert_eq!(
            tree.task_new("x", vec![check("a", " ")]),
            Err(TreeError::TaskChecks(ChecksError::EmptyRun("a".into())))
        );
    }

    #[test]
    fn accept_next_takes_the_oldest_task_that_is_ready() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        let old = tree.task_new("old", vec![]).unwrap();
        let mid = tree.task_new("mid", vec![]).unwrap();
        let new = tree.task_new("new", vec![]).unwrap();
        let old_leaf = tree.start(old, "a").unwrap();
        let mid_leaf = tree.start(mid, "b").unwrap();
        let new_leaf = tree.start(new, "c").unwrap();
        assert_eq!(tree.accept_next(), Err(TreeError::NothingScored));
        scored(&mut tree, new_leaf, oid('c'), passing(1));
        scored(&mut tree, mid_leaf, oid('b'), passing(1));
        assert_eq!(tree.acceptable().collect::<Vec<_>>(), vec![mid, new]);
        assert_eq!(tree.accept_next().unwrap().accepted, mid_leaf);
        // `new` is behind now, and `old` never scored.
        assert_eq!(tree.acceptable().count(), 0);
        assert_eq!(tree.accept_next(), Err(TreeError::NothingScored));
        let _ = old_leaf;
    }

    #[test]
    fn a_release_points_at_a_node_and_moving_it_back_is_a_rollback() {
        let mut tree = Tree::init(repo("t"), oid('0')).unwrap();
        assert!(tree.released().is_none());
        let task = tree.task_new("intent", vec![]).unwrap();
        let attempt = tree.start(task, "a").unwrap();
        scored(&mut tree, attempt, oid('a'), passing(1));
        let acceptance = tree.accept(task).unwrap();
        assert_eq!(
            tree.release(acceptance.node),
            Ok(Release {
                node: acceptance.node,
                previous: None,
                rollback: false
            })
        );
        assert_eq!(tree.released().unwrap().commit, oid('a'));
        assert_eq!(
            tree.release(NodeId(0)),
            Ok(Release {
                node: NodeId(0),
                previous: Some(acceptance.node),
                rollback: true
            })
        );
        assert_eq!(
            tree.release(NodeId(99)),
            Err(TreeError::UnknownNode(NodeId(99)))
        );
        let json = serde_json::to_string(&tree).unwrap();
        assert_eq!(serde_json::from_str::<Tree>(&json).unwrap(), tree);
    }

    /// A tree saved by the version that spoke of buds, leaves, harvests and
    /// compost: every name has a serde alias, so it loads unchanged.
    #[test]
    fn a_tree_saved_in_the_old_vocabulary_still_loads() {
        let json = include_str!("../tests/fixtures/tree-botany.json");
        let tree: Tree = serde_json::from_str(json).unwrap();
        assert_eq!(tree.head().id, NodeId(9));
        assert_eq!(tree.released().map(|node| node.id), Some(NodeId(9)));
        assert_eq!(tree.head().accepted_from, Some(AttemptId(4)));
        assert_eq!(tree.open_tasks().count(), 2);
        assert_eq!(
            tree.task(TaskId(1)).unwrap().state,
            TaskState::Done {
                attempt: AttemptId(4),
                node: NodeId(9)
            }
        );
        assert_eq!(tree.task(TaskId(1)).unwrap().checks[0].name, "done");
        assert_eq!(tree.task(TaskId(3)).unwrap().retries, 1);
        let states: Vec<_> = tree
            .history
            .iter()
            .map(|entry| (entry.attempt, entry.reason.clone()))
            .collect();
        assert_eq!(
            states,
            vec![
                (AttemptId(5), CloseReason::Lost { to: AttemptId(4) }),
                (
                    AttemptId(6),
                    CloseReason::Rebased {
                        into: AttemptId(10)
                    }
                ),
                (
                    AttemptId(11),
                    CloseReason::Abandoned {
                        note: "conflict in lib.rs".into()
                    }
                ),
                (
                    AttemptId(7),
                    CloseReason::Retried {
                        into: AttemptId(12)
                    }
                ),
                (
                    AttemptId(12),
                    CloseReason::Abandoned {
                        note: "gave up".into()
                    }
                ),
            ]
        );
        assert_eq!(
            tree.attempt(AttemptId(10)).unwrap().state,
            AttemptState::Checking { commit: oid('5') }
        );
        assert_eq!(
            tree.attempt(AttemptId(8)).unwrap().state,
            AttemptState::Working
        );
        assert_eq!(
            tree.attempt(AttemptId(7)).unwrap().rebase,
            Some(AttemptId(11))
        );
        // Saving writes the new names only.
        let saved = serde_json::to_string(&tree).unwrap();
        for old in [
            "buds",
            "leaves",
            "compost",
            "fruit_of",
            "regrowths",
            "transplant",
            "Fruited",
            "Pruned",
        ] {
            assert!(
                !saved.contains(&format!("\"{old}\"")),
                "{old} survived a save"
            );
        }
        assert_eq!(serde_json::from_str::<Tree>(&saved).unwrap(), tree);
    }
}
