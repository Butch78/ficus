//! A TreeObject operation's progress, streamed to a caller that asked for it
//! (`ficus_core::progress` is the wire format).

use ficus_core::progress::{Line, InitStep, StepState, outcome_body};
use futures_channel::mpsc::UnboundedSender;
use worker::Response;

/// Where step lines go: a streaming caller's channel, or nowhere.
pub struct Progress(Option<UnboundedSender<Vec<u8>>>);

impl Progress {
    /// For a caller that wants only the answer.
    pub fn silent() -> Self {
        Self(None)
    }

    pub fn to(sender: UnboundedSender<Vec<u8>>) -> Self {
        Self(Some(sender))
    }

    pub fn step(&self, step: InitStep, state: StepState, detail: Option<&str>) {
        self.send(Line::Step {
            step,
            state,
            detail,
        });
    }

    /// The answer the operation would have given without streaming, as the
    /// stream's last line.
    pub async fn outcome(&self, mut answer: Response) {
        let status = answer.status_code();
        let body = match answer.text().await {
            Ok(text) => outcome_body(&text),
            Err(error) => serde_json::Value::String(error.to_string()),
        };
        self.send(Line::<InitStep>::Outcome { status, body });
    }

    fn send(&self, line: Line<'_, InitStep>) {
        if let Some(sender) = &self.0
            && sender.unbounded_send(line.to_ndjson()).is_err()
        {
            // The caller hung up; the operation carries on without an audience.
            worker::console_log!("progress: the caller stopped listening");
        }
    }
}
