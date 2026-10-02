//! The Ficus tree: work grows outward from an accepted node and never merges
//! back.
//!
//! A **bud** is a task, stated as intent rather than as a diff. Agents grow
//! competing **leaves** for a bud, each starting from the current head node.
//! A ripe leaf carries a commit and the score the root's checks gave it.
//! **Harvesting** a bud turns its best passing leaf into **fruit**: a new
//! node that becomes the head. The bud's other leaves are pruned.
//!
//! There is no merge. A leaf of another bud that grew from an older node is
//! *stale*. It cannot be harvested, because its commit was never checked
//! against the new head. Stale is about what was checked, not about the
//! diff, so a stale leaf with a commit is first **transplanted**: the
//! machine replays its commits onto the head in a fresh leaf and the checks
//! run again there. No agent is involved and the result is still a
//! single-parent commit on the head. Only when the replay conflicts is the
//! leaf **regrown**: the agent starts again from the head, with the same
//! intent and the compost of earlier attempts. A conflict becomes another
//! attempt rather than a three-way merge.
//!
//! Every pruned leaf goes to the **compost**: who grew it, why it lost and
//! how it scored. That is the context later attempts start from. A bud that
//! keeps losing is telling its planter the intent is too big: after
//! [`MAX_REGROWTHS`] regrowths it takes no more, and the planter decides.
//!
//! A bud says what done means with its own **checks**, run after the root's
//! and just as immutable to the leaf, since they never live in the repo.
//! Harvest takes the oldest bud first, so no bud starves.
//!
//! A **release** is a pointer at a node. Every node was scored by the same
//! checks and history is linear, so a rollback is the pointer moving back.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::scoring::{CheckSpec, ChecksError, validate_checks};

/// Regrowths a bud takes before it stops competing and its planter decides.
/// Transplants are free: they cost no agent's time.
pub const MAX_REGROWTHS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct NodeId(u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct BudId(u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct LeafId(u32);

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

id_text!(NodeId, BudId, LeafId);

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

/// Room left after the longest tree name for a leaf suffix (`-l` + a u32).
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

/// What the root's checks said about a leaf.
///
/// A leaf can only become fruit if every check passed. Among passing leaves
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
    /// `None` only for the root, which was planted rather than grown.
    pub parent: Option<NodeId>,
    pub commit: Oid,
    /// The repo holding `commit`: the tree's own repo for the root, the
    /// fruit's leaf repo for every node after it.
    pub repo: RepoName,
    /// The leaf this node was harvested from; `None` only for the root.
    pub fruit_of: Option<LeafId>,
    /// Paths the fruit changed against its parent; empty for the root.
    #[serde(default)]
    pub touched: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BudState {
    Open,
    Fruited { leaf: LeafId, node: NodeId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bud {
    pub id: BudId,
    pub intent: String,
    pub state: BudState,
    /// What done means for this bud, on top of the root's checks. They are
    /// never in the repo, so a leaf cannot touch them.
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
    /// Attempts an agent started over from a newer head.
    #[serde(default)]
    pub regrowths: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LeafState {
    Growing,
    /// Submitted at `commit` and frozen; the root's checks have not run yet.
    Ripening {
        commit: Oid,
    },
    Ripe {
        commit: Oid,
        score: Score,
    },
    Fruit {
        node: NodeId,
    },
    Pruned {
        reason: PruneReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PruneReason {
    /// Another leaf of the same bud was harvested.
    Outgrown { by: LeafId },
    /// The head moved past this leaf's base and it was started again.
    Regrown { into: LeafId },
    /// The head moved past this leaf's base and its commits were replayed
    /// onto the head, in `into`, without its agent.
    Transplanted { into: LeafId },
    /// The agent gave up, or the tree's owner cut it.
    Withered { note: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leaf {
    pub id: LeafId,
    pub bud: BudId,
    pub agent: String,
    /// The node this leaf started from.
    pub base: NodeId,
    /// The leaf's own repo, forked from the base node's repo.
    pub repo: RepoName,
    pub state: LeafState,
    /// Paths the leaf changed against its base, known once it is ripe.
    #[serde(default)]
    pub touched: Vec<String>,
    /// The fresh leaf a transplant of this one is in flight into, if any.
    #[serde(default)]
    pub transplant: Option<LeafId>,
    /// The stale leaf this one is a transplant of, if any.
    #[serde(default)]
    pub transplant_of: Option<LeafId>,
}

/// A pruned leaf, kept as context for the next attempt at its bud.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Compost {
    pub leaf: LeafId,
    pub bud: BudId,
    pub agent: String,
    pub reason: PruneReason,
    /// `None` if the leaf was pruned before it ripened.
    pub score: Option<Score>,
}

/// What a harvest changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Harvest {
    pub node: NodeId,
    pub fruit: LeafId,
    /// The bud's other leaves, now in the compost.
    pub pruned: Vec<LeafId>,
    /// Other buds' live leaves whose base is no longer the head.
    pub stale: Vec<LeafId>,
}

/// A stale leaf as the head sees it: what it would have to be replayed over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Staleness {
    pub leaf: LeafId,
    /// Nodes between the leaf's base and the head.
    pub behind: u32,
    /// Paths both the leaf and those nodes changed. Empty means the
    /// transplant is expected to apply cleanly.
    pub overlap: Vec<String>,
    /// The fresh leaf a transplant went into: still growing while the
    /// replay runs, withered if it conflicted (then the agent regrows).
    pub transplant: Option<LeafId>,
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
    #[error("an intent must say what the bud is for")]
    EmptyIntent,
    #[error("no bud {0:?}")]
    UnknownBud(BudId),
    #[error("no leaf {0:?}")]
    UnknownLeaf(LeafId),
    #[error("bud {0:?} has already fruited")]
    BudFruited(BudId),
    #[error("leaf {0:?} is no longer growing")]
    NotGrowing(LeafId),
    #[error("leaf {0:?} is not waiting for its checks")]
    NotRipening(LeafId),
    #[error("leaf {0:?} is already fruit or pruned")]
    NotLive(LeafId),
    #[error("leaf {0:?} grew from the head, so there is nothing to regrow")]
    NotStale(LeafId),
    #[error("leaf {0:?} has no commit to transplant")]
    NothingToTransplant(LeafId),
    #[error("leaf {0:?} is already being transplanted into {1:?}")]
    Transplanting(LeafId, LeafId),
    #[error("leaf {0:?} is not a transplant in progress")]
    NotTransplant(LeafId),
    #[error("bud {0:?} has no ripe leaf on the head that passes every check")]
    NothingToHarvest(BudId),
    #[error("no bud has a ripe leaf on the head that passes every check")]
    NothingRipe,
    #[error("bud {0:?} has regrown {1} times; its planter should split or wither it")]
    BudExhausted(BudId, u32),
    #[error("bud checks: {0}")]
    BudChecks(#[from] ChecksError),
    #[error("no node {0:?}")]
    UnknownNode(NodeId),
    #[error("the tree has run out of ids")]
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tree {
    name: RepoName,
    head: NodeId,
    next_id: u32,
    nodes: BTreeMap<NodeId, Node>,
    buds: BTreeMap<BudId, Bud>,
    leaves: BTreeMap<LeafId, Leaf>,
    compost: Vec<Compost>,
    /// The node a deployment should follow; `None` until the first release.
    #[serde(default)]
    released: Option<NodeId>,
}

impl Tree {
    /// A tree whose root is `commit`: the strict starting point every leaf
    /// grows from until the first harvest.
    /// A tree is named by its root repo; leaf repos are named after it, so
    /// the name must leave room for the longest leaf suffix.
    pub fn plant(name: RepoName, commit: Oid) -> Result<Self, TreeError> {
        let longest_leaf = format!("{}-l{}", name.as_str(), u32::MAX);
        RepoName::try_from(longest_leaf)
            .map_err(|_| TreeError::MalformedRepoName(name.as_str().to_owned()))?;
        let root = NodeId(0);
        let node = Node {
            id: root,
            parent: None,
            commit,
            repo: name.clone(),
            fruit_of: None,
            touched: Vec::new(),
        };
        Ok(Self {
            name,
            head: root,
            next_id: 1,
            nodes: BTreeMap::from([(root, node)]),
            buds: BTreeMap::new(),
            leaves: BTreeMap::new(),
            compost: Vec::new(),
            released: None,
        })
    }

    pub fn name(&self) -> &RepoName {
        &self.name
    }

    pub fn head(&self) -> &Node {
        self.nodes.get(&self.head).expect(
            "head always names a node: only harvest moves it, and only to a node it just inserted",
        )
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn bud(&self, id: BudId) -> Option<&Bud> {
        self.buds.get(&id)
    }

    pub fn leaf(&self, id: LeafId) -> Option<&Leaf> {
        self.leaves.get(&id)
    }

    pub fn leaves_of(&self, bud: BudId) -> impl Iterator<Item = &Leaf> {
        self.leaves.values().filter(move |leaf| leaf.bud == bud)
    }

    /// Every pruned leaf of `bud`, oldest first.
    pub fn compost_of(&self, bud: BudId) -> impl Iterator<Item = &Compost> {
        self.compost.iter().filter(move |entry| entry.bud == bud)
    }

    /// Whether `leaf` is live but grew from a node that is no longer the head.
    pub fn is_stale(&self, leaf: &Leaf) -> bool {
        is_live(&leaf.state) && leaf.base != self.head
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

    /// How far behind the head `leaf` is, and where its diff meets what the
    /// head gained meanwhile. `None` if the leaf is not stale.
    pub fn staleness(&self, leaf: &Leaf) -> Option<Staleness> {
        if !self.is_stale(leaf) {
            return None;
        }
        let mut behind = 0;
        let mut gained = BTreeSet::new();
        for node in self.trunk().take_while(|node| node.id != leaf.base) {
            behind += 1;
            gained.extend(node.touched.iter().map(String::as_str));
        }
        let overlap = leaf
            .touched
            .iter()
            .filter(|path| gained.contains(path.as_str()))
            .cloned()
            .collect();
        Some(Staleness {
            leaf: leaf.id,
            behind,
            overlap,
            transplant: leaf.transplant,
        })
    }

    /// Every stale leaf, oldest first.
    pub fn stale(&self) -> impl Iterator<Item = Staleness> {
        self.leaves.values().filter_map(|leaf| self.staleness(leaf))
    }

    /// A bud with `checks` of its own on top of the root's. The intent says
    /// what the bud is for; the checks say when it is done.
    pub fn bud_new(
        &mut self,
        intent: impl Into<String>,
        checks: Vec<CheckSpec>,
    ) -> Result<BudId, TreeError> {
        let intent = intent.into();
        if intent.trim().is_empty() {
            return Err(TreeError::EmptyIntent);
        }
        validate_checks(&checks)?;
        let id = BudId(self.take_id()?);
        self.buds.insert(
            id,
            Bud {
                id,
                intent,
                state: BudState::Open,
                checks,
                regrowths: 0,
            },
        );
        Ok(id)
    }

    /// Open buds, oldest first.
    pub fn open_buds(&self) -> impl Iterator<Item = &Bud> {
        self.buds
            .values()
            .filter(|bud| matches!(bud.state, BudState::Open))
    }

    /// Start a leaf for `bud` from the current head.
    pub fn sprout(&mut self, bud: BudId, agent: impl Into<String>) -> Result<LeafId, TreeError> {
        self.open_bud(bud)?;
        let id = LeafId(self.take_id()?);
        let repo = RepoName::try_from(format!("{}-l{}", self.name.as_str(), id.0))
            .expect("plant checked that the tree name leaves room for any leaf suffix");
        let leaf = Leaf {
            id,
            bud,
            agent: agent.into(),
            base: self.head,
            repo,
            state: LeafState::Growing,
            touched: Vec::new(),
            transplant: None,
            transplant_of: None,
        };
        self.leaves.insert(id, leaf);
        Ok(id)
    }

    /// Record that `leaf` finished growing at `commit`. Its checks run next.
    pub fn submit(&mut self, leaf: LeafId, commit: Oid) -> Result<(), TreeError> {
        let entry = self
            .leaves
            .get_mut(&leaf)
            .ok_or(TreeError::UnknownLeaf(leaf))?;
        match entry.state {
            LeafState::Growing => {
                entry.state = LeafState::Ripening { commit };
                Ok(())
            }
            LeafState::Ripening { .. }
            | LeafState::Ripe { .. }
            | LeafState::Fruit { .. }
            | LeafState::Pruned { .. } => Err(TreeError::NotGrowing(leaf)),
        }
    }

    /// Record how the checks scored a submitted leaf, and the paths it
    /// changed against its base.
    pub fn ripen(
        &mut self,
        leaf: LeafId,
        score: Score,
        touched: Vec<String>,
    ) -> Result<(), TreeError> {
        let entry = self
            .leaves
            .get_mut(&leaf)
            .ok_or(TreeError::UnknownLeaf(leaf))?;
        match &entry.state {
            LeafState::Ripening { commit } => {
                entry.state = LeafState::Ripe {
                    commit: commit.clone(),
                    score,
                };
                entry.touched = touched;
                Ok(())
            }
            LeafState::Growing
            | LeafState::Ripe { .. }
            | LeafState::Fruit { .. }
            | LeafState::Pruned { .. } => Err(TreeError::NotRipening(leaf)),
        }
    }

    /// Leaves waiting for their checks, with the commit each was submitted at.
    pub fn ripening(&self) -> impl Iterator<Item = (&Leaf, &Oid)> {
        self.leaves.values().filter_map(|leaf| match &leaf.state {
            LeafState::Ripening { commit } => Some((leaf, commit)),
            LeafState::Growing
            | LeafState::Ripe { .. }
            | LeafState::Fruit { .. }
            | LeafState::Pruned { .. } => None,
        })
    }

    /// Cut a live leaf, for example because its agent gave up.
    pub fn wither(&mut self, leaf: LeafId, note: impl Into<String>) -> Result<(), TreeError> {
        self.prune(leaf, PruneReason::Withered { note: note.into() })
    }

    /// Start `stale` again from the head: same bud, same agent. The old leaf
    /// goes to the compost, which is what the new attempt should read first.
    /// A bud regrows at most [`MAX_REGROWTHS`] times.
    pub fn regrow(&mut self, stale: LeafId) -> Result<LeafId, TreeError> {
        let old = self
            .leaves
            .get(&stale)
            .ok_or(TreeError::UnknownLeaf(stale))?;
        if !is_live(&old.state) {
            return Err(TreeError::NotLive(stale));
        }
        if old.base == self.head {
            return Err(TreeError::NotStale(stale));
        }
        if let Some(into) = self.transplant_in_flight(old) {
            return Err(TreeError::Transplanting(stale, into));
        }
        let (bud, agent) = (old.bud, old.agent.clone());
        let regrowths = self
            .buds
            .get(&bud)
            .expect("a leaf's bud is in its tree")
            .regrowths;
        if regrowths >= MAX_REGROWTHS {
            return Err(TreeError::BudExhausted(bud, regrowths));
        }
        let fresh = self.sprout(bud, agent)?;
        self.prune(stale, PruneReason::Regrown { into: fresh })?;
        self.buds.get_mut(&bud).expect("checked above").regrowths = regrowths + 1;
        Ok(fresh)
    }

    /// Stale leaves with a commit to replay that no transplant has been
    /// tried on. A conflicted one keeps pointing at its withered transplant,
    /// so the machine does not try again: that is the agent's turn.
    pub fn transplantable(&self) -> impl Iterator<Item = &Leaf> {
        self.leaves.values().filter(|leaf| {
            self.is_stale(leaf) && leaf.transplant.is_none() && leaf_commit(leaf).is_some()
        })
    }

    /// The fresh leaf `stale` is being transplanted into right now.
    fn transplant_in_flight(&self, stale: &Leaf) -> Option<LeafId> {
        stale.transplant.filter(|into| {
            self.leaves
                .get(into)
                .is_some_and(|fresh| is_live(&fresh.state))
        })
    }

    /// Begin replaying `stale`'s commits onto the head: a fresh leaf of the
    /// same bud and agent, growing from the head, that the machine fills.
    /// Returns the fresh leaf and the commit to replay.
    pub fn transplant_start(&mut self, stale: LeafId) -> Result<(LeafId, Oid), TreeError> {
        let old = self
            .leaves
            .get(&stale)
            .ok_or(TreeError::UnknownLeaf(stale))?;
        if !is_live(&old.state) {
            return Err(TreeError::NotLive(stale));
        }
        if old.base == self.head {
            return Err(TreeError::NotStale(stale));
        }
        if let Some(into) = self.transplant_in_flight(old) {
            return Err(TreeError::Transplanting(stale, into));
        }
        let commit = leaf_commit(old)
            .cloned()
            .ok_or(TreeError::NothingToTransplant(stale))?;
        let (bud, agent) = (old.bud, old.agent.clone());
        let fresh = self.sprout(bud, agent)?;
        self.leaves
            .get_mut(&fresh)
            .expect("just sprouted")
            .transplant_of = Some(stale);
        self.leaves
            .get_mut(&stale)
            .expect("looked up above")
            .transplant = Some(fresh);
        Ok((fresh, commit))
    }

    /// The replay landed at `commit` in the fresh leaf: submit it for its
    /// checks and compost the stale one.
    pub fn transplant_done(&mut self, fresh: LeafId, commit: Oid) -> Result<(), TreeError> {
        let stale = self.transplant_source(fresh)?;
        self.submit(fresh, commit)?;
        self.leaves
            .get_mut(&fresh)
            .expect("transplant_source found it")
            .transplant_of = None;
        if self
            .leaves
            .get(&stale)
            .is_some_and(|old| is_live(&old.state))
        {
            self.prune(stale, PruneReason::Transplanted { into: fresh })?;
        }
        Ok(())
    }

    /// The replay did not apply: the fresh leaf withers with `note` and the
    /// stale one stays live, still pointing at it, for its agent to regrow.
    /// The machine does not try this leaf again.
    pub fn transplant_failed(
        &mut self,
        fresh: LeafId,
        note: impl Into<String>,
    ) -> Result<(), TreeError> {
        self.transplant_source(fresh)?;
        self.prune(fresh, PruneReason::Withered { note: note.into() })
    }

    /// The replay could not be run (the sandbox's fault, not the leaf's):
    /// the fresh leaf withers with `note` and the stale one is offered to
    /// the machine again.
    pub fn transplant_retry(
        &mut self,
        fresh: LeafId,
        note: impl Into<String>,
    ) -> Result<(), TreeError> {
        let stale = self.transplant_source(fresh)?;
        self.prune(fresh, PruneReason::Withered { note: note.into() })?;
        if let Some(old) = self.leaves.get_mut(&stale) {
            old.transplant = None;
        }
        Ok(())
    }

    fn transplant_source(&self, fresh: LeafId) -> Result<LeafId, TreeError> {
        let entry = self
            .leaves
            .get(&fresh)
            .ok_or(TreeError::UnknownLeaf(fresh))?;
        match (&entry.state, entry.transplant_of) {
            (LeafState::Growing, Some(stale)) => Ok(stale),
            _ => Err(TreeError::NotTransplant(fresh)),
        }
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

    /// Open buds with a harvestable leaf, oldest first.
    pub fn harvestable(&self) -> impl Iterator<Item = BudId> {
        self.open_buds()
            .filter(|bud| self.best_leaf(bud.id).is_some())
            .map(|bud| bud.id)
    }

    /// Harvest the oldest bud that can be, so no bud starves.
    pub fn harvest_next(&mut self) -> Result<Harvest, TreeError> {
        let bud = self.harvestable().next().ok_or(TreeError::NothingRipe)?;
        self.harvest(bud)
    }

    /// The leaf `harvest` would pick for `bud`: ripe on the head, passing
    /// every check, cheapest; on equal cost the one the judges were surest
    /// of, then the earliest.
    fn best_leaf(&self, bud: BudId) -> Option<&Leaf> {
        self.leaves_of(bud)
            .filter(|leaf| leaf.base == self.head)
            .filter_map(|leaf| match &leaf.state {
                LeafState::Ripe { score, .. } if score.passes() => Some((leaf, *score)),
                LeafState::Ripe { .. }
                | LeafState::Growing
                | LeafState::Ripening { .. }
                | LeafState::Fruit { .. }
                | LeafState::Pruned { .. } => None,
            })
            .min_by_key(|&(leaf, score)| {
                let surest = std::cmp::Reverse(score.confidence().unwrap_or(0));
                (score.cost(), surest, leaf.id)
            })
            .map(|(leaf, _)| leaf)
    }

    /// Turn the best ripe leaf of `bud` into fruit and move the head onto it.
    ///
    /// Only leaves that grew from the head are candidates: anything older was
    /// checked against a tree that no longer exists. The winner passes every
    /// check and has the lowest cost; on equal cost the one the judges were
    /// surest of, then the earliest leaf.
    pub fn harvest(&mut self, bud: BudId) -> Result<Harvest, TreeError> {
        self.open_bud(bud)?;
        let (fruit, commit, repo, touched) = self
            .best_leaf(bud)
            .map(|leaf| {
                let commit = leaf_commit(leaf)
                    .cloned()
                    .expect("best_leaf only picks ripe leaves, which have a commit");
                (leaf.id, commit, leaf.repo.clone(), leaf.touched.clone())
            })
            .ok_or(TreeError::NothingToHarvest(bud))?;

        let node = NodeId(self.take_id()?);
        self.nodes.insert(
            node,
            Node {
                id: node,
                parent: Some(self.head),
                commit,
                repo,
                fruit_of: Some(fruit),
                touched,
            },
        );
        self.head = node;

        let fruit_leaf = self
            .leaves
            .get_mut(&fruit)
            .expect("fruit was chosen from this map above");
        fruit_leaf.state = LeafState::Fruit { node };
        let bud_entry = self
            .buds
            .get_mut(&bud)
            .expect("open_bud confirmed the bud exists");
        bud_entry.state = BudState::Fruited { leaf: fruit, node };

        let siblings: Vec<LeafId> = self
            .leaves_of(bud)
            .filter(|leaf| is_live(&leaf.state))
            .map(|leaf| leaf.id)
            .collect();
        for &sibling in &siblings {
            self.prune(sibling, PruneReason::Outgrown { by: fruit })?;
        }

        let stale = self
            .leaves
            .values()
            .filter(|leaf| self.is_stale(leaf))
            .map(|leaf| leaf.id)
            .collect();
        Ok(Harvest {
            node,
            fruit,
            pruned: siblings,
            stale,
        })
    }

    fn open_bud(&self, bud: BudId) -> Result<(), TreeError> {
        match self.buds.get(&bud).ok_or(TreeError::UnknownBud(bud))?.state {
            BudState::Open => Ok(()),
            BudState::Fruited { .. } => Err(TreeError::BudFruited(bud)),
        }
    }

    fn prune(&mut self, leaf: LeafId, reason: PruneReason) -> Result<(), TreeError> {
        let entry = self
            .leaves
            .get_mut(&leaf)
            .ok_or(TreeError::UnknownLeaf(leaf))?;
        let score = match &entry.state {
            LeafState::Growing | LeafState::Ripening { .. } => None,
            LeafState::Ripe { score, .. } => Some(*score),
            LeafState::Fruit { .. } | LeafState::Pruned { .. } => {
                return Err(TreeError::NotLive(leaf));
            }
        };
        entry.state = LeafState::Pruned {
            reason: reason.clone(),
        };
        self.compost.push(Compost {
            leaf,
            bud: entry.bud,
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

fn is_live(state: &LeafState) -> bool {
    match state {
        LeafState::Growing | LeafState::Ripening { .. } | LeafState::Ripe { .. } => true,
        LeafState::Fruit { .. } | LeafState::Pruned { .. } => false,
    }
}

/// The commit a live leaf was submitted at, once it has one.
fn leaf_commit(leaf: &Leaf) -> Option<&Oid> {
    match &leaf.state {
        LeafState::Ripening { commit } | LeafState::Ripe { commit, .. } => Some(commit),
        LeafState::Growing | LeafState::Fruit { .. } | LeafState::Pruned { .. } => None,
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
    fn ripen(tree: &mut Tree, leaf: LeafId, commit: Oid, score: Score) {
        tree.submit(leaf, commit).unwrap();
        tree.ripen(leaf, score, vec![]).unwrap();
    }

    fn passing(cost: u64) -> Score {
        Score::new(3, 3, cost).expect("3 of 3 is a valid score")
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
    fn on_equal_cost_harvest_takes_the_leaf_the_judges_were_surest_of() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("add a /health route", vec![]).unwrap();
        let first = tree.sprout(bud, "agent-a").unwrap();
        let surer = tree.sprout(bud, "agent-b").unwrap();
        let cheaper_but_doubted = tree.sprout(bud, "agent-c").unwrap();
        ripen(&mut tree, first, oid('a'), passing(10).judged(600));
        ripen(&mut tree, surer, oid('b'), passing(10).judged(900));
        ripen(
            &mut tree,
            cheaper_but_doubted,
            oid('c'),
            passing(9).judged(510),
        );

        assert_eq!(tree.harvest(bud).unwrap().fruit, cheaper_but_doubted);

        let bud = tree.bud_new("add a /ready route", vec![]).unwrap();
        let first = tree.sprout(bud, "agent-a").unwrap();
        let surer = tree.sprout(bud, "agent-b").unwrap();
        ripen(&mut tree, first, oid('d'), passing(10).judged(600));
        ripen(&mut tree, surer, oid('e'), passing(10).judged(900));

        assert_eq!(tree.harvest(bud).unwrap().fruit, surer);
    }

    #[test]
    fn a_score_stored_before_judges_reads_back_unjudged() {
        let stored: Score =
            serde_json::from_str(r#"{"checks_passed":3,"checks_total":3,"cost":7}"#).unwrap();
        assert_eq!(stored, passing(7));
        assert_eq!(passing(7).judged(2000).confidence(), Some(1000));
    }

    #[test]
    fn harvest_takes_the_cheapest_passing_leaf_and_prunes_the_rest() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let root = tree.head().id;
        let bud = tree.bud_new("add a /health route", vec![]).unwrap();
        let costly = tree.sprout(bud, "agent-a").unwrap();
        let cheap = tree.sprout(bud, "agent-b").unwrap();
        let failing = tree.sprout(bud, "agent-c").unwrap();
        let unfinished = tree.sprout(bud, "agent-d").unwrap();
        ripen(&mut tree, costly, oid('a'), passing(900));
        ripen(&mut tree, cheap, oid('b'), passing(120));
        ripen(&mut tree, failing, oid('c'), Score::new(2, 3, 1).unwrap());

        let harvest = tree.harvest(bud).unwrap();

        assert_eq!(harvest.fruit, cheap);
        assert_eq!(harvest.pruned, vec![costly, failing, unfinished]);
        assert!(harvest.stale.is_empty());
        let head = tree.head();
        assert_eq!(
            (head.id, head.parent, &head.commit, head.fruit_of),
            (harvest.node, Some(root), &oid('b'), Some(cheap))
        );
        assert_eq!(
            tree.bud(bud).unwrap().state,
            BudState::Fruited {
                leaf: cheap,
                node: harvest.node
            }
        );
        assert_eq!(head.repo, repo(&format!("t-l{}", cheap.0)));
        assert_eq!(
            tree.leaf(cheap).unwrap().state,
            LeafState::Fruit { node: harvest.node }
        );

        let reasons: Vec<_> = tree
            .compost_of(bud)
            .map(|c| (c.leaf, c.reason.clone(), c.score))
            .collect();
        assert_eq!(
            reasons,
            vec![
                (
                    costly,
                    PruneReason::Outgrown { by: cheap },
                    Some(passing(900))
                ),
                (
                    failing,
                    PruneReason::Outgrown { by: cheap },
                    Some(Score::new(2, 3, 1).unwrap())
                ),
                (unfinished, PruneReason::Outgrown { by: cheap }, None),
            ]
        );
    }

    #[test]
    fn equal_cost_goes_to_the_earliest_leaf() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let first = tree.sprout(bud, "a").unwrap();
        let second = tree.sprout(bud, "b").unwrap();
        ripen(&mut tree, second, oid('b'), passing(5));
        ripen(&mut tree, first, oid('a'), passing(5));
        assert_eq!(tree.harvest(bud).unwrap().fruit, first);
    }

    #[test]
    fn nothing_to_harvest_without_a_passing_ripe_leaf() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        assert_eq!(tree.harvest(bud), Err(TreeError::NothingToHarvest(bud)));
        ripen(&mut tree, leaf, oid('a'), Score::new(0, 1, 0).unwrap());
        assert_eq!(tree.harvest(bud), Err(TreeError::NothingToHarvest(bud)));
        assert_eq!(tree.head().id, NodeId(0));
    }

    #[test]
    fn a_harvest_makes_other_buds_stale_and_they_regrow_instead_of_merging() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let auth = tree.bud_new("add auth", vec![]).unwrap();
        let search = tree.bud_new("add search", vec![]).unwrap();
        let auth_leaf = tree.sprout(auth, "a").unwrap();
        let search_leaf = tree.sprout(search, "b").unwrap();
        ripen(&mut tree, auth_leaf, oid('a'), passing(1));
        ripen(&mut tree, search_leaf, oid('b'), passing(1));

        let harvest = tree.harvest(auth).unwrap();
        assert_eq!(harvest.stale, vec![search_leaf]);

        // Ripe and passing, but checked against the old root: not harvestable.
        assert_eq!(
            tree.harvest(search),
            Err(TreeError::NothingToHarvest(search))
        );

        let regrown = tree.regrow(search_leaf).unwrap();
        let fresh = tree.leaf(regrown).unwrap();
        assert_eq!(
            (fresh.bud, fresh.agent.as_str(), fresh.base, &fresh.state),
            (search, "b", harvest.node, &LeafState::Growing)
        );
        let compost: Vec<_> = tree
            .compost_of(search)
            .map(|c| (c.leaf, c.reason.clone()))
            .collect();
        assert_eq!(
            compost,
            vec![(search_leaf, PruneReason::Regrown { into: regrown })]
        );

        ripen(&mut tree, regrown, oid('c'), passing(1));
        let second = tree.harvest(search).unwrap();
        assert_eq!(tree.node(second.node).unwrap().parent, Some(harvest.node));
    }

    #[test]
    fn regrow_refuses_a_leaf_that_is_on_the_head() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        assert_eq!(tree.regrow(leaf), Err(TreeError::NotStale(leaf)));
    }

    #[test]
    fn a_fruited_bud_takes_no_more_leaves() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        ripen(&mut tree, leaf, oid('a'), passing(1));
        tree.harvest(bud).unwrap();
        assert_eq!(tree.sprout(bud, "late"), Err(TreeError::BudFruited(bud)));
        assert_eq!(tree.harvest(bud), Err(TreeError::BudFruited(bud)));
    }

    #[test]
    fn a_leaf_ripens_once_and_withers_into_the_compost() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        tree.submit(leaf, oid('a')).unwrap();
        assert_eq!(
            tree.submit(leaf, oid('b')),
            Err(TreeError::NotGrowing(leaf))
        );
        tree.ripen(leaf, passing(1), vec![]).unwrap();
        assert_eq!(
            tree.ripen(leaf, passing(0), vec![]),
            Err(TreeError::NotRipening(leaf))
        );
        tree.wither(leaf, "lost interest").unwrap();
        assert_eq!(tree.wither(leaf, "again"), Err(TreeError::NotLive(leaf)));
        let entry = tree.compost_of(bud).next().unwrap();
        assert_eq!(
            (&entry.reason, entry.score),
            (
                &PruneReason::Withered {
                    note: "lost interest".into()
                },
                Some(passing(1))
            )
        );
    }

    #[test]
    fn a_submitted_leaf_waits_for_its_checks_and_cannot_be_harvested_yet() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        assert_eq!(
            tree.ripen(leaf, passing(1), vec![]),
            Err(TreeError::NotRipening(leaf))
        );
        tree.submit(leaf, oid('a')).unwrap();
        let waiting: Vec<_> = tree.ripening().map(|(l, c)| (l.id, c.clone())).collect();
        assert_eq!(waiting, vec![(leaf, oid('a'))]);
        assert_eq!(tree.harvest(bud), Err(TreeError::NothingToHarvest(bud)));
        tree.ripen(leaf, passing(1), vec![]).unwrap();
        assert_eq!(tree.ripening().count(), 0);
        assert_eq!(tree.harvest(bud).unwrap().fruit, leaf);
    }

    #[test]
    fn empty_intent_is_refused() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        assert_eq!(tree.bud_new("  ", vec![]), Err(TreeError::EmptyIntent));
    }

    #[test]
    fn leaves_get_their_own_repo_and_harvest_hands_it_to_the_node() {
        let mut tree = Tree::plant(repo("site"), oid('0')).unwrap();
        assert_eq!(tree.head().repo, repo("site"));
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        assert_eq!(
            tree.leaf(leaf).unwrap().repo,
            repo(&format!("site-l{}", leaf.0))
        );
        ripen(&mut tree, leaf, oid('a'), passing(1));
        let harvest = tree.harvest(bud).unwrap();
        assert_eq!(
            tree.node(harvest.node).unwrap().repo,
            tree.leaf(leaf).unwrap().repo
        );
    }

    #[test]
    fn repo_names_follow_artifacts_rules_and_leave_room_for_leaves() {
        assert!(RepoName::try_from("my_repo-1.0".to_owned()).is_ok());
        assert!(RepoName::try_from(String::new()).is_err());
        assert!(RepoName::try_from("has space".to_owned()).is_err());
        assert!(RepoName::try_from("a".repeat(64)).is_err());
        let long = repo(&"a".repeat(60));
        assert_eq!(
            Tree::plant(long, oid('0')),
            Err(TreeError::MalformedRepoName("a".repeat(60)))
        );
    }

    #[test]
    fn the_tree_round_trips_through_json() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        ripen(&mut tree, leaf, oid('a'), passing(1));
        let json = serde_json::to_string(&tree).unwrap();
        assert_eq!(serde_json::from_str::<Tree>(&json).unwrap(), tree);
        let bad = json.replace(&"0".repeat(40), "not-an-oid");
        assert!(serde_json::from_str::<Tree>(&bad).is_err());
    }

    /// Submit and score with the paths the leaf touched.
    fn ripen_touching(tree: &mut Tree, leaf: LeafId, commit: Oid, touched: &[&str]) {
        tree.submit(leaf, commit).unwrap();
        tree.ripen(
            leaf,
            passing(1),
            touched.iter().map(|path| (*path).to_owned()).collect(),
        )
        .unwrap();
    }

    #[test]
    fn a_stale_leaf_is_transplanted_onto_the_head_without_its_agent() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let auth = tree.bud_new("add auth", vec![]).unwrap();
        let search = tree.bud_new("add search", vec![]).unwrap();
        let auth_leaf = tree.sprout(auth, "a").unwrap();
        let search_leaf = tree.sprout(search, "b").unwrap();
        ripen_touching(&mut tree, auth_leaf, oid('a'), &["auth.rs"]);
        ripen_touching(&mut tree, search_leaf, oid('b'), &["search.rs"]);
        let first = tree.harvest(auth).unwrap();

        // Disjoint paths: the head sees nothing in the way.
        let stale: Vec<_> = tree.stale().collect();
        assert_eq!(
            stale,
            vec![Staleness {
                leaf: search_leaf,
                behind: 1,
                overlap: vec![],
                transplant: None,
            }]
        );
        assert_eq!(
            tree.transplantable().map(|l| l.id).collect::<Vec<_>>(),
            vec![search_leaf]
        );

        let (fresh, commit) = tree.transplant_start(search_leaf).unwrap();
        assert_eq!(commit, oid('b'));
        let fresh_leaf = tree.leaf(fresh).unwrap();
        assert_eq!(
            (
                fresh_leaf.bud,
                fresh_leaf.agent.as_str(),
                fresh_leaf.base,
                fresh_leaf.transplant_of
            ),
            (search, "b", first.node, Some(search_leaf))
        );
        // In flight: not offered again, and not for an agent to regrow either.
        assert_eq!(tree.transplantable().count(), 0);
        assert_eq!(
            tree.regrow(search_leaf),
            Err(TreeError::Transplanting(search_leaf, fresh))
        );
        assert_eq!(
            tree.transplant_start(search_leaf),
            Err(TreeError::Transplanting(search_leaf, fresh))
        );

        tree.transplant_done(fresh, oid('c')).unwrap();
        assert_eq!(
            tree.leaf(fresh).unwrap().state,
            LeafState::Ripening { commit: oid('c') }
        );
        assert_eq!(
            tree.leaf(search_leaf).unwrap().state,
            LeafState::Pruned {
                reason: PruneReason::Transplanted { into: fresh }
            }
        );
        tree.ripen(fresh, passing(1), vec!["search.rs".into()])
            .unwrap();
        let second = tree.harvest(search).unwrap();
        assert_eq!(tree.node(second.node).unwrap().parent, Some(first.node));
        assert_eq!(tree.stale().count(), 0);
    }

    #[test]
    fn a_failed_transplant_leaves_the_stale_leaf_for_its_agent_to_regrow() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let a = tree.bud_new("a", vec![]).unwrap();
        let b = tree.bud_new("b", vec![]).unwrap();
        let a_leaf = tree.sprout(a, "x").unwrap();
        let b_leaf = tree.sprout(b, "y").unwrap();
        ripen_touching(&mut tree, a_leaf, oid('a'), &["lib.rs", "a.rs"]);
        ripen_touching(&mut tree, b_leaf, oid('b'), &["lib.rs", "b.rs"]);
        tree.harvest(a).unwrap();
        assert_eq!(
            tree.staleness(tree.leaf(b_leaf).unwrap()).unwrap().overlap,
            vec!["lib.rs"]
        );

        let (fresh, _) = tree.transplant_start(b_leaf).unwrap();
        tree.transplant_failed(fresh, "conflict in lib.rs").unwrap();
        assert_eq!(
            tree.leaf(fresh).unwrap().state,
            LeafState::Pruned {
                reason: PruneReason::Withered {
                    note: "conflict in lib.rs".into()
                }
            }
        );
        let old = tree.leaf(b_leaf).unwrap();
        assert!(
            is_live(&old.state),
            "the stale leaf is the agent's to regrow"
        );
        assert_eq!(
            old.transplant,
            Some(fresh),
            "and the machine will not try again"
        );
        assert_eq!(tree.transplantable().count(), 0);
        assert_eq!(tree.staleness(old).unwrap().transplant, Some(fresh));
        assert_eq!(
            tree.transplant_done(fresh, oid('c')),
            Err(TreeError::NotTransplant(fresh))
        );

        let regrown = tree.regrow(b_leaf).unwrap();
        assert_eq!(tree.bud(b).unwrap().regrowths, 1);
        let story: Vec<_> = tree
            .compost_of(b)
            .map(|c| (c.leaf, c.reason.clone()))
            .collect();
        assert_eq!(
            story,
            vec![
                (
                    fresh,
                    PruneReason::Withered {
                        note: "conflict in lib.rs".into()
                    }
                ),
                (b_leaf, PruneReason::Regrown { into: regrown }),
            ]
        );
    }

    #[test]
    fn a_transplant_the_sandbox_could_not_run_is_offered_again() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let a = tree.bud_new("a", vec![]).unwrap();
        let b = tree.bud_new("b", vec![]).unwrap();
        let a_leaf = tree.sprout(a, "x").unwrap();
        let b_leaf = tree.sprout(b, "y").unwrap();
        ripen(&mut tree, a_leaf, oid('a'), passing(1));
        ripen(&mut tree, b_leaf, oid('b'), passing(1));
        tree.harvest(a).unwrap();
        let (fresh, _) = tree.transplant_start(b_leaf).unwrap();
        tree.transplant_retry(fresh, "sandbox unreachable").unwrap();
        assert_eq!(tree.leaf(b_leaf).unwrap().transplant, None);
        assert_eq!(
            tree.transplantable().map(|l| l.id).collect::<Vec<_>>(),
            vec![b_leaf]
        );
        let (again, _) = tree.transplant_start(b_leaf).unwrap();
        assert_ne!(again, fresh);
    }

    #[test]
    fn only_a_submitted_leaf_can_be_transplanted() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let a = tree.bud_new("a", vec![]).unwrap();
        let b = tree.bud_new("b", vec![]).unwrap();
        let a_leaf = tree.sprout(a, "x").unwrap();
        let growing = tree.sprout(b, "y").unwrap();
        ripen(&mut tree, a_leaf, oid('a'), passing(1));
        tree.harvest(a).unwrap();
        assert!(tree.is_stale(tree.leaf(growing).unwrap()));
        assert_eq!(tree.transplantable().count(), 0);
        assert_eq!(
            tree.transplant_start(growing),
            Err(TreeError::NothingToTransplant(growing))
        );
        let on_head = tree.sprout(b, "z").unwrap();
        tree.submit(on_head, oid('b')).unwrap();
        assert_eq!(
            tree.transplant_start(on_head),
            Err(TreeError::NotStale(on_head))
        );
    }

    #[test]
    fn a_bud_regrows_a_bounded_number_of_times() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let slow = tree.bud_new("slow", vec![]).unwrap();
        let mut leaf = tree.sprout(slow, "s").unwrap();
        for round in 0..MAX_REGROWTHS {
            let fast = tree.bud_new(format!("fast {round}"), vec![]).unwrap();
            let fast_leaf = tree.sprout(fast, "f").unwrap();
            ripen(&mut tree, fast_leaf, oid('a'), passing(1));
            tree.harvest(fast).unwrap();
            leaf = tree.regrow(leaf).unwrap();
        }
        let last = tree.bud_new("last", vec![]).unwrap();
        let last_leaf = tree.sprout(last, "f").unwrap();
        ripen(&mut tree, last_leaf, oid('a'), passing(1));
        tree.harvest(last).unwrap();
        assert_eq!(
            tree.regrow(leaf),
            Err(TreeError::BudExhausted(slow, MAX_REGROWTHS))
        );
        // The bud is still open: its planter can wither it or split it.
        assert!(matches!(tree.bud(slow).unwrap().state, BudState::Open));
        assert!(tree.sprout(slow, "human").is_ok());
    }

    #[test]
    fn a_bud_carries_its_own_checks_and_refuses_broken_ones() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let check = |name: &str, run: &str| CheckSpec {
            name: name.into(),
            run: run.into(),
            timeout_secs: None,
        };
        let bud = tree
            .bud_new(
                "dark mode",
                vec![check("toggle", "grep -q dark-mode ui.css")],
            )
            .unwrap();
        assert_eq!(tree.bud(bud).unwrap().checks.len(), 1);
        assert_eq!(
            tree.bud_new("x", vec![check("a", "true"), check("a", "true")]),
            Err(TreeError::BudChecks(ChecksError::DuplicateName("a".into())))
        );
        assert_eq!(
            tree.bud_new("x", vec![check("a", " ")]),
            Err(TreeError::BudChecks(ChecksError::EmptyRun("a".into())))
        );
    }

    #[test]
    fn harvest_next_takes_the_oldest_bud_that_is_ready() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let old = tree.bud_new("old", vec![]).unwrap();
        let mid = tree.bud_new("mid", vec![]).unwrap();
        let new = tree.bud_new("new", vec![]).unwrap();
        let old_leaf = tree.sprout(old, "a").unwrap();
        let mid_leaf = tree.sprout(mid, "b").unwrap();
        let new_leaf = tree.sprout(new, "c").unwrap();
        assert_eq!(tree.harvest_next(), Err(TreeError::NothingRipe));
        ripen(&mut tree, new_leaf, oid('c'), passing(1));
        ripen(&mut tree, mid_leaf, oid('b'), passing(1));
        assert_eq!(tree.harvestable().collect::<Vec<_>>(), vec![mid, new]);
        assert_eq!(tree.harvest_next().unwrap().fruit, mid_leaf);
        // `new` is stale now, and `old` never ripened.
        assert_eq!(tree.harvestable().count(), 0);
        assert_eq!(tree.harvest_next(), Err(TreeError::NothingRipe));
        let _ = old_leaf;
    }

    #[test]
    fn a_release_points_at_a_node_and_moving_it_back_is_a_rollback() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        assert!(tree.released().is_none());
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        ripen(&mut tree, leaf, oid('a'), passing(1));
        let harvest = tree.harvest(bud).unwrap();
        assert_eq!(
            tree.release(harvest.node),
            Ok(Release {
                node: harvest.node,
                previous: None,
                rollback: false
            })
        );
        assert_eq!(tree.released().unwrap().commit, oid('a'));
        assert_eq!(
            tree.release(NodeId(0)),
            Ok(Release {
                node: NodeId(0),
                previous: Some(harvest.node),
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

    #[test]
    fn a_tree_saved_before_transplants_still_loads() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent", vec![]).unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        ripen(&mut tree, leaf, oid('a'), passing(1));
        tree.harvest(bud).unwrap();
        let mut json: serde_json::Value = serde_json::to_value(&tree).unwrap();
        for node in json["nodes"].as_object_mut().unwrap().values_mut() {
            node.as_object_mut().unwrap().remove("touched");
        }
        for leaf in json["leaves"].as_object_mut().unwrap().values_mut() {
            let fields = leaf.as_object_mut().unwrap();
            for field in ["touched", "transplant", "transplant_of"] {
                fields.remove(field);
            }
        }
        for bud in json["buds"].as_object_mut().unwrap().values_mut() {
            let fields = bud.as_object_mut().unwrap();
            fields.remove("checks");
            fields.remove("regrowths");
        }
        json.as_object_mut().unwrap().remove("released");
        assert_eq!(serde_json::from_value::<Tree>(json).unwrap(), tree);
    }
}
