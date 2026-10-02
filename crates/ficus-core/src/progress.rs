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

use serde::Serialize;

pub const CONTENT_TYPE: &str = "application/x-ndjson";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Line<'a, S> {
    Step {
        step: S,
        state: StepState,
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
            detail: Some("attempt 2"),
        };
        assert_eq!(
            String::from_utf8(line.to_ndjson()).unwrap(),
            "{\"kind\":\"step\",\"step\":\"read_head\",\"state\":\"active\",\"detail\":\"attempt 2\"}\n"
        );
        let bare = Line::Step {
            step: InitStep::Lock,
            state: StepState::Complete,
            detail: None,
        };
        assert_eq!(
            String::from_utf8(bare.to_ndjson()).unwrap(),
            "{\"kind\":\"step\",\"step\":\"lock\",\"state\":\"complete\"}\n"
        );
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
