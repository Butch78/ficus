//! `ficus-scorer fs <op>`: the file half of an agent's workspace. The
//! Workspace Durable Object runs it through the platform's `exec`, with one
//! JSON request on stdin, and passes the answer to pi as it comes: pi's own
//! `Result` shape (`{"ok":true,"value":…}` or `{"ok":false,"error":{code,
//! message}}`) with pi's `FileError` codes. File contents travel as base64.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One request, as `infra/src/agents/sandbox-env.ts` sends it.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FsRequest {
    path: Option<String>,
    to: Option<String>,
    content: Option<String>,
    size: Option<u64>,
    recursive: Option<bool>,
    force: Option<bool>,
    prefix: Option<String>,
    suffix: Option<String>,
}

/// pi's `FileError` codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FsCode {
    NotFound,
    PermissionDenied,
    NotDirectory,
    IsDirectory,
    Invalid,
    NotSupported,
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
pub struct FsError {
    code: FsCode,
    message: String,
}

impl FsError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: FsCode::Invalid,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for FsError {
    fn from(error: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match error.kind() {
            ErrorKind::NotFound => FsCode::NotFound,
            ErrorKind::PermissionDenied => FsCode::PermissionDenied,
            ErrorKind::NotADirectory => FsCode::NotDirectory,
            ErrorKind::IsADirectory => FsCode::IsDirectory,
            ErrorKind::InvalidInput | ErrorKind::InvalidData | ErrorKind::AlreadyExists => {
                FsCode::Invalid
            }
            ErrorKind::Unsupported => FsCode::NotSupported,
            _ => FsCode::Unknown,
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

/// pi's `FileInfo`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    mtime_ms: f64,
}

/// Run `op` and render pi's `Result` as one line of JSON.
pub fn answer(op: &str, request: &str) -> String {
    let result = serde_json::from_str::<FsRequest>(request)
        .map_err(|error| FsError::invalid(format!("not an fs request: {error}")))
        .and_then(|request| run(op, &request));
    match result {
        Ok(value) => json!({ "ok": true, "value": value }).to_string(),
        Err(error) => {
            json!({ "ok": false, "error": { "code": error.code, "message": error.message } })
                .to_string()
        }
    }
}

fn run(op: &str, request: &FsRequest) -> Result<Value, FsError> {
    let path = || {
        request
            .path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| FsError::invalid(format!("{op} needs a path")))
    };
    let content = || {
        let encoded = request
            .content
            .as_deref()
            .ok_or_else(|| FsError::invalid(format!("{op} needs content")))?;
        STANDARD
            .decode(encoded)
            .map_err(|error| FsError::invalid(format!("content is not base64: {error}")))
    };
    match op {
        "read" => Ok(json!(STANDARD.encode(std::fs::read(path()?)?))),
        "write" => {
            let path = path()?;
            std::fs::write(&path, content()?)?;
            Ok(Value::Null)
        }
        "append" => {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(path()?)?;
            file.write_all(&content()?)?;
            Ok(Value::Null)
        }
        "truncate" => {
            let size = request
                .size
                .ok_or_else(|| FsError::invalid("truncate needs a size"))?;
            std::fs::OpenOptions::new()
                .write(true)
                .open(path()?)?
                .set_len(size)?;
            Ok(Value::Null)
        }
        "flush" => {
            std::fs::OpenOptions::new()
                .write(true)
                .open(path()?)?
                .sync_all()?;
            Ok(Value::Null)
        }
        "rename" => {
            let to = request
                .to
                .as_deref()
                .ok_or_else(|| FsError::invalid("rename needs `to`"))?;
            std::fs::rename(path()?, to)?;
            Ok(Value::Null)
        }
        "info" => Ok(json!(info(&path()?)?)),
        "list" => {
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(path()?)? {
                entries.push(info(&entry?.path())?);
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(json!(entries))
        }
        "canonical" => Ok(json!(std::fs::canonicalize(path()?)?)),
        "exists" => Ok(json!(std::fs::symlink_metadata(path()?).is_ok())),
        "mkdir" => {
            let path = path()?;
            if request.recursive.unwrap_or(false) {
                std::fs::create_dir_all(path)?;
            } else {
                std::fs::create_dir(path)?;
            }
            Ok(Value::Null)
        }
        "remove" => {
            let path = path()?;
            let removed = match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() && request.recursive.unwrap_or(false) => {
                    std::fs::remove_dir_all(&path)
                }
                Ok(meta) if meta.is_dir() => std::fs::remove_dir(&path),
                Ok(_) => std::fs::remove_file(&path),
                Err(error) => Err(error),
            };
            match removed {
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && request.force.unwrap_or(false) =>
                {
                    Ok(Value::Null)
                }
                other => other.map(|()| Value::Null).map_err(FsError::from),
            }
        }
        "tempdir" => {
            let dir = tempfile::Builder::new()
                .prefix(request.prefix.as_deref().unwrap_or("pi-"))
                .tempdir()?;
            Ok(json!(dir.keep()))
        }
        "tempfile" => {
            let file = tempfile::Builder::new()
                .prefix(request.prefix.as_deref().unwrap_or("pi-"))
                .suffix(request.suffix.as_deref().unwrap_or(""))
                .tempfile()?;
            let (_, path) = file.keep().map_err(|error| FsError::from(error.error))?;
            Ok(json!(path))
        }
        _ => Err(FsError {
            code: FsCode::NotSupported,
            message: format!("no fs operation {op:?}"),
        }),
    }
}

fn info(path: &Path) -> Result<FileInfo, FsError> {
    let meta = std::fs::symlink_metadata(path)?;
    let kind = if meta.is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "directory"
    } else {
        "file"
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |since| since.as_secs_f64() * 1000.0);
    Ok(FileInfo {
        name: path
            .file_name()
            .map_or_else(String::new, |name| name.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        kind,
        size: meta.len(),
        mtime_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(op: &str, request: Value) -> Value {
        serde_json::from_str(&answer(op, &request.to_string())).unwrap()
    }

    #[test]
    fn writes_appends_reads_and_lists_files_in_pis_result_shape() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        let path = file.to_string_lossy();
        let b64 = |text: &str| STANDARD.encode(text);

        assert_eq!(
            ask("write", json!({ "path": path, "content": b64("hello\n") })),
            json!({ "ok": true, "value": null })
        );
        ask("append", json!({ "path": path, "content": b64("world\n") }));
        assert_eq!(
            ask("read", json!({ "path": path })),
            json!({ "ok": true, "value": b64("hello\nworld\n") })
        );
        let listed = ask("list", json!({ "path": dir.path() }));
        assert_eq!(listed["value"][0]["name"], "a.txt");
        assert_eq!(listed["value"][0]["kind"], "file");
        assert_eq!(listed["value"][0]["size"], 12);
        assert_eq!(
            ask("exists", json!({ "path": path })),
            json!({ "ok": true, "value": true })
        );
    }

    #[test]
    fn reports_pis_error_codes() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(
            ask("read", json!({ "path": missing }))["error"]["code"],
            "not_found"
        );
        assert_eq!(
            ask("read", json!({ "path": dir.path() }))["error"]["code"],
            "is_directory"
        );
        assert_eq!(ask("read", json!({}))["error"]["code"], "invalid");
        assert_eq!(
            ask("chmod", json!({ "path": missing }))["error"]["code"],
            "not_supported"
        );
        assert!(answer("read", "not json").contains("\"invalid\""));
    }

    #[test]
    fn removes_with_force_and_recursion_as_asked() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("x/y");
        ask("mkdir", json!({ "path": nested, "recursive": true }));
        let top = dir.path().join("x");
        assert_eq!(ask("remove", json!({ "path": top }))["ok"], false);
        assert_eq!(
            ask("remove", json!({ "path": top, "recursive": true }))["ok"],
            true
        );
        assert_eq!(
            ask("remove", json!({ "path": top, "force": true }))["ok"],
            true
        );
        assert_eq!(ask("remove", json!({ "path": top }))["ok"], false);
    }
}
