//! The Artifacts Workers binding, which workers-rs has no wrapper for.
//!
//! Declared against the binding's own TypeScript definition
//! (`@cloudflare/workers-types`, `interface Artifacts` / `ArtifactsRepo`):
//! only the calls Ficus makes are bound. Results cross the boundary as
//! `serde_wasm_bindgen` structs, so a shape change fails at the call that
//! sees it rather than somewhere later.

use ficus_core::tree::RepoName;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use worker::EnvBinding;

#[wasm_bindgen]
extern "C" {
    /// `env.ARTIFACTS`: namespace-level operations.
    #[derive(Debug, Clone)]
    pub type Namespace;

    #[wasm_bindgen(method, catch, js_name = get)]
    async fn get_raw(this: &Namespace, name: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = create)]
    async fn create_raw(this: &Namespace, name: &str, opts: JsValue) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = import)]
    async fn import_raw(this: &Namespace, params: JsValue) -> Result<JsValue, JsValue>;

    /// A repository capability, an RPC stub returned by `Namespace::get`.
    #[derive(Debug, Clone)]
    pub type Repo;

    #[wasm_bindgen(method, catch, js_name = fork)]
    async fn fork_raw(this: &Repo, name: &str, opts: JsValue) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = createToken)]
    async fn create_token_raw(this: &Repo, scope: &str, ttl: u32) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = listTokens)]
    async fn list_tokens_raw(this: &Repo) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = revokeToken)]
    async fn revoke_token_raw(this: &Repo, token_or_id: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = info)]
    async fn info_raw(this: &Repo) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = log)]
    async fn log_raw(this: &Repo, opts: JsValue) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = readTree)]
    async fn read_tree_raw(this: &Repo, hash: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(method, catch, js_name = readFile)]
    async fn read_file_raw(this: &Repo, args: JsValue) -> Result<JsValue, JsValue>;

    /// The web `Blob` `readFile` resolves to: bytes plus a browser-safe type.
    #[derive(Debug, Clone)]
    pub type Blob;

    #[wasm_bindgen(method, getter, js_name = type)]
    fn mime(this: &Blob) -> String;

    #[wasm_bindgen(method, getter)]
    fn size(this: &Blob) -> f64;

    #[wasm_bindgen(method, js_name = arrayBuffer)]
    fn array_buffer(this: &Blob) -> js_sys::Promise;
}

impl EnvBinding for Namespace {
    const TYPE_NAME: &'static str = "Artifacts";

    // The binding's constructor name is not part of its documented contract,
    // so check for the method this module relies on instead.
    fn get(val: JsValue) -> worker::Result<Self> {
        let create =
            js_sys::Reflect::get(&val, &JsValue::from_str("create")).unwrap_or(JsValue::UNDEFINED);
        if create.is_function() {
            Ok(val.unchecked_into())
        } else {
            Err("binding is not an Artifacts namespace".into())
        }
    }
}

/// `ArtifactsError`, by its documented string `code`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Artifacts {code}: {message}")]
pub struct ArtifactsError {
    pub code: String,
    pub message: String,
}

impl ArtifactsError {
    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }

    fn from_js(error: JsValue) -> Self {
        let field = |name: &str| {
            js_sys::Reflect::get(&error, &JsValue::from_str(name))
                .ok()
                .and_then(|value| value.as_string())
        };
        Self {
            code: field("code").unwrap_or_else(|| "UNCLASSIFIED".to_owned()),
            message: field("message").unwrap_or_else(|| format!("{error:?}")),
        }
    }

    fn decode(error: serde_wasm_bindgen::Error) -> Self {
        Self {
            code: "DECODE".to_owned(),
            message: error.to_string(),
        }
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: JsValue) -> Result<T, ArtifactsError> {
    serde_wasm_bindgen::from_value(value).map_err(ArtifactsError::decode)
}

fn encode<T: Serialize>(value: &T) -> Result<JsValue, ArtifactsError> {
    // Plain objects, not `Map`s: the binding reads options by property.
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value.serialize(&serializer).map_err(ArtifactsError::decode)
}

/// `ArtifactsCreateRepoResult`: what create, import and fork return.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRepo {
    pub name: String,
    pub default_branch: String,
    pub remote: String,
    /// Write token, only ever returned here.
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedToken {
    pub id: String,
    pub plaintext: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub id: String,
    pub state: String,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenList {
    tokens: Vec<TokenInfo>,
}

/// `ArtifactsRepoInfo`, the fields Ficus reads.
#[derive(Debug, Clone, Deserialize)]
pub struct RepoInfo {
    pub remote: String,
}

/// `ArtifactsCommitMetadata`, the fields Ficus reads.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportSource<'a> {
    url: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<&'a str>,
}

#[derive(Serialize)]
struct ImportTarget<'a> {
    name: &'a str,
}

#[derive(Serialize)]
struct ImportParams<'a> {
    source: ImportSource<'a>,
    target: ImportTarget<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateOptions<'a> {
    description: &'a str,
    set_default_branch: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForkOptions<'a> {
    description: &'a str,
    default_branch_only: bool,
}

/// `ArtifactsCommitMetadata`, whole: what a reader of a repo's log sees.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct CommitMetadata {
    pub hash: String,
    pub tree_hash: String,
    pub message: String,
    pub author: Person,
    pub committer: Person,
    pub parents: Vec<String>,
    pub authored_at: i64,
    pub committed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Person {
    pub name: String,
    pub email: String,
}

/// `ArtifactsTreeEntry`: one immediate child of a git tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeEntry {
    pub name: String,
    pub mode: String,
    pub hash: String,
    /// `tree`, `blob`, `symlink`, `gitlink` or `exec`.
    #[serde(rename = "type")]
    pub kind: String,
}

impl TreeEntry {
    pub fn is_tree(&self) -> bool {
        self.kind == "tree"
    }
}

/// A file's bytes and the content type Artifacts gives them.
pub struct File {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Serialize)]
struct LogOptions<'a> {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    git_ref: Option<&'a str>,
    limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u32>,
}

#[derive(Serialize)]
struct ReadFileArgs<'a> {
    #[serde(rename = "ref")]
    git_ref: &'a str,
    path: &'a str,
}

impl Namespace {
    pub async fn repo(&self, name: &RepoName) -> Result<Repo, ArtifactsError> {
        self.get_raw(name.as_str())
            .await
            .map(JsCast::unchecked_into)
            .map_err(ArtifactsError::from_js)
    }

    /// Create an empty repo `name` with `main` as its default branch.
    pub async fn create(
        &self,
        name: &RepoName,
        description: &str,
    ) -> Result<CreatedRepo, ArtifactsError> {
        let opts = encode(&CreateOptions {
            description,
            set_default_branch: "main",
        })?;
        decode(
            self.create_raw(name.as_str(), opts)
                .await
                .map_err(ArtifactsError::from_js)?,
        )
    }

    /// Import `url` (an HTTPS git remote) as the repo `name`.
    pub async fn import(
        &self,
        url: &str,
        branch: Option<&str>,
        name: &RepoName,
    ) -> Result<CreatedRepo, ArtifactsError> {
        let params = encode(&ImportParams {
            source: ImportSource { url, branch },
            target: ImportTarget {
                name: name.as_str(),
            },
        })?;
        decode(
            self.import_raw(params)
                .await
                .map_err(ArtifactsError::from_js)?,
        )
    }
}

impl Repo {
    /// Fork this repo's default branch into a new repo `name`.
    pub async fn fork(
        &self,
        name: &RepoName,
        description: &str,
    ) -> Result<CreatedRepo, ArtifactsError> {
        let opts = encode(&ForkOptions {
            description,
            default_branch_only: true,
        })?;
        decode(
            self.fork_raw(name.as_str(), opts)
                .await
                .map_err(ArtifactsError::from_js)?,
        )
    }

    pub async fn create_token(
        &self,
        scope: Scope,
        ttl_seconds: u32,
    ) -> Result<CreatedToken, ArtifactsError> {
        decode(
            self.create_token_raw(scope.as_str(), ttl_seconds)
                .await
                .map_err(ArtifactsError::from_js)?,
        )
    }

    pub async fn info(&self) -> Result<RepoInfo, ArtifactsError> {
        decode(self.info_raw().await.map_err(ArtifactsError::from_js)?)
    }

    /// Revoke one token by id; `false` if it was not found.
    pub async fn revoke_token(&self, id: &str) -> Result<bool, ArtifactsError> {
        let done = self
            .revoke_token_raw(id)
            .await
            .map_err(ArtifactsError::from_js)?;
        Ok(done.as_bool() == Some(true))
    }

    /// Revoke every token on the repo that is still active; returns how many.
    pub async fn revoke_active_tokens(&self) -> Result<usize, ArtifactsError> {
        let list: TokenList = decode(
            self.list_tokens_raw()
                .await
                .map_err(ArtifactsError::from_js)?,
        )?;
        let mut revoked = 0;
        for token in list.tokens.iter().filter(|token| token.state == "active") {
            let done = self
                .revoke_token_raw(&token.id)
                .await
                .map_err(ArtifactsError::from_js)?;
            if done.as_bool() == Some(true) {
                revoked += 1;
            }
        }
        Ok(revoked)
    }

    /// The default branch's first-parent history, newest first.
    pub async fn history(&self, limit: u32) -> Result<Vec<Commit>, ArtifactsError> {
        let opts = encode(&LogOptions {
            git_ref: None,
            limit,
            offset: None,
        })?;
        decode(self.log_raw(opts).await.map_err(ArtifactsError::from_js)?)
    }

    /// First-parent history from `git_ref` (the repo's HEAD if `None`),
    /// newest first; empty if the ref does not resolve.
    pub async fn log(
        &self,
        git_ref: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<CommitMetadata>, ArtifactsError> {
        let opts = encode(&LogOptions {
            git_ref,
            limit,
            offset: Some(offset),
        })?;
        decode(self.log_raw(opts).await.map_err(ArtifactsError::from_js)?)
    }

    /// A tree's immediate children; `None` if there is no such object.
    pub async fn read_tree(&self, hash: &str) -> Result<Option<Vec<TreeEntry>>, ArtifactsError> {
        decode(
            self.read_tree_raw(hash)
                .await
                .map_err(ArtifactsError::from_js)?,
        )
    }

    /// The file at `path` as of `git_ref`; `None` if either does not resolve
    /// to a file. Files over `max_bytes` are refused rather than copied.
    pub async fn read_file(
        &self,
        git_ref: &str,
        path: &str,
        max_bytes: u32,
    ) -> Result<Option<File>, ArtifactsError> {
        let args = encode(&ReadFileArgs { git_ref, path })?;
        let found = self
            .read_file_raw(args)
            .await
            .map_err(ArtifactsError::from_js)?;
        if found.is_null() || found.is_undefined() {
            return Ok(None);
        }
        let blob: Blob = found.unchecked_into();
        if blob.size() > f64::from(max_bytes) {
            return Err(ArtifactsError {
                code: "MEMORY_LIMIT".to_owned(),
                message: format!("{path} is larger than {max_bytes} bytes"),
            });
        }
        let buffer = wasm_bindgen_futures::JsFuture::from(blob.array_buffer())
            .await
            .map_err(ArtifactsError::from_js)?;
        Ok(Some(File {
            content_type: blob.mime(),
            bytes: js_sys::Uint8Array::new(&buffer).to_vec(),
        }))
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Scope {
    Read,
    Write,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}
