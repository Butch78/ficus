//! Progress of a long operation, as it happens: one JSON object per line
//! (NDJSON), for whoever asked with `Accept: application/x-ndjson`.
//!
//! A step line says a step changed state; the last line is the outcome, the
//! status and body the same request would have answered without streaming.
//!
//! ```text
//! {"kind":"step","step":"import","state":"active","detail":"https://github.com/o/r"}
//! {"kind":"step","step":"import","state":"complete"}
//! {"kind":"outcome","status":200,"body":{...}}
//! ```

use serde::{Deserialize, Serialize};

pub const CONTENT_TYPE: &str = "application/x-ndjson";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Active,
    Complete,
    Error,
}

/// The steps of an init, in the order they can happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InitStep {
    /// Ask Artifacts to import the source remote as the root repo.
    Import,
    /// Wait for the import to land and read its head commit.
    Settle,
    /// No source: read the head of the root repo that was pushed.
    ReadHead,
    /// No source and no root yet: create an empty root to push to.
    Create,
    /// Revoke the root repo's write tokens: it is only ever forked.
    Lock,
    /// Store the initialized tree.
    Save,
}

/// The steps of scoring a leaf, in a sandbox, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoreStep {
    /// Start the sandbox's container, with the internet off.
    Sandbox,
    /// Clone the leaf, through the sandbox's egress.
    Clone,
    /// Put the root's locked files (its checks, its devenv) back.
    Restore,
    /// Build the root's devenv shell.
    Devenv,
    /// Run one of the root's checks (`item`: its name), with no network.
    Check,
    /// Measure the change: lines added and removed.
    Cost,
    /// Put the root's judges' questions to Clef, after the container is gone
    /// (the sandbox's step, not `ficus-scorer`'s).
    Judge,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Line<'a, S> {
    Step {
        step: S,
        state: StepState,
        /// Which one, when a step happens more than once (a check's name).
        #[serde(skip_serializing_if = "Option::is_none")]
        item: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<&'a str>,
    },
    Outcome {
        status: u16,
        body: serde_json::Value,
    },
}

impl<S: Serialize> Line<'_, S> {
    /// The line as written to the stream, newline included.
    pub fn to_ndjson(&self) -> Vec<u8> {
        let mut bytes =
            serde_json::to_vec(self).expect("a progress line is plain data and always serializes");
        bytes.push(b'\n');
        bytes
    }
}

/// A line as read back from a stream, whoever wrote it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Incoming {
    Step {
        step: String,
        state: StepState,
        #[serde(default)]
        item: Option<String>,
        #[serde(default)]
        detail: Option<String>,
    },
    Outcome {
        status: u16,
        body: serde_json::Value,
    },
}

impl Incoming {
    /// A line of a progress stream; `None` for a blank or foreign one.
    pub fn parse(line: &str) -> Option<Self> {
        serde_json::from_str(line.trim()).ok()
    }
}

/// One step as it went: when it started and ended, and how.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    pub state: StepState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Milliseconds since the epoch.
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
}

/// An operation's steps so far, folded from its stream: what a page shows
/// while it runs and afterwards. A step is one entry per `(step, item)`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Ledger {
    pub entries: Vec<Entry>,
}

impl Ledger {
    pub fn apply(
        &mut self,
        step: &str,
        state: StepState,
        item: Option<&str>,
        detail: Option<&str>,
        now: u64,
    ) {
        let ended_at = (state != StepState::Active).then_some(now);
        let existing = self
            .entries
            .iter_mut()
            .find(|entry| entry.step == step && entry.item.as_deref() == item);
        match existing {
            Some(entry) => {
                entry.state = state;
                entry.ended_at = ended_at;
                if let Some(detail) = detail {
                    entry.detail = Some(detail.to_owned());
                }
            }
            None => self.entries.push(Entry {
                step: step.to_owned(),
                item: item.map(str::to_owned),
                state,
                detail: detail.map(str::to_owned),
                started_at: now,
                ended_at,
            }),
        }
    }

    /// Steps still marked active become `state`: the stream ended under them.
    pub fn close(&mut self, state: StepState, now: u64) {
        for entry in self
            .entries
            .iter_mut()
            .filter(|entry| entry.state == StepState::Active)
        {
            entry.state = state;
            entry.ended_at = Some(now);
        }
    }
}

/// The outcome's body: the answer's JSON, or its text when it is not JSON.
pub fn outcome_body(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap_or_else(|_| serde_json::Value::String(text.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_one_json_object_per_line() {
        let line = Line::Step {
            step: InitStep::ReadHead,
            state: StepState::Active,
            item: None,
            detail: Some("attempt 2"),
        };
        assert_eq!(
            String::from_utf8(line.to_ndjson()).unwrap(),
            "{\"kind\":\"step\",\"step\":\"read_head\",\"state\":\"active\",\"detail\":\"attempt 2\"}\n"
        );
        let bare = Line::Step {
            step: InitStep::Lock,
            state: StepState::Complete,
            item: None,
            detail: None,
        };
        assert_eq!(
            String::from_utf8(bare.to_ndjson()).unwrap(),
            "{\"kind\":\"step\",\"step\":\"lock\",\"state\":\"complete\"}\n"
        );
    }

    #[test]
    fn a_ledger_keeps_one_entry_per_step_and_item_with_its_times() {
        let lines = [
            r#"{"kind":"step","step":"devenv","state":"active"}"#,
            r#"{"kind":"step","step":"devenv","state":"complete"}"#,
            r#"{"kind":"step","step":"check","state":"active","item":"tests"}"#,
            r#"{"kind":"step","step":"check","state":"active","item":"lint"}"#,
            r#"{"kind":"step","step":"check","state":"error","item":"tests","detail":"exit 1"}"#,
            "not a progress line",
        ];
        let mut ledger = Ledger::default();
        for (at, line) in (10..).zip(lines) {
            if let Some(Incoming::Step {
                step,
                state,
                item,
                detail,
            }) = Incoming::parse(line)
            {
                ledger.apply(&step, state, item.as_deref(), detail.as_deref(), at);
            }
        }
        ledger.close(StepState::Error, 99);
        let summary: Vec<_> = ledger
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.step.as_str(),
                    entry.item.as_deref(),
                    entry.state,
                    entry.started_at,
                    entry.ended_at,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("devenv", None, StepState::Complete, 10, Some(11)),
                ("check", Some("tests"), StepState::Error, 12, Some(14)),
                ("check", Some("lint"), StepState::Error, 13, Some(99)),
            ]
        );
        assert_eq!(ledger.entries[1].detail.as_deref(), Some("exit 1"));
    }

    #[test]
    fn the_outcome_carries_the_answer_json_or_text() {
        let json = Line::<InitStep>::Outcome {
            status: 200,
            body: outcome_body("{\"name\":\"t-site\"}"),
        };
        assert_eq!(
            String::from_utf8(json.to_ndjson()).unwrap(),
            "{\"kind\":\"outcome\",\"status\":200,\"body\":{\"name\":\"t-site\"}}\n"
        );
        assert_eq!(
            outcome_body("tree already initialized"),
            serde_json::Value::String("tree already initialized".to_owned())
        );
    }
}
