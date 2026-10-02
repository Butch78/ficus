//! `ficus-scorer`, run inside the sandbox container with the platform's
//! `exec`. Two scoring phases, because the sandbox changes the network
//! between them, and one transplant command:
//!
//!   ficus-scorer prepare '<LeafRef JSON>'   network: Artifacts + nix caches
//!       clones the leaf, restores the root's locked files, builds the root's
//!       devenv shell; prints {"workdir": "..."}
//!   ficus-scorer check <workdir>            network: none
//!       runs the root's checks then the bud's, costs the diff; prints a
//!       CheckRun: the ScoreReport, plus the root's judges and the diff
//!       they judge
//!   ficus-scorer transplant '<TransplantRef JSON>'   network: Artifacts
//!       replays a stale leaf's commits onto the head in a fresh leaf and
//!       pushes them; prints a TransplantReport
//!
//! Exit 0 with JSON on stdout on success. Exit 2 when the leaf or root
//! cannot be scored or the replay conflicts (retrying will not help), 1 for
//! anything else; the reason is on stderr either way.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use ficus_core::scoring::{LeafRef, TransplantRef};
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
        ["prepare", leaf] => prepare(leaf).await,
        ["check", workdir] => check(Path::new(workdir)).await,
        ["transplant", job] => transplant(job).await,
        _ => {
            eprintln!(
                "usage: ficus-scorer prepare '<LeafRef JSON>' | ficus-scorer check <workdir> | ficus-scorer transplant '<TransplantRef JSON>'"
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

async fn prepare(leaf: &str) -> Result<String, ScoreError> {
    let leaf: LeafRef = serde_json::from_str(leaf).map_err(unreadable)?;
    let workdir: PathBuf = ficus_scorer::prepare(Path::new(WORK_ROOT), &leaf).await?;
    Ok(serde_json::json!({ "workdir": workdir }).to_string())
}

async fn check(workdir: &Path) -> Result<String, ScoreError> {
    let run = ficus_scorer::check(workdir).await?;
    serde_json::to_string(&run).map_err(unreadable)
}

async fn transplant(job: &str) -> Result<String, ScoreError> {
    let job: TransplantRef = serde_json::from_str(job).map_err(unreadable)?;
    let report = ficus_scorer::transplant(Path::new(WORK_ROOT), &job).await?;
    serde_json::to_string(&report).map_err(unreadable)
}
