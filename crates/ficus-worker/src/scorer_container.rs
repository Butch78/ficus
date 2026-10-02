//! `ScorerContainer`: a Durable Object with a Cloudflare Container attached,
//! running `ficus-scorer` (crates/ficus-scorer). One instance per leaf being
//! scored, so leaves are scored in parallel.

use std::time::Duration;

use worker::{
    ContainerStartupOptions, DurableObject, Env, Request, Response, Result, State, durable_object,
};

/// The port `ficus-scorer` listens on (its Dockerfile sets PORT=8080).
const SCORER_PORT: u16 = 8080;
/// How long a freshly started container gets to start listening.
const BOOT_POLLS: u32 = 60;
const BOOT_POLL_MS: u64 = 1000;

#[durable_object]
pub struct ScorerContainer {
    state: State,
}

impl DurableObject for ScorerContainer {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let Some(container) = self.state.container() else {
            return Response::error("this Durable Object has no container attached", 500);
        };
        if !container.running() {
            let mut options = ContainerStartupOptions::new();
            // Clones come from Artifacts and devenv pulls from nix caches.
            options.enable_internet(true);
            container.start(Some(options))?;
        }
        let port = container.get_tcp_port(SCORER_PORT)?;
        let mut ready = false;
        for _ in 0..BOOT_POLLS {
            if let Ok(health) = port.fetch("http://scorer/health", None).await
                && health.status_code() == 200
            {
                ready = true;
                break;
            }
            worker::Delay::from(Duration::from_millis(BOOT_POLL_MS)).await;
        }
        if !ready {
            return Response::error("the scorer container did not start listening", 503);
        }
        port.fetch_request(req).await
    }
}
