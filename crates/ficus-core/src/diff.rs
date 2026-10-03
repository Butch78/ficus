//! An attempt's change as a person reads it: which files changed, and for text,
//! the lines added and removed in hunks with context. The tree Worker finds
//! the changed files by walking two git trees in Artifacts; this module only
//! turns their contents into a diff, so it tests natively.

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

/// Lines of unchanged context around each hunk, as `git diff` shows.
pub const CONTEXT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    Added,
    Removed,
    Modified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Line {
    pub kind: LineKind,
    pub text: String,
}

/// A run of changes with its context; lines are 1-based, as in `@@ -a,b +c,d @@`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<Line>,
}

/// What a file's change shows: its lines, or why they are not shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Content {
    Text {
        additions: usize,
        deletions: usize,
        hunks: Vec<Hunk>,
    },
    /// Not UTF-8 on either side.
    Binary,
    /// Larger than the reader would page through; counted, not shown.
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub change: Change,
    pub content: Content,
}

/// The diff from `old` to `new`, either side absent for an added or removed file.
pub fn content(old: Option<&[u8]>, new: Option<&[u8]>) -> Content {
    let (Ok(old), Ok(new)) = (
        std::str::from_utf8(old.unwrap_or_default()),
        std::str::from_utf8(new.unwrap_or_default()),
    ) else {
        return Content::Binary;
    };
    let diff = TextDiff::from_lines(old, new);
    let mut additions = 0;
    let mut deletions = 0;
    let hunks = diff
        .grouped_ops(CONTEXT)
        .iter()
        .filter_map(|group| {
            let (first, last) = (group.first()?, group.last()?);
            let lines: Vec<Line> = group
                .iter()
                .flat_map(|op| diff.iter_changes(op))
                .map(|change| {
                    let kind = match change.tag() {
                        ChangeTag::Equal => LineKind::Context,
                        ChangeTag::Insert => {
                            additions += 1;
                            LineKind::Added
                        }
                        ChangeTag::Delete => {
                            deletions += 1;
                            LineKind::Removed
                        }
                    };
                    let text = change.value();
                    Line {
                        kind,
                        text: text.strip_suffix('\n').unwrap_or(text).to_owned(),
                    }
                })
                .collect();
            let (old, new) = (
                first.old_range().start..last.old_range().end,
                first.new_range().start..last.new_range().end,
            );
            Some(Hunk {
                old_start: if old.is_empty() {
                    old.start
                } else {
                    old.start + 1
                },
                old_lines: old.len(),
                new_start: if new.is_empty() {
                    new.start
                } else {
                    new.start + 1
                },
                new_lines: new.len(),
                lines,
            })
        })
        .collect();
    Content::Text {
        additions,
        deletions,
        hunks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(hunk: &Hunk) -> Vec<(LineKind, &str)> {
        hunk.lines
            .iter()
            .map(|line| (line.kind, line.text.as_str()))
            .collect()
    }

    #[test]
    fn a_change_in_the_middle_is_one_hunk_with_context() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "a\nb\nc\nd\nE\nf\ng\nh\n";
        let Content::Text {
            additions,
            deletions,
            hunks,
        } = content(Some(old.as_bytes()), Some(new.as_bytes()))
        else {
            panic!("text diffs as text");
        };
        assert_eq!((additions, deletions), (1, 1));
        assert_eq!(hunks.len(), 1);
        let hunk = &hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (2, 7, 2, 7)
        );
        assert_eq!(
            lines(hunk),
            vec![
                (LineKind::Context, "b"),
                (LineKind::Context, "c"),
                (LineKind::Context, "d"),
                (LineKind::Removed, "e"),
                (LineKind::Added, "E"),
                (LineKind::Context, "f"),
                (LineKind::Context, "g"),
                (LineKind::Context, "h"),
            ]
        );
    }

    #[test]
    fn an_added_file_is_all_additions_from_line_one() {
        let Content::Text {
            additions, hunks, ..
        } = content(None, Some(b"one\ntwo\n"))
        else {
            panic!("text diffs as text");
        };
        assert_eq!(additions, 2);
        assert_eq!(
            (
                hunks[0].old_start,
                hunks[0].old_lines,
                hunks[0].new_start,
                hunks[0].new_lines
            ),
            (0, 0, 1, 2)
        );
    }

    #[test]
    fn identical_text_has_no_hunks_and_bytes_are_binary() {
        assert_eq!(
            content(Some(b"same\n"), Some(b"same\n")),
            Content::Text {
                additions: 0,
                deletions: 0,
                hunks: vec![]
            }
        );
        assert_eq!(content(Some(&[0xff, 0xfe]), Some(b"x")), Content::Binary);
    }
}
