//! Score a leaf: clone it, put the root's locked files back from the base
//! commit, run the root's checks then the bud's (inside the root's devenv
//! when it has one), and measure the diff. The root's judges are not run
//! here (the container has no network): `check` hands them over with the
//! diff they judge.
//!
//! Also transplant a leaf: replay its commits onto a newer head in a fresh
//! leaf, so the checks can run there. Conflicts are reported, never
//! resolved: that is the agent's job, with the compost in hand.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use ficus_core::scoring::{
    CheckOrigin, CheckOutcome, CheckRun, CheckSpec, ChecksError, LOCKED_PATHS, LeafRef, RootChecks,
    ScoreReport, TransplantRef, TransplantReport, clip_diff,
};
use ficus_core::tree::Oid;
use serde::{Deserialize, Serialize};
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
    #[error("the leaf's commits do not apply on the head: conflicts in {}", .0.join(", "))]
    Conflict(Vec<String>),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl ScoreError {
    /// Whether the leaf or root is at fault (as opposed to the scorer).
    pub fn is_input_problem(&self) -> bool {
        match self {
            Self::NoRootChecks | Self::RootChecks(_) | Self::NotDescendant | Self::Conflict(_) => {
                true
            }
            Self::Git { .. } | Self::Io(_) => false,
        }
    }
}

/// Replay the commits of `from` after `from_base` onto `onto_head`, and push
/// the result to `onto`'s branch. Both remotes are reached through the
/// sandbox's egress, which holds the tokens. Nothing is run from the repo.
pub async fn transplant(root: &Path, job: &TransplantRef) -> Result<TransplantReport, ScoreError> {
    let workdir = root.join(format!("transplant-{}", job.from_head.as_str()));
    match tokio::fs::remove_dir_all(&workdir).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    tokio::fs::create_dir_all(&workdir).await?;
    let repo = workdir.join("onto");
    let repo_arg = repo.to_string_lossy().into_owned();
    git(
        &workdir,
        "clone",
        &["clone", "--quiet", "--no-checkout", &job.onto, &repo_arg],
    )
    .await?;
    let (from_base, from_head, onto_head) = (
        job.from_base.as_str(),
        job.from_head.as_str(),
        job.onto_head.as_str(),
    );
    git(
        &repo,
        "fetch the stale leaf",
        &["fetch", "--quiet", &job.from, from_head],
    )
    .await?;
    if !succeeds(
        &repo,
        &["merge-base", "--is-ancestor", from_base, from_head],
    )
    .await?
    {
        return Err(ScoreError::NotDescendant);
    }
    git(
        &repo,
        "checkout",
        &["checkout", "--quiet", "--detach", from_head],
    )
    .await?;
    let replayed = git(
        &repo,
        "count commits",
        &["rev-list", "--count", &format!("{from_base}..{from_head}")],
    )
    .await?;
    let replayed: u32 = replayed.trim().parse().unwrap_or(0);
    // A transplant has no author of its own; the commits keep theirs.
    let rebased = Command::new("git")
        .args([
            "-c",
            "user.name=ficus",
            "-c",
            "user.email=ficus@transplant",
            "-c",
            "commit.gpgsign=false",
            "rebase",
            "--quiet",
            "--onto",
            onto_head,
            from_base,
        ])
        .current_dir(&repo)
        .stdin(Stdio::null())
        .output()
        .await?;
    if !rebased.status.success() {
        let conflicts = git(
            &repo,
            "list conflicts",
            &["diff", "--name-only", "--diff-filter=U"],
        )
        .await
        .unwrap_or_default();
        let _ = succeeds(&repo, &["rebase", "--abort"]).await;
        let mut paths: Vec<String> = conflicts.lines().map(str::to_owned).collect();
        if paths.is_empty() {
            paths.push(String::from_utf8_lossy(&rebased.stderr).trim().to_owned());
        }
        return Err(ScoreError::Conflict(paths));
    }
    let commit = git(&repo, "rev-parse", &["rev-parse", "HEAD"]).await?;
    let commit = Oid::try_from(commit.trim().to_owned())
        .map_err(|error| ScoreError::Io(std::io::Error::other(error.to_string())))?;
    git(
        &repo,
        "push",
        &[
            "push",
            "--quiet",
            "origin",
            &format!("HEAD:refs/heads/{}", job.onto_branch),
        ],
    )
    .await?;
    tokio::fs::remove_dir_all(&workdir).await?;
    Ok(TransplantReport { commit, replayed })
}

/// What `prepare` leaves in the workdir for `check`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Prepared {
    leaf: LeafRef,
    /// `None` without a root devenv; otherwise whether its shell built, and
    /// the end of its output when it did not.
    devenv: Option<Result<(), String>>,
}

const PREPARED_FILE: &str = "prepared.json";

/// Phase one, with network: clone the leaf into a fresh workdir under
/// `root`, check `head` descends from `base`, put the root's locked files
/// back, and build the root's devenv shell. Returns the workdir.
pub async fn prepare(root: &Path, leaf: &LeafRef) -> Result<PathBuf, ScoreError> {
    let workdir = root.join(leaf.head.as_str());
    match tokio::fs::remove_dir_all(&workdir).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    tokio::fs::create_dir_all(&workdir).await?;
    let repo = workdir.join("leaf");
    let repo_arg = repo.to_string_lossy().into_owned();
    git(
        &workdir,
        "clone",
        &["clone", "--quiet", "--no-checkout", &leaf.remote, &repo_arg],
    )
    .await?;

    let (base, head) = (leaf.base.as_str(), leaf.head.as_str());
    git(
        &repo,
        "checkout",
        &["checkout", "--quiet", "--detach", head],
    )
    .await?;
    if !succeeds(&repo, &["merge-base", "--is-ancestor", base, head]).await? {
        return Err(ScoreError::NotDescendant);
    }
    // Fail now, while it is cheap, if the root defines nothing to run.
    root_checks(&repo, base).await?;

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

    let devenv = if root_has_devenv {
        let built = run(
            &repo,
            &["devenv", "--quiet", "shell", "--", "true"],
            DEVENV_PREPARE_SECS,
        )
        .await?;
        Some(if built.passed {
            Ok(())
        } else {
            Err(built.tail)
        })
    } else {
        None
    };

    let prepared = Prepared {
        leaf: leaf.clone(),
        devenv,
    };
    tokio::fs::write(
        workdir.join(PREPARED_FILE),
        serde_json::to_vec(&prepared).map_err(std::io::Error::other)?,
    )
    .await?;
    Ok(workdir)
}

/// Phase two, without network: run the root's checks in a prepared workdir,
/// cost the diff, collect what the root's judges need, and remove the workdir.
pub async fn check(workdir: &Path) -> Result<CheckRun, ScoreError> {
    let prepared: Prepared =
        serde_json::from_slice(&tokio::fs::read(workdir.join(PREPARED_FILE)).await?)
            .map_err(|error| ScoreError::Io(std::io::Error::other(error)))?;
    let repo = workdir.join("leaf");
    let (base, head) = (prepared.leaf.base.as_str(), prepared.leaf.head.as_str());
    let root = root_checks(&repo, base).await?;
    // The root's checks first, then the bud's: what must not break, then
    // what must be done.
    let specs: Vec<(CheckOrigin, &CheckSpec)> = root
        .checks
        .iter()
        .map(|check| (CheckOrigin::Root, check))
        .chain(
            prepared
                .leaf
                .checks
                .iter()
                .map(|check| (CheckOrigin::Bud, check)),
        )
        .collect();

    let checks = match &prepared.devenv {
        None => run_checks(&repo, &specs, false).await?,
        Some(Ok(())) => run_checks(&repo, &specs, true).await?,
        Some(Err(tail)) => {
            let tail = format!("the root's devenv shell did not build:\n{tail}");
            specs
                .iter()
                .map(|(origin, check)| CheckOutcome {
                    name: check.name.clone(),
                    origin: *origin,
                    passed: false,
                    millis: 0,
                    tail: tail.clone(),
                    confidence: None,
                })
                .collect()
        }
    };

    let cost = diff_cost(&repo, base, head).await?;
    let touched = diff_paths(&repo, base, head).await?;
    let diff = if root.judges.is_empty() {
        String::new()
    } else {
        clip_diff(&git(&repo, "diff", &diff_args(&["--no-color"], base, head)).await?)
    };
    tokio::fs::remove_dir_all(workdir).await?;
    Ok(CheckRun {
        report: ScoreReport {
            checks,
            cost,
            touched,
        },
        judges: root.judges,
        diff,
    })
}

/// Both phases back to back, for callers with no network policy to switch.
pub async fn score(root: &Path, leaf: &LeafRef) -> Result<CheckRun, ScoreError> {
    let workdir = prepare(root, leaf).await?;
    check(&workdir).await
}

/// The root's checks, always read from the base commit.
async fn root_checks(repo: &Path, base: &str) -> Result<RootChecks, ScoreError> {
    match git(
        repo,
        "show ficus.toml",
        &["show", &format!("{base}:ficus.toml")],
    )
    .await
    {
        Ok(text) => Ok(RootChecks::parse(&text)?),
        Err(ScoreError::Git { .. }) => Err(ScoreError::NoRootChecks),
        Err(other) => Err(other),
    }
}

async fn run_checks(
    repo: &Path,
    specs: &[(CheckOrigin, &CheckSpec)],
    in_devenv: bool,
) -> Result<Vec<CheckOutcome>, ScoreError> {
    let mut outcomes = Vec::with_capacity(specs.len());
    for &(origin, check) in specs {
        let argv: Vec<&str> = if in_devenv {
            vec!["devenv", "--quiet", "shell", "--", "bash", "-c", &check.run]
        } else {
            vec!["bash", "-c", &check.run]
        };
        let ran = run(repo, &argv, check.timeout_secs()).await?;
        outcomes.push(CheckOutcome {
            name: check.name.clone(),
            origin,
            passed: ran.passed,
            millis: ran.millis,
            tail: ran.tail,
            confidence: None,
        });
    }
    Ok(outcomes)
}

/// Paths changed between base and head, outside the locked files.
async fn diff_paths(repo: &Path, base: &str, head: &str) -> Result<Vec<String>, ScoreError> {
    let names = git(repo, "diff", &diff_args(&["--name-only"], base, head)).await?;
    Ok(names.lines().map(str::to_owned).collect())
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

/// `git diff <flags> base head`, outside the locked files.
fn diff_args(flags: &[&str], base: &str, head: &str) -> Vec<String> {
    let mut args = vec!["diff".to_owned()];
    args.extend(flags.iter().map(|flag| (*flag).to_owned()));
    args.extend([base, head, "--", "."].map(str::to_owned));
    args.extend(LOCKED_PATHS.iter().map(|path| format!(":(exclude){path}")));
    args
}

/// Lines added plus deleted between base and head, outside the locked files.
async fn diff_cost(repo: &Path, base: &str, head: &str) -> Result<u64, ScoreError> {
    let numstat = git(repo, "diff", &diff_args(&["--numstat"], base, head)).await?;
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

async fn git(
    dir: &Path,
    step: &'static str,
    args: &[impl AsRef<std::ffi::OsStr>],
) -> Result<String, ScoreError> {
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

        fn request(&self, base: Oid, head: Oid) -> LeafRef {
            LeafRef {
                remote: self.path.to_string_lossy().into_owned(),
                base,
                head,
                checks: vec![],
            }
        }

        /// Where workdirs go: beside the origin, inside the fixture's tempdir.
        fn scratch(&self) -> std::path::PathBuf {
            self.path.with_file_name("work")
        }
    }

    const ROOT: &str = "[[check]]\nname = \"has-greeting\"\nrun = \"grep -q hello greeting.txt\"\n\n[[check]]\nname = \"no-todo\"\nrun = \"! grep -rq TODO --include=*.txt .\"\n";

    #[tokio::test]
    async fn runs_the_roots_checks_and_costs_the_diff() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hi\n")], &[]);
        let head = repo.commit(&[("greeting.txt", "hello\nworld\n")], &[]);
        let report = score(&repo.scratch(), &repo.request(base, head))
            .await
            .unwrap()
            .report;
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
        let report = score(&repo.scratch(), &repo.request(base, head))
            .await
            .unwrap()
            .report;
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
        let report = score(&repo.scratch(), &repo.request(base.clone(), head))
            .await
            .unwrap()
            .report;
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
        let report = score(&repo.scratch(), &repo.request(base, deleted))
            .await
            .unwrap()
            .report;
        assert_eq!(report.checks.len(), 2);
    }

    #[tokio::test]
    async fn hands_the_roots_judges_the_diff_without_locked_files() {
        let repo = Fixture::new();
        let root = format!("{ROOT}\n[[judge]]\nname = \"greets\"\nask = \"Does `diff` greet?\"\n");
        let base = repo.commit(&[("ficus.toml", &root), ("greeting.txt", "hi\n")], &[]);
        let head = repo.commit(
            &[
                ("greeting.txt", "hello\n"),
                ("ficus.toml", "[[check]]\nname = \"x\"\nrun = \"true\"\n"),
            ],
            &[],
        );
        let run = score(&repo.scratch(), &repo.request(base, head))
            .await
            .unwrap();
        let judges: Vec<_> = run.judges.iter().map(|judge| judge.name.as_str()).collect();
        assert_eq!(judges, vec!["greets"]);
        assert!(run.diff.contains("+hello"), "{}", run.diff);
        assert!(!run.diff.contains("ficus.toml"), "{}", run.diff);
        assert_eq!(
            run.report.checks.len(),
            2,
            "judges are not run in the container"
        );
    }

    #[tokio::test]
    async fn a_root_without_judges_hands_over_no_diff() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hi\n")], &[]);
        let head = repo.commit(&[("greeting.txt", "hello\n")], &[]);
        let run = score(&repo.scratch(), &repo.request(base, head))
            .await
            .unwrap();
        assert_eq!((run.judges.len(), run.diff.as_str()), (0, ""));
    }

    #[tokio::test]
    async fn a_root_without_ficus_toml_cannot_score_anything() {
        let repo = Fixture::new();
        let base = repo.commit(&[("greeting.txt", "hi\n")], &[]);
        let head = repo.commit(&[("greeting.txt", "hello\n")], &[]);
        assert!(matches!(
            score(&repo.scratch(), &repo.request(base, head)).await,
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
        let result = score(&repo.scratch(), &repo.request(base, unrelated)).await;
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
        let report = score(&repo.scratch(), &repo.request(base, head))
            .await
            .unwrap()
            .report;
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

    #[tokio::test]
    async fn the_buds_checks_run_after_the_roots_and_say_whose_they_are() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hello\n")], &[]);
        let head = repo.commit(&[("greeting.txt", "hello\n"), ("notes.txt", "fine\n")], &[]);
        let mut leaf = repo.request(base, head);
        leaf.checks = vec![
            CheckSpec {
                name: "did-the-task".into(),
                run: "grep -q dark notes.txt".into(),
                timeout_secs: None,
            },
            CheckSpec {
                name: "has-notes".into(),
                run: "test -f notes.txt".into(),
                timeout_secs: Some(5),
            },
        ];
        let report = score(&repo.scratch(), &leaf).await.unwrap().report;
        let outcomes: Vec<_> = report
            .checks
            .iter()
            .map(|c| (c.name.as_str(), c.origin, c.passed))
            .collect();
        assert_eq!(
            outcomes,
            vec![
                ("has-greeting", CheckOrigin::Root, true),
                ("no-todo", CheckOrigin::Root, true),
                ("did-the-task", CheckOrigin::Bud, false),
                ("has-notes", CheckOrigin::Bud, true),
            ]
        );
        assert!(
            !report.score().unwrap().passes(),
            "the root's checks alone are not done"
        );
        assert_eq!(report.touched, vec!["notes.txt"]);
    }

    #[tokio::test]
    async fn touched_paths_leave_out_the_locked_files() {
        let repo = Fixture::new();
        let base = repo.commit(&[("ficus.toml", ROOT), ("greeting.txt", "hello\n")], &[]);
        let head = repo.commit(
            &[("ficus.toml", "cheat"), ("b.txt", "b\n"), ("a.txt", "a\n")],
            &[],
        );
        let report = score(&repo.scratch(), &repo.request(base, head))
            .await
            .unwrap();
        assert_eq!(report.report.touched, vec!["a.txt", "b.txt"]);
    }

    /// Two repos as Artifacts would hold them: the stale leaf, forked from
    /// the old head, and the fresh leaf, forked from the new head.
    struct Orchard {
        _dir: tempfile::TempDir,
        stale: std::path::PathBuf,
        fresh: std::path::PathBuf,
    }

    impl Orchard {
        fn git(dir: &Path, args: &[&str]) -> String {
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
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }

        fn commit(dir: &Path, files: &[(&str, &str)]) -> Oid {
            for (path, body) in files {
                std::fs::write(dir.join(path), body).unwrap();
            }
            Self::git(dir, &["add", "-A"]);
            Self::git(dir, &["commit", "--quiet", "-m", "c"]);
            Oid::try_from(Self::git(dir, &["rev-parse", "HEAD"])).unwrap()
        }

        /// A root, a stale leaf with `leaf_files` on top of it, and a fresh
        /// leaf whose head is the root plus `head_files`. Returns the three
        /// commits: root, stale head, new head.
        fn grow(leaf_files: &[(&str, &str)], head_files: &[(&str, &str)]) -> (Self, Oid, Oid, Oid) {
            let dir = tempfile::tempdir().unwrap();
            let stale = dir.path().join("stale");
            let fresh = dir.path().join("fresh");
            std::fs::create_dir(&stale).unwrap();
            Self::git(&stale, &["init", "--quiet", "-b", "main"]);
            let root = Self::commit(&stale, &[("ficus.toml", ROOT), ("greeting.txt", "hello\n")]);
            Self::git(dir.path(), &["clone", "--quiet", "stale", "fresh"]);
            let stale_head = Self::commit(&stale, leaf_files);
            let new_head = Self::commit(&fresh, head_files);
            // Pushing into a checked-out branch is what Artifacts allows.
            Self::git(
                &fresh,
                &["config", "receive.denyCurrentBranch", "updateInstead"],
            );
            let orchard = Self {
                _dir: dir,
                stale,
                fresh,
            };
            (orchard, root, stale_head, new_head)
        }

        fn job(&self, root: Oid, stale_head: Oid, new_head: Oid) -> TransplantRef {
            TransplantRef {
                from: self.stale.to_string_lossy().into_owned(),
                from_base: root,
                from_head: stale_head,
                onto: self.fresh.to_string_lossy().into_owned(),
                onto_head: new_head,
                onto_branch: "main".into(),
            }
        }

        fn scratch(&self) -> std::path::PathBuf {
            self.stale.with_file_name("work")
        }
    }

    #[tokio::test]
    async fn a_transplant_replays_the_leaf_onto_the_new_head_and_pushes() {
        let (orchard, root, stale_head, new_head) = Orchard::grow(
            &[("search.rs", "fn search() {}\n")],
            &[("auth.rs", "fn auth() {}\n")],
        );
        let report = transplant(
            &orchard.scratch(),
            &orchard.job(root, stale_head, new_head.clone()),
        )
        .await
        .unwrap();
        assert_eq!(report.replayed, 1);
        let pushed = Orchard::git(&orchard.fresh, &["rev-parse", "main"]);
        assert_eq!(pushed, report.commit.as_str());
        let parent = Orchard::git(&orchard.fresh, &["rev-parse", "main^"]);
        assert_eq!(parent, new_head.as_str(), "single parent: the new head");
        let files = Orchard::git(&orchard.fresh, &["ls-tree", "--name-only", "main"]);
        assert!(files.contains("auth.rs") && files.contains("search.rs"));
    }

    #[tokio::test]
    async fn a_conflicting_transplant_names_the_paths_and_pushes_nothing() {
        let (orchard, root, stale_head, new_head) = Orchard::grow(
            &[("greeting.txt", "hello from the leaf\n")],
            &[("greeting.txt", "hello from the head\n")],
        );
        let result = transplant(
            &orchard.scratch(),
            &orchard.job(root, stale_head, new_head.clone()),
        )
        .await;
        match result {
            Err(ScoreError::Conflict(ref paths)) => assert_eq!(paths, &["greeting.txt"]),
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert!(result.unwrap_err().is_input_problem());
        assert_eq!(
            Orchard::git(&orchard.fresh, &["rev-parse", "main"]),
            new_head.as_str()
        );
    }
}
