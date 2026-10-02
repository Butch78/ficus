//! How a leaf is scored: the root's `ficus.toml`, the request the Worker
//! sends the scorer, and the report that comes back.
//!
//! The checks always come from the leaf's **base** commit, never from the
//! leaf: an agent that edits `ficus.toml` or the devenv files has edited
//! files the scorer puts back before it runs anything (`LOCKED_PATHS`).

use serde::{Deserialize, Serialize};

use crate::tree::{Oid, Score, TreeError};

/// Files the root owns. The scorer restores each from the base commit (or
/// deletes it if the base has none) before running a check, and leaves them
/// out of the cost.
pub const LOCKED_PATHS: &[&str] = &[
    "ficus.toml",
    "devenv.nix",
    "devenv.yaml",
    "devenv.lock",
    ".envrc",
];

/// A check that runs longer than this fails, unless `ficus.toml` says otherwise.
pub const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckSpec {
    pub name: String,
    /// A bash command, run from the repo root (inside `devenv shell` when the
    /// root has a `devenv.nix`).
    pub run: String,
    pub timeout_secs: Option<u64>,
}

impl CheckSpec {
    pub fn timeout_secs(&self) -> u64 {
        self.timeout_secs.unwrap_or(DEFAULT_CHECK_TIMEOUT_SECS)
    }
}

/// The root's `ficus.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootChecks {
    #[serde(rename = "check")]
    pub checks: Vec<CheckSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChecksError {
    #[error("ficus.toml does not parse: {0}")]
    Unparsable(String),
    #[error("ficus.toml defines no checks, so nothing could ever pass")]
    NoChecks,
    #[error("check {0:?} appears twice in ficus.toml")]
    DuplicateName(String),
    #[error("check {0:?} has an empty `run`")]
    EmptyRun(String),
}

impl RootChecks {
    pub fn parse(text: &str) -> Result<Self, ChecksError> {
        let parsed: Self =
            toml::from_str(text).map_err(|error| ChecksError::Unparsable(error.to_string()))?;
        if parsed.checks.is_empty() {
            return Err(ChecksError::NoChecks);
        }
        let mut seen = std::collections::BTreeSet::new();
        for check in &parsed.checks {
            if !seen.insert(check.name.as_str()) {
                return Err(ChecksError::DuplicateName(check.name.clone()));
            }
            if check.run.trim().is_empty() {
                return Err(ChecksError::EmptyRun(check.name.clone()));
            }
        }
        Ok(parsed)
    }
}

/// What the Worker asks the scorer: clone `remote` with the read `token` and
/// score `head` against `base`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreRequest {
    pub remote: String,
    pub token: String,
    pub base: Oid,
    pub head: Oid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckOutcome {
    pub name: String,
    pub passed: bool,
    pub millis: u64,
    /// The end of the check's combined output, for the agent that regrows.
    pub tail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScoreReport {
    pub checks: Vec<CheckOutcome>,
    /// Lines added plus lines deleted between base and head, outside
    /// `LOCKED_PATHS`; a binary file counts as one line.
    pub cost: u64,
}

impl ScoreReport {
    pub fn score(&self) -> Result<Score, TreeError> {
        let count = |n: usize| u32::try_from(n).map_err(|_| TreeError::Full);
        let passed = count(self.checks.iter().filter(|check| check.passed).count())?;
        Score::new(passed, count(self.checks.len())?, self.cost)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_checks_with_default_timeout() {
        let root = RootChecks::parse(
            r#"
            [[check]]
            name = "test"
            run = "pytest -q"

            [[check]]
            name = "lint"
            run = "ruff check ."
            timeout_secs = 60
            "#,
        )
        .unwrap();
        let names: Vec<_> = root
            .checks
            .iter()
            .map(|c| (c.name.as_str(), c.timeout_secs()))
            .collect();
        assert_eq!(
            names,
            vec![("test", DEFAULT_CHECK_TIMEOUT_SECS), ("lint", 60)]
        );
    }

    #[test]
    fn rejects_roots_that_could_never_pass_or_are_ambiguous() {
        assert_eq!(RootChecks::parse("check = []"), Err(ChecksError::NoChecks));
        let twice =
            "[[check]]\nname = \"a\"\nrun = \"true\"\n[[check]]\nname = \"a\"\nrun = \"true\"\n";
        assert_eq!(
            RootChecks::parse(twice),
            Err(ChecksError::DuplicateName("a".into()))
        );
        assert_eq!(
            RootChecks::parse("[[check]]\nname = \"a\"\nrun = \"  \"\n"),
            Err(ChecksError::EmptyRun("a".into()))
        );
        assert!(matches!(
            RootChecks::parse("[[check]]\nname = \"a\"\n"),
            Err(ChecksError::Unparsable(_))
        ));
        assert!(matches!(
            RootChecks::parse("[[check]]\nname = \"a\"\nrun = \"x\"\nsudo = true\n"),
            Err(ChecksError::Unparsable(_))
        ));
    }

    #[test]
    fn a_report_scores_passed_over_total_at_its_cost() {
        let outcome = |name: &str, passed| CheckOutcome {
            name: name.into(),
            passed,
            millis: 1,
            tail: String::new(),
        };
        let report = ScoreReport {
            checks: vec![outcome("a", true), outcome("b", false), outcome("c", true)],
            cost: 12,
        };
        let score = report.score().unwrap();
        assert_eq!(
            (
                score.checks_passed(),
                score.checks_total(),
                score.cost(),
                score.passes()
            ),
            (2, 3, 12, false)
        );
        assert_eq!(
            ScoreReport {
                checks: vec![],
                cost: 0
            }
            .score(),
            Err(TreeError::ImpossibleScore {
                checks_passed: 0,
                checks_total: 0
            })
        );
    }
}
