//! The agent's sandbox: the files and shell of one container, over HTTP,
//! shaped after pi-durable's `ExecutionEnv` (`FileSystem` + `Shell`) so the
//! TypeScript side is a pass-through.
//!
//! Every answer is pi's `Result`: `{"ok":true,"value":...}` or
//! `{"ok":false,"error":{"code":...,"message":...}}`, with pi's error codes.
//! Bytes travel as base64. The container belongs to one agent, so there is
//! no path confinement: the agent may touch anything a root shell could.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::Path as UrlPath;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// pi's `FileError` / `ExecutionError`, as data.
#[derive(Debug, Serialize)]
struct Failure {
    code: &'static str,
    message: String,
}

fn ok(value: Value) -> Json<Value> {
    Json(json!({ "ok": true, "value": value }))
}

fn fail(failure: Failure) -> Json<Value> {
    Json(json!({ "ok": false, "error": failure }))
}

fn file_failure(error: &std::io::Error, path: &str) -> Failure {
    use std::io::ErrorKind;
    let code = match error.kind() {
        ErrorKind::NotFound => "not_found",
        ErrorKind::PermissionDenied => "permission_denied",
        ErrorKind::NotADirectory => "not_directory",
        ErrorKind::IsADirectory => "is_directory",
        ErrorKind::InvalidInput | ErrorKind::InvalidData => "invalid",
        ErrorKind::Unsupported => "not_supported",
        _ => "unknown",
    };
    Failure {
        code,
        message: format!("{path}: {error}"),
    }
}

#[derive(Deserialize)]
pub struct FsRequest {
    path: Option<String>,
    to: Option<String>,
    /// base64, for write and append.
    content: Option<String>,
    size: Option<u64>,
    recursive: Option<bool>,
    force: Option<bool>,
    prefix: Option<String>,
    suffix: Option<String>,
}

/// `POST /fs/<op>`.
pub async fn fs(UrlPath(op): UrlPath<String>, Json(request): Json<FsRequest>) -> Json<Value> {
    match fs_op(&op, request).await {
        Ok(value) => ok(value),
        Err(failure) => fail(failure),
    }
}

async fn fs_op(op: &str, request: FsRequest) -> Result<Value, Failure> {
    let need = |field: Option<String>, name: &str| {
        field.ok_or_else(|| Failure {
            code: "invalid",
            message: format!("`{name}` is required for {op}"),
        })
    };
    match op {
        "read" => {
            let path = need(request.path, "path")?;
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            Ok(json!(BASE64.encode(bytes)))
        }
        "write" | "append" => {
            let path = need(request.path, "path")?;
            let content = BASE64
                .decode(need(request.content, "content")?)
                .map_err(|e| Failure {
                    code: "invalid",
                    message: format!("content is not base64: {e}"),
                })?;
            let mut file = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(op == "append")
                .truncate(op == "write")
                .open(&path)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            file.write_all(&content)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            file.flush().await.map_err(|e| file_failure(&e, &path))?;
            Ok(Value::Null)
        }
        "truncate" => {
            let path = need(request.path, "path")?;
            let size = request.size.ok_or_else(|| Failure {
                code: "invalid",
                message: "`size` is required".into(),
            })?;
            let file = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            file.set_len(size)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            Ok(Value::Null)
        }
        "flush" => {
            let path = need(request.path, "path")?;
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            file.sync_all().await.map_err(|e| file_failure(&e, &path))?;
            Ok(Value::Null)
        }
        "rename" => {
            let path = need(request.path, "path")?;
            let to = need(request.to, "to")?;
            tokio::fs::rename(&path, &to)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            Ok(Value::Null)
        }
        "info" => {
            let path = need(request.path, "path")?;
            Ok(info(Path::new(&path)).await?)
        }
        "list" => {
            let path = need(request.path, "path")?;
            let mut entries = tokio::fs::read_dir(&path)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            let mut listed = Vec::new();
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|e| file_failure(&e, &path))?
            {
                listed.push(info(&entry.path()).await?);
            }
            Ok(Value::Array(listed))
        }
        "canonical" => {
            let path = need(request.path, "path")?;
            let canonical = tokio::fs::canonicalize(&path)
                .await
                .map_err(|e| file_failure(&e, &path))?;
            Ok(json!(canonical.to_string_lossy()))
        }
        "exists" => {
            let path = need(request.path, "path")?;
            Ok(json!(
                tokio::fs::try_exists(&path)
                    .await
                    .map_err(|e| file_failure(&e, &path))?
            ))
        }
        "mkdir" => {
            let path = need(request.path, "path")?;
            let made = if request.recursive.unwrap_or(false) {
                tokio::fs::create_dir_all(&path).await
            } else {
                tokio::fs::create_dir(&path).await
            };
            made.map_err(|e| file_failure(&e, &path))?;
            Ok(Value::Null)
        }
        "remove" => {
            let path = need(request.path, "path")?;
            let metadata = match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) => metadata,
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotFound
                        && request.force.unwrap_or(false) =>
                {
                    return Ok(Value::Null);
                }
                Err(e) => return Err(file_failure(&e, &path)),
            };
            let removed = if metadata.is_dir() {
                if request.recursive.unwrap_or(false) {
                    tokio::fs::remove_dir_all(&path).await
                } else {
                    tokio::fs::remove_dir(&path).await
                }
            } else {
                tokio::fs::remove_file(&path).await
            };
            removed.map_err(|e| file_failure(&e, &path))?;
            Ok(Value::Null)
        }
        "tempdir" => {
            let dir = tempfile::Builder::new()
                .prefix(request.prefix.as_deref().unwrap_or("pi-"))
                .tempdir()
                .map_err(|e| file_failure(&e, "tempdir"))?;
            Ok(json!(dir.keep().to_string_lossy()))
        }
        "tempfile" => {
            let file = tempfile::Builder::new()
                .prefix(request.prefix.as_deref().unwrap_or("pi-"))
                .suffix(request.suffix.as_deref().unwrap_or(""))
                .tempfile()
                .map_err(|e| file_failure(&e, "tempfile"))?;
            let (_, path) = file
                .keep()
                .map_err(|e| file_failure(&e.error, "tempfile"))?;
            Ok(json!(path.to_string_lossy()))
        }
        other => Err(Failure {
            code: "not_supported",
            message: format!("no filesystem operation {other:?}"),
        }),
    }
}

async fn info(path: &Path) -> Result<Value, Failure> {
    let shown = path.to_string_lossy();
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| file_failure(&e, &shown))?;
    let kind = if metadata.file_type().is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        });
    Ok(json!({
        "name": path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        "path": shown,
        "kind": kind,
        "size": metadata.len(),
        "mtimeMs": mtime_ms,
    }))
}

#[derive(Deserialize)]
pub struct ExecRequest {
    command: String,
    cwd: Option<String>,
    env: Option<std::collections::BTreeMap<String, String>>,
    /// pi's default: the child sees the container's environment plus `env`.
    inherit_env: Option<bool>,
    timeout_ms: Option<u64>,
    spill_after_bytes: Option<usize>,
    spill_after_lines: Option<usize>,
}

/// `POST /exec`: run `command` under bash, answer pi's `ShellExecResult`
/// plus the combined output (or a spill file holding it).
pub async fn exec(Json(request): Json<ExecRequest>) -> Json<Value> {
    match run(request).await {
        Ok(value) => ok(value),
        Err(failure) => fail(failure),
    }
}

async fn run(request: ExecRequest) -> Result<Value, Failure> {
    let mut command = Command::new("bash");
    command.arg("-c").arg(&request.command);
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    if !request.inherit_env.unwrap_or(true) {
        command.env_clear();
    }
    command.envs(request.env.unwrap_or_default());
    // One pipe for both streams, so the output keeps its real interleaving.
    let (reader, writer) = std::io::pipe().map_err(|e| Failure {
        code: "spawn_error",
        message: e.to_string(),
    })?;
    let writer_err = writer.try_clone().map_err(|e| Failure {
        code: "spawn_error",
        message: e.to_string(),
    })?;
    // Its own process group, so a timeout can kill everything it started.
    command
        .stdin(Stdio::null())
        .stdout(writer)
        .stderr(writer_err)
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command.spawn().map_err(|e| Failure {
        code: "spawn_error",
        message: e.to_string(),
    })?;
    // The parent's copies of the pipe's write end went into `command`; drop
    // it so the read side sees EOF when the child exits.
    drop(command);
    let collect = tokio::task::spawn_blocking(move || {
        let mut output = Vec::new();
        std::io::Read::read_to_end(&mut { reader }, &mut output).map(|_| output)
    });
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(600_000));
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => status.map_err(|e| Failure {
            code: "unknown",
            message: e.to_string(),
        })?,
        Err(_) => {
            // Killing only bash would leave its children holding the pipe
            // open, so kill the group. Failure means it already exited.
            if let Some(pid) = child.id() {
                let killed = Command::new("kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .status()
                    .await;
                if let Err(error) = killed {
                    eprintln!("killing process group {pid}: {error}");
                }
            }
            return Err(Failure {
                code: "timeout",
                message: format!("timed out after {}ms", timeout.as_millis()),
            });
        }
    };
    let output = collect
        .await
        .map_err(|e| Failure {
            code: "unknown",
            message: e.to_string(),
        })?
        .map_err(|e| Failure {
            code: "unknown",
            message: e.to_string(),
        })?;
    let text = String::from_utf8_lossy(&output).into_owned();
    let lines = text.lines().count();
    let spill = request
        .spill_after_bytes
        .is_some_and(|limit| output.len() > limit)
        || request.spill_after_lines.is_some_and(|limit| lines > limit);
    let exit_code = status.code().unwrap_or(-1);
    if spill {
        let path = spill_file(&output).await?;
        Ok(json!({ "exitCode": exit_code, "spillPath": path.to_string_lossy(), "output": text }))
    } else {
        Ok(json!({ "exitCode": exit_code, "output": text }))
    }
}

async fn spill_file(output: &[u8]) -> Result<PathBuf, Failure> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("pi-spill-{stamp}.log"));
    tokio::fs::write(&path, output)
        .await
        .map_err(|e| file_failure(&e, &path.to_string_lossy()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &Path) -> FsRequest {
        FsRequest {
            path: Some(path.to_string_lossy().into_owned()),
            to: None,
            content: None,
            size: None,
            recursive: None,
            force: None,
            prefix: None,
            suffix: None,
        }
    }

    #[tokio::test]
    async fn write_append_read_truncate_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        let write = |op: &'static str, text: &str| {
            let mut r = request(&file);
            r.content = Some(BASE64.encode(text));
            fs_op(op, r)
        };
        write("write", "hello").await.unwrap();
        write("append", " world").await.unwrap();
        let read = fs_op("read", request(&file)).await.unwrap();
        assert_eq!(
            BASE64.decode(read.as_str().unwrap()).unwrap(),
            b"hello world"
        );
        let mut truncate = request(&file);
        truncate.size = Some(5);
        fs_op("truncate", truncate).await.unwrap();
        let info = fs_op("info", request(&file)).await.unwrap();
        assert_eq!(
            (
                info["kind"].as_str(),
                info["size"].as_u64(),
                info["name"].as_str()
            ),
            (Some("file"), Some(5), Some("a.txt"))
        );
    }

    #[tokio::test]
    async fn missing_paths_fail_with_pi_codes() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert_eq!(
            fs_op("read", request(&missing)).await.unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            fs_op("exists", request(&missing)).await.unwrap(),
            json!(false)
        );
        let mut forced = request(&missing);
        forced.force = Some(true);
        assert_eq!(fs_op("remove", forced).await.unwrap(), Value::Null);
        assert_eq!(
            fs_op("remove", request(&missing)).await.unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            fs_op("frobnicate", request(&missing))
                .await
                .unwrap_err()
                .code,
            "not_supported"
        );
    }

    #[tokio::test]
    async fn directories_list_and_need_recursive_to_remove() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("x/y");
        let mut mkdir = request(&nested);
        mkdir.recursive = Some(true);
        fs_op("mkdir", mkdir).await.unwrap();
        let listed = fs_op("list", request(&dir.path().join("x"))).await.unwrap();
        assert_eq!(listed[0]["kind"], json!("directory"));
        let top = dir.path().join("x");
        assert!(fs_op("remove", request(&top)).await.is_err());
        let mut recursive = request(&top);
        recursive.recursive = Some(true);
        fs_op("remove", recursive).await.unwrap();
        assert!(!top.exists());
    }

    fn exec_request(command: &str) -> ExecRequest {
        ExecRequest {
            command: command.into(),
            cwd: None,
            env: None,
            inherit_env: None,
            timeout_ms: None,
            spill_after_bytes: None,
            spill_after_lines: None,
        }
    }

    #[tokio::test]
    async fn exec_interleaves_both_streams_and_reports_the_exit_code() {
        let ran = run(exec_request("echo out; echo err >&2; echo again; exit 3"))
            .await
            .unwrap();
        assert_eq!(
            (ran["exitCode"].as_i64(), ran["output"].as_str()),
            (Some(3), Some("out\nerr\nagain\n"))
        );
    }

    #[tokio::test]
    async fn exec_spills_long_output_to_a_file() {
        let mut request = exec_request("seq 1 100");
        request.spill_after_lines = Some(10);
        let ran = run(request).await.unwrap();
        let spilled = std::fs::read_to_string(ran["spillPath"].as_str().unwrap()).unwrap();
        assert_eq!(spilled.lines().count(), 100);
    }

    #[tokio::test]
    async fn exec_timeout_kills_the_whole_group() {
        let mut request = exec_request("sleep 30 & sleep 30; wait");
        request.timeout_ms = Some(300);
        let started = std::time::Instant::now();
        assert_eq!(run(request).await.unwrap_err().code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn exec_uses_cwd_and_env() {
        let dir = tempfile::tempdir().unwrap();
        let mut request = exec_request("echo \"$FICUS_X $(pwd)\"");
        request.cwd = Some(dir.path().to_string_lossy().into_owned());
        request.env = Some([("FICUS_X".to_owned(), "hi".to_owned())].into());
        let ran = run(request).await.unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        assert_eq!(
            ran["output"].as_str().unwrap().trim(),
            format!("hi {}", canonical.display())
        );
    }
}
