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
//! against the new head. Instead it is **regrown**: the agent starts again
//! from the head, with the same intent and the compost of earlier attempts.
//! A conflict becomes another attempt rather than a three-way merge.
//!
//! Every pruned leaf goes to the **compost**: who grew it, why it lost and
//! how it scored. That is the context later attempts start from.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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
/// size) is the root's choice; the tree only needs it to be comparable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Score {
    checks_passed: u32,
    checks_total: u32,
    cost: u64,
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
        })
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
    #[error("bud {0:?} has no ripe leaf on the head that passes every check")]
    NothingToHarvest(BudId),
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
        };
        Ok(Self {
            name,
            head: root,
            next_id: 1,
            nodes: BTreeMap::from([(root, node)]),
            buds: BTreeMap::new(),
            leaves: BTreeMap::new(),
            compost: Vec::new(),
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

    pub fn bud_new(&mut self, intent: impl Into<String>) -> Result<BudId, TreeError> {
        let intent = intent.into();
        if intent.trim().is_empty() {
            return Err(TreeError::EmptyIntent);
        }
        let id = BudId(self.take_id()?);
        self.buds.insert(
            id,
            Bud {
                id,
                intent,
                state: BudState::Open,
            },
        );
        Ok(id)
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

    /// Record how the root's checks scored a submitted leaf.
    pub fn ripen(&mut self, leaf: LeafId, score: Score) -> Result<(), TreeError> {
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
        let (bud, agent) = (old.bud, old.agent.clone());
        let fresh = self.sprout(bud, agent)?;
        self.prune(stale, PruneReason::Regrown { into: fresh })?;
        Ok(fresh)
    }

    /// Turn the best ripe leaf of `bud` into fruit and move the head onto it.
    ///
    /// Only leaves that grew from the head are candidates: anything older was
    /// checked against a tree that no longer exists. The winner passes every
    /// check and has the lowest cost; on equal cost the earliest leaf wins.
    pub fn harvest(&mut self, bud: BudId) -> Result<Harvest, TreeError> {
        self.open_bud(bud)?;
        let (fruit, commit, repo) = self
            .leaves_of(bud)
            .filter(|leaf| leaf.base == self.head)
            .filter_map(|leaf| match &leaf.state {
                LeafState::Ripe { commit, score } if score.passes() => {
                    Some((leaf.id, commit, &leaf.repo, score.cost()))
                }
                LeafState::Ripe { .. }
                | LeafState::Growing
                | LeafState::Ripening { .. }
                | LeafState::Fruit { .. }
                | LeafState::Pruned { .. } => None,
            })
            .min_by_key(|&(id, _, _, cost)| (cost, id))
            .map(|(id, commit, repo, _)| (id, commit.clone(), repo.clone()))
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
        tree.ripen(leaf, score).unwrap();
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
    fn harvest_takes_the_cheapest_passing_leaf_and_prunes_the_rest() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let root = tree.head().id;
        let bud = tree.bud_new("add a /health route").unwrap();
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
        let bud = tree.bud_new("intent").unwrap();
        let first = tree.sprout(bud, "a").unwrap();
        let second = tree.sprout(bud, "b").unwrap();
        ripen(&mut tree, second, oid('b'), passing(5));
        ripen(&mut tree, first, oid('a'), passing(5));
        assert_eq!(tree.harvest(bud).unwrap().fruit, first);
    }

    #[test]
    fn nothing_to_harvest_without_a_passing_ripe_leaf() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent").unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        assert_eq!(tree.harvest(bud), Err(TreeError::NothingToHarvest(bud)));
        ripen(&mut tree, leaf, oid('a'), Score::new(0, 1, 0).unwrap());
        assert_eq!(tree.harvest(bud), Err(TreeError::NothingToHarvest(bud)));
        assert_eq!(tree.head().id, NodeId(0));
    }

    #[test]
    fn a_harvest_makes_other_buds_stale_and_they_regrow_instead_of_merging() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let auth = tree.bud_new("add auth").unwrap();
        let search = tree.bud_new("add search").unwrap();
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
        let bud = tree.bud_new("intent").unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        assert_eq!(tree.regrow(leaf), Err(TreeError::NotStale(leaf)));
    }

    #[test]
    fn a_fruited_bud_takes_no_more_leaves() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent").unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        ripen(&mut tree, leaf, oid('a'), passing(1));
        tree.harvest(bud).unwrap();
        assert_eq!(tree.sprout(bud, "late"), Err(TreeError::BudFruited(bud)));
        assert_eq!(tree.harvest(bud), Err(TreeError::BudFruited(bud)));
    }

    #[test]
    fn a_leaf_ripens_once_and_withers_into_the_compost() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        let bud = tree.bud_new("intent").unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        tree.submit(leaf, oid('a')).unwrap();
        assert_eq!(
            tree.submit(leaf, oid('b')),
            Err(TreeError::NotGrowing(leaf))
        );
        tree.ripen(leaf, passing(1)).unwrap();
        assert_eq!(
            tree.ripen(leaf, passing(0)),
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
        let bud = tree.bud_new("intent").unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        assert_eq!(
            tree.ripen(leaf, passing(1)),
            Err(TreeError::NotRipening(leaf))
        );
        tree.submit(leaf, oid('a')).unwrap();
        let waiting: Vec<_> = tree.ripening().map(|(l, c)| (l.id, c.clone())).collect();
        assert_eq!(waiting, vec![(leaf, oid('a'))]);
        assert_eq!(tree.harvest(bud), Err(TreeError::NothingToHarvest(bud)));
        tree.ripen(leaf, passing(1)).unwrap();
        assert_eq!(tree.ripening().count(), 0);
        assert_eq!(tree.harvest(bud).unwrap().fruit, leaf);
    }

    #[test]
    fn empty_intent_is_refused() {
        let mut tree = Tree::plant(repo("t"), oid('0')).unwrap();
        assert_eq!(tree.bud_new("  "), Err(TreeError::EmptyIntent));
    }

    #[test]
    fn leaves_get_their_own_repo_and_harvest_hands_it_to_the_node() {
        let mut tree = Tree::plant(repo("site"), oid('0')).unwrap();
        assert_eq!(tree.head().repo, repo("site"));
        let bud = tree.bud_new("intent").unwrap();
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
        let bud = tree.bud_new("intent").unwrap();
        let leaf = tree.sprout(bud, "a").unwrap();
        ripen(&mut tree, leaf, oid('a'), passing(1));
        let json = serde_json::to_string(&tree).unwrap();
        assert_eq!(serde_json::from_str::<Tree>(&json).unwrap(), tree);
        let bad = json.replace(&"0".repeat(40), "not-an-oid");
        assert!(serde_json::from_str::<Tree>(&bad).is_err());
    }
}
