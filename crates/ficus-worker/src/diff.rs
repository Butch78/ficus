//! An attempt's or node's change, read from Artifacts: walk the base commit's
//! tree and the head's side by side, descending only where they differ, then
//! diff each changed file's text (`ficus_core::diff`).

use std::collections::BTreeMap;

use ficus_core::diff::{Change, Content, FileDiff, content};

use crate::artifacts::{ArtifactsError, BlobBytes, Repo, TreeEntry};

/// How many changed files one diff shows; past it, the rest are counted.
pub const MAX_FILES: usize = 200;

/// The largest file whose lines are diffed.
const MAX_BLOB_BYTES: u32 = 256 * 1024;

/// A changed path, with the blob on each side that has one.
struct Changed {
    path: String,
    old: Option<String>,
    new: Option<String>,
}

pub struct Diff {
    pub files: Vec<FileDiff>,
    /// More files changed than `MAX_FILES`.
    pub truncated: bool,
}

/// The diff from tree `old` to tree `new` (either absent: everything added
/// or removed).
pub async fn trees(
    repo: &Repo,
    old: Option<String>,
    new: Option<String>,
) -> Result<Diff, ArtifactsError> {
    let (changed, truncated) = changed_files(repo, old, new).await?;
    let mut files = Vec::with_capacity(changed.len());
    for file in changed {
        let change = match (&file.old, &file.new) {
            (None, _) => Change::Added,
            (_, None) => Change::Removed,
            _ => Change::Modified,
        };
        let (old, new) = (
            read(repo, file.old.as_deref()).await?,
            read(repo, file.new.as_deref()).await?,
        );
        let content = match (old, new) {
            (Some(BlobBytes::TooLarge), _) | (_, Some(BlobBytes::TooLarge)) => Content::TooLarge,
            (old, new) => content(bytes(old.as_ref()), bytes(new.as_ref())),
        };
        files.push(FileDiff {
            path: file.path,
            change,
            content,
        });
    }
    Ok(Diff { files, truncated })
}

async fn read(repo: &Repo, hash: Option<&str>) -> Result<Option<BlobBytes>, ArtifactsError> {
    match hash {
        Some(hash) => repo.read_blob(hash, MAX_BLOB_BYTES).await,
        None => Ok(None),
    }
}

fn bytes(blob: Option<&BlobBytes>) -> Option<&[u8]> {
    match blob {
        Some(BlobBytes::Bytes(bytes)) => Some(bytes),
        Some(BlobBytes::TooLarge) | None => None,
    }
}

async fn entries(
    repo: &Repo,
    tree: Option<&str>,
) -> Result<BTreeMap<String, TreeEntry>, ArtifactsError> {
    let Some(tree) = tree else {
        return Ok(BTreeMap::new());
    };
    Ok(repo
        .read_tree(tree)
        .await?
        .unwrap_or_default()
        .into_iter()
        // A submodule is a pointer into another repo: nothing to diff here.
        .filter(|entry| entry.kind != "gitlink")
        .map(|entry| (entry.name.clone(), entry))
        .collect())
}

/// The files that differ between two trees, in path order, at most `MAX_FILES`.
async fn changed_files(
    repo: &Repo,
    old: Option<String>,
    new: Option<String>,
) -> Result<(Vec<Changed>, bool), ArtifactsError> {
    let mut found = Vec::new();
    // Directories to compare, by path; a stack, popped in reverse so paths stay in order.
    let mut pending = vec![(String::new(), old, new)];
    while let Some((prefix, old, new)) = pending.pop() {
        let (old, new) = (
            entries(repo, old.as_deref()).await?,
            entries(repo, new.as_deref()).await?,
        );
        let mut names: Vec<&String> = old.keys().chain(new.keys()).collect();
        names.sort();
        names.dedup();
        let mut directories = Vec::new();
        for name in names {
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let (before, after) = (old.get(name), new.get(name));
            if let (Some(before), Some(after)) = (before, after)
                && before.hash == after.hash
            {
                continue;
            }
            let tree_of = |entry: Option<&TreeEntry>| {
                entry
                    .filter(|entry| entry.is_tree())
                    .map(|entry| entry.hash.clone())
            };
            let blob_of = |entry: Option<&TreeEntry>| {
                entry
                    .filter(|entry| !entry.is_tree())
                    .map(|entry| entry.hash.clone())
            };
            if tree_of(before).is_some() || tree_of(after).is_some() {
                directories.push((path.clone(), tree_of(before), tree_of(after)));
            }
            if blob_of(before).is_some() || blob_of(after).is_some() {
                if found.len() == MAX_FILES {
                    return Ok((found, true));
                }
                found.push(Changed {
                    path,
                    old: blob_of(before),
                    new: blob_of(after),
                });
            }
        }
        pending.extend(directories.into_iter().rev());
    }
    Ok((found, false))
}
