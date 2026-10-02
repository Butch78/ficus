//! Attempts worked by agents: `AgentActor`s in the agents Worker
//! (infra/src/agents), one per attempt, working in their own sandboxes.
//!
//! The tree is the only side that talks: it starts the attempts, hands each
//! agent its assignment, then asks how it is doing on every alarm until it
//! has submitted (the tree freezes the attempt and scores it), stopped or
//! failed (the tree abandons the attempt, keeping the agent's last words in
//! the history).

use std::time::Duration;

use ficus_core::tree::{AttemptId, AttemptState, RepoName, TaskId};
use serde::{Deserialize, Serialize};
use worker::{Headers, Method, Request, RequestInit, Response, Result};

use super::{AbandonBody, Started, TreeObject};

/// The most agents one request starts.
pub(super) const MAX_AGENTS: u32 = 5;

/// How often the tree asks its agents how they are doing.
const POLL: Duration = Duration::from_secs(15);

/// The attempts the tree is still tending: dispatched or waiting to be.
const TENDING_KEY: &str = "agents";

/// The model an attempt's agent runs, for every attempt an agent ever worked.
fn model_key(attempt: AttemptId) -> String {
    format!("agent:{attempt}")
}

/// An attempt's assignment until it is handed over: it carries the write token.
fn assignment_key(attempt: AttemptId) -> String {
    format!("assignment:{attempt}")
}

#[derive(Deserialize)]
pub(super) struct AgentsBody {
    agents: u32,
    model: Option<String>,
}

/// `AgentActor`'s `Assignment`: what the attempt starts from, its tree and model.
#[derive(Serialize, Deserialize)]
struct Assignment {
    tree: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(flatten)]
    started: Started,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Tended {
    attempt: AttemptId,
    repo: String,
    dispatched: bool,
}

/// `AgentActor`'s `GET /status`, the fields the tree acts on.
#[derive(Deserialize)]
struct Status {
    state: String,
    reason: Option<String>,
    #[serde(rename = "lastWords")]
    last_words: Option<String>,
}

/// An agent's name for its attempt: the model's last part, numbered.
fn agent_name(model: Option<&str>, n: u32) -> String {
    let short = model
        .and_then(|model| model.rsplit('/').next())
        .unwrap_or("kimi-k2.7-code");
    format!("{short}-{n}")
}

impl TreeObject {
    /// Start `agents` attempts at `task`, each worked by its own agent.
    pub(super) async fn start_agents(
        &self,
        tree_name: RepoName,
        task: TaskId,
        body: AgentsBody,
    ) -> Result<Response> {
        if !(1..=MAX_AGENTS).contains(&body.agents) {
            return Response::error(format!("start 1 to {MAX_AGENTS} agents"), 400);
        }
        let Some(mut tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let mut attempts = Vec::new();
        for n in 1..=body.agents {
            match tree.start(task, agent_name(body.model.as_deref(), n)) {
                Ok(attempt) => attempts.push(attempt),
                Err(error) => return super::tree_error(&error),
            }
        }
        self.save(&tree).await?;
        for &attempt in &attempts {
            match self.fork_attempt(&tree, attempt).await? {
                Ok(started) => {
                    self.tend(tree_name.as_str(), body.model.clone(), started)
                        .await?
                }
                Err(refused) => return Ok(refused),
            }
        }
        self.state.storage().set_alarm(Duration::ZERO).await?;
        let mut response = Response::from_json(&serde_json::json!({ "attempts": attempts }))?;
        response = response.with_status(202);
        Ok(response)
    }

    /// Start tending a freshly forked attempt: keep its assignment until the
    /// next alarm hands it to an agent.
    pub(super) async fn tend(
        &self,
        tree: &str,
        model: Option<String>,
        started: Started,
    ) -> Result<()> {
        let attempt = started.attempt;
        let storage = self.state.storage();
        storage
            .put(
                &model_key(attempt),
                model
                    .clone()
                    .unwrap_or_else(|| "@cf/moonshotai/kimi-k2.7-code".to_owned()),
            )
            .await?;
        let tended = Tended {
            attempt,
            repo: started.repo.clone(),
            dispatched: false,
        };
        storage
            .put(
                &assignment_key(attempt),
                serde_json::to_string(&Assignment {
                    tree: tree.to_owned(),
                    model,
                    started,
                })?,
            )
            .await?;
        let mut tending = self.tending().await?;
        tending.push(tended);
        storage.put(TENDING_KEY, &tending).await
    }

    /// The model the agent working `attempt` runs; `None` for an attempt no agent worked.
    pub(super) async fn agent_model(&self, attempt: AttemptId) -> Result<Option<String>> {
        self.state.storage().get::<String>(&model_key(attempt)).await
    }

    async fn tending(&self) -> Result<Vec<Tended>> {
        Ok(self
            .state
            .storage()
            .get::<Vec<Tended>>(TENDING_KEY)
            .await?
            .unwrap_or_default())
    }

    fn agent(&self, repo: &str) -> Result<worker::Stub> {
        self.env.durable_object("AGENTS")?.get_by_name(repo)
    }

    /// `GET /trees/<t>/attempts/<id>/agent`: the agent's status, as it reports it.
    pub(super) async fn agent_status(&self, attempt: AttemptId) -> Result<Response> {
        let Some(tree) = self.load().await? else {
            return Response::error("no such tree", 404);
        };
        let (Some(model), Some(entry)) = (self.agent_model(attempt).await?, tree.attempt(attempt)) else {
            return Response::error("no agent worked this attempt", 404);
        };
        let mut status = self
            .agent(entry.repo.as_str())?
            .fetch_with_str("http://agent/status")
            .await?;
        let mut body: serde_json::Value = status.json().await?;
        if let Some(fields) = body.as_object_mut() {
            fields
                .entry("model")
                .or_insert(serde_json::Value::String(model));
        }
        Response::from_json(&body)
    }

    /// On every alarm: hand waiting attempts to their agents, ask the others how
    /// they are doing, and act on what they say.
    pub(super) async fn tend_agents(&self) -> Result<()> {
        let mut tending = self.tending().await?;
        if tending.is_empty() {
            return Ok(());
        }
        let Some(tree) = self.load().await? else {
            return Ok(());
        };
        let mut still = Vec::new();
        for (at, mut tended) in tending.clone().into_iter().enumerate() {
            // Abandoned, retried or submitted by someone else meanwhile: done.
            if !matches!(
                tree.attempt(tended.attempt).map(|attempt| &attempt.state),
                Some(AttemptState::Working)
            ) {
                if tended.dispatched {
                    self.stop(&tended).await;
                }
                continue;
            }
            if !tended.dispatched {
                match self.dispatch(&tended).await? {
                    None => {
                        // Recorded at once, not with the rest at the end: an
                        // alarm cut short and retried must not hand it out twice.
                        tending[at].dispatched = true;
                        self.state.storage().put(TENDING_KEY, &tending).await?;
                        tended.dispatched = true;
                        still.push(tended);
                    }
                    Some(reason) => {
                        self.give_up(tended.attempt, format!("the agent could not start: {reason}"))
                            .await?
                    }
                }
                continue;
            }
            let status: Status = match self
                .agent(&tended.repo)?
                .fetch_with_str("http://agent/status")
                .await
            {
                Ok(mut answer) => answer.json().await?,
                Err(error) => {
                    worker::console_error!("asking the agent of attempt {}: {error}", tended.attempt);
                    still.push(tended);
                    continue;
                }
            };
            match status.state.as_str() {
                "submitted" => {
                    let mut submitted = self.submit(tended.attempt).await?;
                    if submitted.status_code() >= 300 {
                        let why = submitted.text().await?;
                        self.give_up(tended.attempt, format!("the agent submitted, but: {why}"))
                            .await?;
                    }
                    self.stop(&tended).await;
                }
                "stopped" => {
                    let words = status.last_words.unwrap_or_else(|| "nothing".to_owned());
                    self.give_up(
                        tended.attempt,
                        format!("the agent stopped without submitting; its last words: {words}"),
                    )
                    .await?;
                    self.stop(&tended).await;
                }
                "unassigned" => {
                    self.give_up(tended.attempt, "the agent never got its assignment".to_owned())
                        .await?;
                    self.stop(&tended).await;
                }
                "failed" => {
                    let reason = status.reason.unwrap_or_else(|| "unknown".to_owned());
                    self.give_up(tended.attempt, format!("the agent failed: {reason}"))
                        .await?;
                    self.stop(&tended).await;
                }
                _ => still.push(tended),
            }
        }
        self.state.storage().put(TENDING_KEY, &still).await?;
        if !still.is_empty() {
            self.alarm_within(POLL).await?;
        }
        Ok(())
    }

    /// Hand an attempt's assignment to its agent; `Some(reason)` if it refused.
    async fn dispatch(&self, tended: &Tended) -> Result<Option<String>> {
        let key = assignment_key(tended.attempt);
        // Gone once handed out. Its agent has it, or says `unassigned` when asked.
        let Some(assignment) = self.state.storage().get::<String>(&key).await? else {
            return Ok(None);
        };
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(assignment.into()));
        let mut answer = self
            .agent(&tended.repo)?
            .fetch_with_request(Request::new_with_init("http://agent/grow", &init)?)
            .await?;
        // The token goes no further than the agent: forget it here.
        self.state.storage().delete(&key).await?;
        if answer.status_code() >= 300 {
            return Ok(Some(answer.text().await?));
        }
        Ok(None)
    }

    /// The attempt is done: end its agent's run and free its container.
    /// Best effort: a container the agent fails to close idles out instead.
    async fn stop(&self, tended: &Tended) {
        let mut init = RequestInit::new();
        init.with_method(Method::Post);
        let stopped = match (
            self.agent(&tended.repo),
            Request::new_with_init("http://agent/stop", &init),
        ) {
            (Ok(agent), Ok(request)) => agent.fetch_with_request(request).await.map(|_| ()),
            (Err(error), _) | (_, Err(error)) => Err(error),
        };
        if let Err(error) = stopped {
            worker::console_error!("stopping the agent of attempt {}: {error}", tended.attempt);
        }
    }

    async fn give_up(&self, attempt: AttemptId, note: String) -> Result<()> {
        let mut abandoned = self.abandon(attempt, AbandonBody { note }).await?;
        if abandoned.status_code() >= 300 {
            worker::console_error!("abandoning attempt {attempt}: {}", abandoned.text().await?);
        }
        Ok(())
    }

    /// Make sure an alarm fires within `delay`, without postponing an earlier one.
    async fn alarm_within(&self, delay: Duration) -> Result<()> {
        let storage = self.state.storage();
        let due = js_sys::Date::now() + delay.as_millis() as f64;
        match storage.get_alarm().await? {
            Some(at) if (at as f64) <= due => Ok(()),
            _ => storage.set_alarm(delay).await,
        }
    }
}
