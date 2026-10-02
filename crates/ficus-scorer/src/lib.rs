//! Score a leaf: clone it, put the root's locked files back from the base
//! commit, run the root's checks (inside the root's devenv when it has one),
//! and measure the diff.

pub mod sandbox;

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use ficus_core::scoring::{
    CheckOutcome, ChecksError, LOCKED_PATHS, RootChecks, ScoreReport, ScoreRequest,
};
use tokio::process::Command;

/// Bytes of a check's output kept for the report.
const TAIL_BYTES: usize = 4000;
/// Building a root's devenv shell from cold can take a while; it is paid once
/// per container, before any check's own timeout starts.
const DEVENV_PREPARE_SECS: u64 = 1200;

#[derive(Debug, thiserror::Error)]
pub enum ScoreError {
    #[error("git {step} failed: {stderr}")]
    Git { step: &'static str, stderr: String },
    #[error("the base commit has no ficus.toml, so the root defines no checks")]
    NoRootChecks,
    #[error(transparent)]
    RootChecks(#[from] ChecksError),
    #[error("head does not descend from base")]
    NotDescendant,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl ScoreError {
    /// Whether the leaf or root is at fault (as opposed to the scorer).
    pub fn is_input_problem(&self) -> bool {
        match self {
            Self::NoRootChecks | Self::RootChecks(_) | Self::NotDescendant => true,
            Self::Git { .. } | Self::Io(_) => false,
        }
    }
}

pub async fn score(request: &ScoreRequest) -> Result<ScoreReport, ScoreError> {
    let workdir = tempfile::tempdir()?;
    let repo = workdir.path().join("leaf");
    let header = format!("http.extraHeader=Authorization: Bearer {}", request.token);
    let repo_arg = repo.to_string_lossy().into_owned();
    git(
        workdir.path(),
        "clone",
        &[
            "-c",
            &header,
            "clone",
            "--quiet",
            "--no-checkout",
            &request.remote,
            &repo_arg,
        ],
    )
    .await?;

    let (base, head) = (request.base.as_str(), request.head.as_str());
    git(
        &repo,
        "checkout",
        &["checkout", "--quiet", "--detach", head],
    )
    .await?;
    if !succeeds(&repo, &["merge-base", "--is-ancestor", base, head]).await? {
        return Err(ScoreError::NotDescendant);
    }

    let root_toml = match git(
        &repo,
        "show ficus.toml",
        &["show", &format!("{base}:ficus.toml")],
    )
    .await
    {
        Ok(text) => text,
        Err(ScoreError::Git { .. }) => return Err(ScoreError::NoRootChecks),
        Err(other) => return Err(other),
    };
    let root = RootChecks::parse(&root_toml)?;

    let mut root_has_devenv = false;
    for path in LOCKED_PATHS {
        if succeeds(&repo, &["cat-file", "-e", &format!("{base}:{path}")]).await? {
            git(
                &repo,
                "restore locked file",
                &["checkout", "--quiet", base, "--", path],
            )
            .await?;
            root_has_devenv |= *path == "devenv.nix";
        } else {
            match tokio::fs::remove_file(repo.join(path)).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    let checks = if root_has_devenv {
        let prepare = run(
            &repo,
            &["devenv", "--quiet", "shell", "--", "true"],
            DEVENV_PREPARE_SECS,
        )
        .await?;
        if prepare.passed {
            run_checks(&repo, &root, true).await?
        } else {
            let tail = format!("the root's devenv shell did not build:\n{}", prepare.tail);
            root.checks
                .iter()
                .map(|check| CheckOutcome {
                    name: check.name.clone(),
                    passed: false,
                    millis: 0,
                    tail: tail.clone(),
                })
                .collect()
        }
    } else {
        run_checks(&repo, &root, false).await?
    };

    let cost = diff_cost(&repo, base, head).await?;
    Ok(ScoreReport { checks, cost })
}

async fn run_checks(
    repo: &Path,
    root: &RootChecks,
    in_devenv: bool,
) -> Result<Vec<CheckOutcome>, ScoreError> {
    let mut outcomes = Vec::with_capacity(root.checks.len());
    for check in &root.checks {
        let argv: Vec<&str> = if in_devenv {
            vec!["devenv", "--quiet", "shell", "--", "bash", "-c", &check.run]
        } else {
            vec!["bash", "-c", &check.run]
        };
        let ran = run(repo, &argv, check.timeout_secs()).await?;
        outcomes.push(CheckOutcome {
            name: check.name.clone(),
            passed: ran.passed,
            millis: ran.millis,
            tail: ran.tail,
        });
    }
    Ok(outcomes)
}

struct Ran {
    passed: bool,
    millis: u64,
    tail: String,
}

async fn run(dir: &Path, argv: &[&str], timeout_secs: u64) -> Result<Ran, ScoreError> {
    let (program, args) = argv.split_first().expect("callers always pass a program");
    let started = Instant::now();
    let child = Command::new(program)
        .args(args)
        .current_dir(dir)
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let waited =
        tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await;
    let millis = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match waited {
        Ok(output) => {
            let output = output?;
            // stderr first: test runners report on stdout, and the tail
            // keeps the end.
            let mut text = String::from_utf8_lossy(&output.stderr).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stdout));
            Ok(Ran {
                passed: output.status.success(),
                millis,
                tail: tail(&text),
            })
        }
        // The child is killed when the timed-out future drops it.
        Err(_) => Ok(Ran {
            passed: false,
            millis,
            tail: format!("timed out after {timeout_secs}s"),
        }),
    }
}

/// The last `TAIL_BYTES` of `text`, cut on a character boundary.
fn tail(text: &str) -> String {
    let mut start = text.len().saturating_sub(TAIL_BYTES);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

/// Lines added plus deleted between base and head, outside the locked files.
async fn diff_cost(repo: &Path, base: &str, head: &str) -> Result<u64, ScoreError> {
    let excludes: Vec<String> = LOCKED_PATHS
        .iter()
        .map(|path| format!(":(exclude){path}"))
        .collect();
    let mut args = vec!["diff", "--numstat", base, head, "--", "."];
    args.extend(excludes.iter().map(String::as_str));
    let numstat = git(repo, "diff", &args).await?;
    Ok(numstat.lines().map(numstat_line_cost).sum())
}

/// One `git diff --numstat` line: `added<TAB>deleted<TAB>path`, with `-` for
/// both counts on a binary file, which counts as one line.
fn numstat_line_cost(line: &str) -> u64 {
    let mut fields = line.split('\t');
    match (fields.next(), fields.next()) {
        (Some("-"), Some("-")) => 1,
        (Some(added), Some(deleted)) => {
            added.parse::<u64>().unwrap_or(0) + deleted.parse::<u64>().unwrap_or(0)
        }
        _ => 0,
    }
}

async fn git(dir: &Path, step: &'static str, args: &[&str]) -> Result<String, ScoreError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .await?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(ScoreError::Git {
            step,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

async fn succeeds(dir: &Path, args: &[&str]) -> Result<bool, ScoreError> {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ficus_core::tree::Oid;

    /// A real git repo with a root commit and a leaf commit on top.
    struct Fixture {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("origin");
            std::fs::create_dir(&path).unwrap();
            let fixture = Self { _dir: dir, path };
            fixture.git(&["init", "--quiet", "-b", "main"]);
            fixture
        }

        fn git(&self, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .current_dir(&self.path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }

        fn commit(&self, files: &[(&str, &str)], deletions: &[&str]) -> Oid {
            for (path, body) in files {
                std::fs::write(self.path.join(path), body).unwrap();
            }
            for path in deletions {
                std::fs::remove_file(self.path.join(path)).unwrap();
            }
            self.git(&["add", "-A"]);
            self.git(&["commit", "--quiet", "--allow-empty", "-m", "c"]);
            Oid::try_from(self.git(&["rev-parse", "HEAD"])).unwrap()
        }

        fn request(&self, base: Oid, head: Oid) -> ScoreRequest {
            ScoreRequest {
                remote: self.path.to_string_lossy().into_owned(),
                token: "unused".into(),
                base,
                head,
            }
        }
    }

    const ROOT: &str = "[[check]]\nname = \"has-greeting\"\nrun = \"grep -q hello greeting.txt\"\n\n[[check]]\nname = \"no-todo\"\nrun = \"! grep -rq TODO --include=*.txt .\"\n";

    #[tokio::test]
    async fn runs_the_roots_checks_and_costs_the_diff() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hi\n")], &[]);
        let head = repo.commit(&[("greeting.txt", "hello\nworld\n")], &[]);
        let report = score(&repo.request(base, head)).await.unwrap();
        let passed: Vec<_> = report
            .checks
            .iter()
            .map(|c| (c.name.as_str(), c.passed))
            .collect();
        assert_eq!(passed, vec![("has-greeting", true), ("no-todo", true)]);
        // greeting.txt: 1 line deleted, 2 added.
        assert_eq!(report.cost, 3);
        assert!(report.score().unwrap().passes());
    }

    #[tokio::test]
    async fn a_failing_check_fails_and_keeps_its_output() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hello\n")], &[]);
        let head = repo.commit(&[("notes.txt", "TODO: finish\n")], &[]);
        let report = score(&repo.request(base, head)).await.unwrap();
        let no_todo = report.checks.iter().find(|c| c.name == "no-todo").unwrap();
        assert!(!no_todo.passed);
        assert!(!report.score().unwrap().passes());
    }

    #[tokio::test]
    async fn the_leaf_cannot_rewrite_or_delete_the_roots_checks() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hi\n")], &[]);
        // The agent replaces the checks with one that always passes, and
        // adds a devenv.nix the root never had.
        let cheat = "[[check]]\nname = \"has-greeting\"\nrun = \"true\"\n";
        let head = repo.commit(&[("ficus.toml", cheat), ("devenv.nix", "{ }")], &[]);
        let report = score(&repo.request(base.clone(), head)).await.unwrap();
        assert!(
            !report
                .checks
                .iter()
                .find(|c| c.name == "has-greeting")
                .unwrap()
                .passed
        );
        assert_eq!(
            report.checks.len(),
            2,
            "the root's two checks, not the leaf's one"
        );
        assert_eq!(report.cost, 0, "locked files are not part of the cost");

        let deleted = repo.commit(&[], &["ficus.toml", "devenv.nix"]);
        let report = score(&repo.request(base, deleted)).await.unwrap();
        assert_eq!(report.checks.len(), 2);
    }

    #[tokio::test]
    async fn a_root_without_ficus_toml_cannot_score_anything() {
        let repo = Fixture::new();
        let base = repo.commit(&[("greeting.txt", "hi\n")], &[]);
        let head = repo.commit(&[("greeting.txt", "hello\n")], &[]);
        assert!(matches!(
            score(&repo.request(base, head)).await,
            Err(ScoreError::NoRootChecks)
        ));
    }

    #[tokio::test]
    async fn head_must_descend_from_base() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hello\n")], &[]);
        repo.git(&["checkout", "--quiet", "--orphan", "other"]);
        // Different content: an identical tree, message and second would
        // produce the very same root commit as `base`.
        let unrelated = repo.commit(&[("greeting.txt", "hello, elsewhere\n")], &[]);
        let result = score(&repo.request(base, unrelated)).await;
        assert!(
            matches!(result, Err(ScoreError::NotDescendant)),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn a_check_that_overruns_its_timeout_fails() {
        let repo = Fixture::new();
        let slow = "[[check]]\nname = \"slow\"\nrun = \"sleep 5\"\ntimeout_secs = 1\n";
        let base = repo.commit(&[("ficus.toml", slow)], &[]);
        let head = repo.commit(&[("a.txt", "a\n")], &[]);
        let report = score(&repo.request(base, head)).await.unwrap();
        assert_eq!(
            (report.checks[0].passed, report.checks[0].tail.as_str()),
            (false, "timed out after 1s")
        );
    }

    #[test]
    fn numstat_counts_lines_and_binary_files() {
        assert_eq!(numstat_line_cost("3\t2\tsrc/a.rs"), 5);
        assert_eq!(numstat_line_cost("-\t-\timage.png"), 1);
        assert_eq!(numstat_line_cost(""), 0);
    }

    #[test]
    fn tail_keeps_the_end_on_a_char_boundary() {
        let long = format!("{}é{}", "a".repeat(10), "b".repeat(TAIL_BYTES - 1));
        let kept = tail(&long);
        assert!(kept.len() <= TAIL_BYTES && kept.ends_with('b') && !kept.contains('a'));
    }
}
