//! Reading a tree's repos: which repo and commit an attempt or node shows, and
//! the refs and paths a reader may ask for.
//!
//! Every repo a tree owns is either a node's (the root, or an accepted
//! attempt's repo) or an attempt's, so a reader names the attempt or node and the tree picks
//! the repo. A reader never names a repo directly: that is what keeps one
//! tree's reads inside its own repos.

use crate::tree::{AttemptId, AttemptState, NodeId, Oid, RepoName, Tree, TreeError};

/// What a reader asks to see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject {
    Attempt(AttemptId),
    Node(NodeId),
}

/// The repo behind a subject and the commit it is pinned to, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub repo: RepoName,
    /// `None` while the attempt is still moving (working, or closed before it
    /// was submitted): read its default branch.
    pub pinned: Option<Oid>,
}

impl Tree {
    pub fn view(&self, subject: Subject) -> Result<View, TreeError> {
        match subject {
            Subject::Node(id) => {
                let node = self.node(id).ok_or(TreeError::UnknownNode(id))?;
                Ok(View {
                    repo: node.repo.clone(),
                    pinned: Some(node.commit.clone()),
                })
            }
            Subject::Attempt(id) => {
                let attempt = self.attempt(id).ok_or(TreeError::UnknownAttempt(id))?;
                let pinned = match &attempt.state {
                    AttemptState::Working | AttemptState::Closed { .. } => None,
                    AttemptState::Checking { commit } | AttemptState::Scored { commit, .. } => {
                        Some(commit.clone())
                    }
                    AttemptState::Accepted { node } => self.node(*node).map(|node| node.commit.clone()),
                };
                Ok(View {
                    repo: attempt.repo.clone(),
                    pinned,
                })
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BrowseError {
    #[error("not a ref: {0:?}")]
    MalformedRef(String),
    #[error("not a path inside the repo: {0:?}")]
    MalformedPath(String),
}

/// A branch, tag or commit id, as git's `check-ref-format` would accept it
/// (less the rules that only matter when creating a ref).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRef(String);

const REF_MAX: usize = 255;

impl GitRef {
    pub fn parse(text: &str) -> Result<Self, BrowseError> {
        let well_formed = !text.is_empty()
            && text.len() <= REF_MAX
            && !text.starts_with(['-', '/'])
            && !text.ends_with(['/', '.'])
            && !text.contains("..")
            && !text.contains("//")
            && !text.contains("@{")
            && text
                .chars()
                .all(|c| !c.is_control() && !c.is_whitespace() && !"~^:?*[\\".contains(c));
        if well_formed {
            Ok(Self(text.to_owned()))
        } else {
            Err(BrowseError::MalformedRef(text.to_owned()))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A path inside a repo: zero or more names, never `.` or `..`. The empty
/// path is the repo's root directory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FilePath(Vec<String>);

const PATH_MAX: usize = 4096;

impl FilePath {
    pub fn parse(text: &str) -> Result<Self, BrowseError> {
        let malformed = || BrowseError::MalformedPath(text.to_owned());
        if text.len() > PATH_MAX {
            return Err(malformed());
        }
        let trimmed = text.trim_matches('/');
        if trimmed.is_empty() {
            return Ok(Self::default());
        }
        trimmed
            .split('/')
            .map(|name| match name {
                "" | "." | ".." => Err(malformed()),
                _ if name.contains('\0') => Err(malformed()),
                _ => Ok(name.to_owned()),
            })
            .collect::<Result<_, _>>()
            .map(Self)
    }

    pub fn names(&self) -> &[String] {
        &self.0
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    /// The path as git writes it: names joined by `/`, no leading slash.
    pub fn joined(&self) -> String {
        self.0.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::Score;

    fn oid(c: char) -> Oid {
        Oid::try_from(c.to_string().repeat(40)).unwrap()
    }

    fn initialized() -> Tree {
        Tree::init(RepoName::try_from("t-site".to_owned()).unwrap(), oid('a')).unwrap()
    }

    #[test]
    fn a_node_is_pinned_to_its_commit() {
        let tree = initialized();
        let root = tree.head().id;
        assert_eq!(
            tree.view(Subject::Node(root)).unwrap(),
            View {
                repo: tree.name().clone(),
                pinned: Some(oid('a')),
            }
        );
    }

    #[test]
    fn an_attempt_is_pinned_once_submitted() {
        let mut tree = initialized();
        let task = tree.task_new("fix it", Vec::new()).unwrap();
        let attempt = tree.start(task, "alpha").unwrap();
        assert_eq!(tree.view(Subject::Attempt(attempt)).unwrap().pinned, None);

        tree.submit(attempt, oid('b')).unwrap();
        assert_eq!(
            tree.view(Subject::Attempt(attempt)).unwrap().pinned,
            Some(oid('b'))
        );

        tree.scored(attempt, Score::new(1, 1, 3).unwrap(), Vec::new())
            .unwrap();
        assert_eq!(
            tree.view(Subject::Attempt(attempt)).unwrap().pinned,
            Some(oid('b'))
        );

        tree.accept(task).unwrap();
        let view = tree.view(Subject::Attempt(attempt)).unwrap();
        assert_eq!(view.pinned, Some(oid('b')));
        assert_eq!(view.repo, tree.attempt(attempt).unwrap().repo);
    }

    #[test]
    fn unknown_subjects_are_errors() {
        let tree = initialized();
        let missing_attempt = "7".parse().unwrap();
        let missing_node = "7".parse().unwrap();
        assert_eq!(
            tree.view(Subject::Attempt(missing_attempt)),
            Err(TreeError::UnknownAttempt(missing_attempt))
        );
        assert_eq!(
            tree.view(Subject::Node(missing_node)),
            Err(TreeError::UnknownNode(missing_node))
        );
    }

    #[test]
    fn refs() {
        for good in ["main", "feature/x", "v1.2", &"a".repeat(40)] {
            assert!(GitRef::parse(good).is_ok(), "{good}");
        }
        for bad in [
            "", "-x", "/x", "x/", "x.", "a..b", "a//b", "a b", "a~1", "a^", "a:b", "@{-1}", "a\nb",
        ] {
            assert!(GitRef::parse(bad).is_err(), "{bad:?}");
        }
        assert!(GitRef::parse(&"a".repeat(REF_MAX + 1)).is_err());
    }

    #[test]
    fn paths() {
        assert!(FilePath::parse("").unwrap().is_root());
        assert!(FilePath::parse("/").unwrap().is_root());
        let path = FilePath::parse("/src/lib.rs").unwrap();
        assert_eq!(path.names(), ["src", "lib.rs"]);
        assert_eq!(path.joined(), "src/lib.rs");
        for bad in ["a//b", "../etc", "a/./b", "a/..", "a\0b"] {
            assert!(FilePath::parse(bad).is_err(), "{bad:?}");
        }
        assert!(FilePath::parse(&"a".repeat(PATH_MAX + 1)).is_err());
    }
}
