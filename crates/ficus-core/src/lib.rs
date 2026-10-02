//! Ficus domain logic. Nothing here may depend on the Workers runtime, so it
//! builds and tests natively under `cargo nextest run`.

pub mod tree;

/// A repository's `owner/name` path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPath {
    pub owner: String,
    pub name: String,
}

impl RepoPath {
    pub fn parse(path: &str) -> Option<Self> {
        let (owner, name) = path.trim_matches('/').split_once('/')?;
        let name = name.strip_suffix(".git").unwrap_or(name);
        if owner.is_empty() || name.is_empty() || name.contains('/') {
            return None;
        }
        Some(Self {
            owner: owner.into(),
            name: name.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_owner_and_name() {
        let p = RepoPath::parse("/butch78/ficus.git").unwrap();
        assert_eq!((p.owner.as_str(), p.name.as_str()), ("butch78", "ficus"));
    }

    #[test]
    fn rejects_malformed() {
        assert!(RepoPath::parse("ficus").is_none());
        assert!(RepoPath::parse("a/b/c").is_none());
    }
}
