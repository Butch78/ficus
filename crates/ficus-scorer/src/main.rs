//! `ficus-scorer`, run inside the sandbox container with the platform's
//! `exec`. Three scoring phases, because the sandbox changes the network
//! between them, and one rebase command:
//!
//!   ficus-scorer prepare '<AttemptRef JSON>'   network: Artifacts
//!       clones the attempt, restores the root's locked files; prints
//!       {"workdir": "...", "hosts": [...]}: the hosts its `[fetch]` needs
//!   ficus-scorer fetch <workdir>             network: nix caches + those hosts
//!       builds the root's devenv shell and runs its fetch; a failure is
//!       recorded for `check`, which fails every check with it
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
//!
//! An agent's workspace (the same image, another sandbox) also runs:
//!
//!   ficus-scorer fs <op>    a file operation, the request JSON on stdin
//!   ficus-scorer exec       a shell command, the request JSON on stdin
//!
//! Each prints pi's `Result` JSON and exits 0; failures are in the answer.
//!
//!   ficus-scorer hosts <checkout>   the hosts its committed ficus.toml's
//!       `[fetch]` names, as a JSON array (empty without one)

use std::path::Path;
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
        ["hosts", checkout] => ficus_scorer::fetch_hosts(Path::new(checkout))
            .await
            .and_then(|hosts| serde_json::to_string(&hosts).map_err(unreadable)),
        ["fetch", workdir] => ficus_scorer::fetch(Path::new(workdir))
            .await
            .map(|()| "{}".to_owned()),
        ["check", workdir] => check(Path::new(workdir)).await,
        ["rebase", job] => rebase(job).await,
        ["fs", op] => return answer(ficus_scorer::workspace::fs(op, &stdin()).await),
        ["exec"] => return answer(ficus_scorer::workspace::exec(&stdin()).await),
        _ => {
            eprintln!(
                "usage: ficus-scorer prepare '<AttemptRef JSON>' | fetch <workdir> | check <workdir> | hosts <checkout> | rebase '<RebaseRef JSON>' | fs <op> | exec"
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

/// The request a workspace operation reads: all of stdin.
fn stdin() -> String {
    let mut text = String::new();
    if let Err(error) = std::io::Read::read_to_string(&mut std::io::stdin(), &mut text) {
        eprintln!("reading the request from stdin: {error}");
    }
    text
}

/// A workspace answer: pi's `Result`, success or not, on stdout.
fn answer(result: serde_json::Value) -> ExitCode {
    println!("{result}");
    ExitCode::SUCCESS
}

async fn prepare(attempt: &str) -> Result<String, ScoreError> {
    let attempt: AttemptRef = serde_json::from_str(attempt).map_err(unreadable)?;
    let prepared = ficus_scorer::prepare(Path::new(WORK_ROOT), &attempt).await?;
    serde_json::to_string(&prepared).map_err(unreadable)
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
