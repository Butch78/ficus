//! `ficus-scorer`, run inside the sandbox container with the platform's
//! `exec`. Two scoring phases, because the sandbox changes the network
//! between them, and one rebase command:
//!
//!   ficus-scorer prepare '<AttemptRef JSON>'   network: Artifacts + nix caches
//!       clones the attempt, restores the root's locked files, builds the root's
//!       devenv shell; prints {"workdir": "..."}
//!   ficus-scorer check <workdir>            network: none
//!       runs the root's checks then the task's, costs the diff; prints a
//!       CheckRun: the ScoreReport, plus the root's judges and the diff
//!       they judge
//!   ficus-scorer rebase '<RebaseRef JSON>'   network: Artifacts
//!       replays a behind attempt's commits onto the head in a fresh attempt and
//!       pushes them; prints a RebaseReport
//!
//! Exit 0 with JSON on stdout on success. Exit 2 when the attempt or root
//! cannot be scored or the replay conflicts (retrying will not help), 1 for
//! anything else; the reason is on stderr either way.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use ficus_core::scoring::{AttemptRef, RebaseRef};
use ficus_scorer::ScoreError;

/// Where `prepare` puts workdirs: one per head commit.
const WORK_ROOT: &str = "/work/score";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["prepare", attempt] => prepare(attempt).await,
        ["check", workdir] => check(Path::new(workdir)).await,
        ["rebase", job] => rebase(job).await,
        _ => {
            eprintln!(
                "usage: ficus-scorer prepare '<AttemptRef JSON>' | ficus-scorer check <workdir> | ficus-scorer rebase '<RebaseRef JSON>'"
            );
            return ExitCode::from(1);
        }
    };
    match outcome {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(if error.is_input_problem() { 2 } else { 1 })
        }
    }
}

fn unreadable(error: impl std::error::Error + Send + Sync + 'static) -> ScoreError {
    ScoreError::Io(std::io::Error::other(error))
}

async fn prepare(attempt: &str) -> Result<String, ScoreError> {
    let attempt: AttemptRef = serde_json::from_str(attempt).map_err(unreadable)?;
    let workdir: PathBuf = ficus_scorer::prepare(Path::new(WORK_ROOT), &attempt).await?;
    Ok(serde_json::json!({ "workdir": workdir }).to_string())
}

async fn check(workdir: &Path) -> Result<String, ScoreError> {
    let run = ficus_scorer::check(workdir).await?;
    serde_json::to_string(&run).map_err(unreadable)
}

async fn rebase(job: &str) -> Result<String, ScoreError> {
    let job: RebaseRef = serde_json::from_str(job).map_err(unreadable)?;
    let report = ficus_scorer::rebase(Path::new(WORK_ROOT), &job).await?;
    serde_json::to_string(&report).map_err(unreadable)
}
