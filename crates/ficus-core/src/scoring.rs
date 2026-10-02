//! How a leaf is scored: the root's `ficus.toml`, the request the Worker
//! sends the scorer, and the report that comes back.
//!
//! The checks always come from the leaf's **base** commit, never from the
//! leaf: an agent that edits `ficus.toml` or the devenv files has edited
//! files the scorer puts back before it runs anything (`LOCKED_PATHS`).
//!
//! A root has two kinds of check. A `[[check]]` is a command, run by the
//! scorer in the container. A `[[judge]]` is a yes/no question about the
//! diff, asked of Clef (Cloudflare's decision model) by the sandbox once the
//! container is gone: "yes" passes when Clef gives it at least `pass_at`.
//! Both count the same towards a leaf's score.

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

/// A judge passes when Clef answers yes with at least this probability,
/// unless `ficus.toml` says otherwise.
pub const DEFAULT_PASS_AT: f64 = 0.5;

/// Characters of diff a judge sees. Clef reads 65,536 tokens, the task
/// included; a diff past this is cut at a line end and marked.
pub const JUDGE_DIFF_CHARS: usize = 120_000;

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

/// A yes/no question Clef answers about a leaf, seeing `{ task, diff }`:
/// the bud's intent and the leaf's diff from its base.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JudgeSpec {
    /// Also Clef's question id: letters, digits, `_`, `.`, `-`, at most 100.
    pub name: String,
    /// The question, phrased so that yes passes, such as "Does `diff` do
    /// everything `task` asks?"
    pub ask: String,
    /// What a yes means. Given together with `no`, or not at all.
    pub yes: Option<String>,
    /// What a no means.
    pub no: Option<String>,
    /// The least probability of yes that passes; in (0, 1].
    pub pass_at: Option<f64>,
}

impl JudgeSpec {
    pub fn pass_at(&self) -> f64 {
        self.pass_at.unwrap_or(DEFAULT_PASS_AT)
    }
}

/// The root's `ficus.toml`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootChecks {
    #[serde(rename = "check", default)]
    pub checks: Vec<CheckSpec>,
    #[serde(rename = "judge", default)]
    pub judges: Vec<JudgeSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChecksError {
    #[error("ficus.toml does not parse: {0}")]
    Unparsable(String),
    #[error("ficus.toml defines no checks or judges, so nothing could ever pass")]
    NoChecks,
    #[error("check {0:?} appears twice in ficus.toml")]
    DuplicateName(String),
    #[error("check {0:?} has an empty `run`")]
    EmptyRun(String),
    #[error("judge {0:?} has an empty `ask`")]
    EmptyAsk(String),
    #[error("judge {0:?}: a name is letters, digits, `_`, `.` and `-`, at most 100 of them")]
    JudgeName(String),
    #[error("judge {0:?}: `yes` and `no` come together or not at all")]
    HalfCriteria(String),
    #[error("judge {0:?}: `pass_at` must be above 0 and at most 1")]
    PassAt(String),
}

impl RootChecks {
    pub fn parse(text: &str) -> Result<Self, ChecksError> {
        let parsed: Self =
            toml::from_str(text).map_err(|error| ChecksError::Unparsable(error.to_string()))?;
        if parsed.checks.is_empty() && parsed.judges.is_empty() {
            return Err(ChecksError::NoChecks);
        }
        // One namespace: judges and checks land side by side in a report.
        let mut seen = std::collections::BTreeSet::new();
        let names = parsed.checks.iter().map(|check| &check.name);
        for name in names.chain(parsed.judges.iter().map(|judge| &judge.name)) {
            if !seen.insert(name.as_str()) {
                return Err(ChecksError::DuplicateName(name.clone()));
            }
        }
        for check in &parsed.checks {
            if check.run.trim().is_empty() {
                return Err(ChecksError::EmptyRun(check.name.clone()));
            }
        }
        for judge in &parsed.judges {
            let named = !judge.name.is_empty()
                && judge.name.len() <= 100
                && judge
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte));
            if !named {
                return Err(ChecksError::JudgeName(judge.name.clone()));
            }
            if judge.ask.trim().is_empty() {
                return Err(ChecksError::EmptyAsk(judge.name.clone()));
            }
            if judge.yes.is_some() != judge.no.is_some() {
                return Err(ChecksError::HalfCriteria(judge.name.clone()));
            }
            let pass_at = judge.pass_at();
            if !(pass_at > 0.0 && pass_at <= 1.0) {
                return Err(ChecksError::PassAt(judge.name.clone()));
            }
        }
        Ok(parsed)
    }
}

/// The first [`JUDGE_DIFF_CHARS`] characters of `diff`, cut at a line end,
/// marked when cut.
pub fn clip_diff(diff: &str) -> String {
    if diff.chars().count() <= JUDGE_DIFF_CHARS {
        return diff.to_owned();
    }
    let limit = diff
        .char_indices()
        .nth(JUDGE_DIFF_CHARS)
        .map_or(diff.len(), |(index, _)| index);
    let cut = diff[..limit].rfind('\n').unwrap_or(limit);
    format!(
        "{}\n[diff truncated: {} characters in all]",
        &diff[..cut],
        diff.chars().count()
    )
}

/// What the tree asks the sandbox: score `head` against `base`, reading the
/// leaf at `remote` with `token`. Worker-side only: the sandbox keeps the
/// token in its egress handler and hands the container a [`LeafRef`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreRequest {
    pub remote: String,
    pub token: String,
    pub base: Oid,
    pub head: Oid,
    /// The bud's intent: the `task` the root's judges see.
    pub intent: String,
}

impl ScoreRequest {
    pub fn leaf(&self) -> LeafRef {
        LeafRef {
            remote: self.remote.clone(),
            base: self.base.clone(),
            head: self.head.clone(),
        }
    }
}

/// What the container is told: a leaf to clone and the two commits to
/// compare. No credentials: the sandbox's egress handler adds them on the
/// way out, for this repo only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeafRef {
    pub remote: String,
    pub base: Oid,
    pub head: Oid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckOutcome {
    pub name: String,
    pub passed: bool,
    pub millis: u64,
    /// The end of the check's combined output, for the agent that regrows;
    /// for a judge, Clef's answer.
    pub tail: String,
    /// A judge's probability of yes, in thousandths. `None` for a command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<u16>,
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
        let score = Score::new(passed, count(self.checks.len())?, self.cost)?;
        let judged: Vec<u64> = self
            .checks
            .iter()
            .filter_map(|check| check.confidence.map(u64::from))
            .collect();
        Ok(match u64::try_from(judged.len()) {
            Ok(n) if n > 0 => {
                score.judged(u16::try_from(judged.iter().sum::<u64>() / n).unwrap_or(u16::MAX))
            }
            Ok(_) | Err(_) => score,
        })
    }
}

/// What `ficus-scorer check` prints: the command checks' report, and what
/// the sandbox needs to put the root's judges to Clef. The sandbox adds the
/// judges' outcomes to `report` and passes on the report alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckRun {
    pub report: ScoreReport,
    pub judges: Vec<JudgeSpec>,
    /// The leaf's diff from its base outside `LOCKED_PATHS`, clipped to
    /// [`JUDGE_DIFF_CHARS`]; empty when the root has no judges.
    pub diff: String,
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
            confidence: None,
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

    #[test]
    fn parses_judges_beside_checks() {
        let root = RootChecks::parse(
            r#"
            [[check]]
            name = "test"
            run = "pytest -q"

            [[judge]]
            name = "does_the_task"
            ask = "Does `diff` do everything `task` asks?"
            yes = "The whole task is done."
            no = "Part of the task is missing."
            pass_at = 0.7

            [[judge]]
            name = "no-debug.prints"
            ask = "Is `diff` free of leftover debug output?"
            "#,
        )
        .unwrap();
        let judges: Vec<_> = root
            .judges
            .iter()
            .map(|judge| (judge.name.as_str(), judge.pass_at()))
            .collect();
        assert_eq!(
            judges,
            vec![("does_the_task", 0.7), ("no-debug.prints", DEFAULT_PASS_AT)]
        );
        let only_judges = "[[judge]]\nname = \"a\"\nask = \"Is it good?\"\n";
        assert_eq!(RootChecks::parse(only_judges).unwrap().checks, vec![]);
    }

    #[test]
    fn rejects_judges_clef_could_not_ask_or_pass() {
        let judge = |fields: &str| RootChecks::parse(&format!("[[judge]]\n{fields}\n"));
        assert_eq!(
            RootChecks::parse(
                "[[check]]\nname = \"a\"\nrun = \"true\"\n[[judge]]\nname = \"a\"\nask = \"?\"\n"
            ),
            Err(ChecksError::DuplicateName("a".into()))
        );
        assert_eq!(
            judge("name = \"has space\"\nask = \"?\""),
            Err(ChecksError::JudgeName("has space".into()))
        );
        assert_eq!(
            judge("name = \"a\"\nask = \" \""),
            Err(ChecksError::EmptyAsk("a".into()))
        );
        assert_eq!(
            judge("name = \"a\"\nask = \"?\"\nyes = \"good\""),
            Err(ChecksError::HalfCriteria("a".into()))
        );
        for pass_at in ["0", "1.5", "-0.2", "nan"] {
            assert_eq!(
                judge(&format!("name = \"a\"\nask = \"?\"\npass_at = {pass_at}")),
                Err(ChecksError::PassAt("a".into()))
            );
        }
    }

    #[test]
    fn a_report_with_judges_scores_their_mean_confidence() {
        let judged = |name: &str, confidence| CheckOutcome {
            name: name.into(),
            passed: true,
            millis: 1,
            tail: String::new(),
            confidence: Some(confidence),
        };
        let report = ScoreReport {
            checks: vec![
                CheckOutcome {
                    name: "test".into(),
                    passed: true,
                    millis: 1,
                    tail: String::new(),
                    confidence: None,
                },
                judged("a", 900),
                judged("b", 700),
            ],
            cost: 4,
        };
        let score = report.score().unwrap();
        assert_eq!((score.checks_total(), score.confidence()), (3, Some(800)));
    }

    #[test]
    fn clip_diff_cuts_long_diffs_at_a_line_end() {
        assert_eq!(clip_diff("+a\n-b\n"), "+a\n-b\n");
        let line = format!("+{}\n", "é".repeat(99));
        let diff = line.repeat(JUDGE_DIFF_CHARS / 100 + 10);
        let clipped = clip_diff(&diff);
        let (body, marker) = clipped.rsplit_once('\n').unwrap();
        assert_eq!(
            marker,
            format!(
                "[diff truncated: {} characters in all]",
                diff.chars().count()
            )
        );
        assert!(body.chars().count() <= JUDGE_DIFF_CHARS);
        assert!(body.lines().all(|each| each == line.trim_end()));
    }
}
