//! The Ficus Worker: authenticates, then hands `/trees/<name>/...` to that
//! tree's Durable Object.

mod artifacts;
mod tree_object;

use ficus_core::tree::RepoName;
use worker::{Context, Env, Request, Response, Result, event};

pub use tree_object::TreeObject;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    if path == "/" {
        return Response::ok("ficus 🌿");
    }
    let Some(tree) = path
        .strip_prefix("/trees/")
        .and_then(|rest| rest.split('/').next())
    else {
        return Response::error("not found", 404);
    };
    if RepoName::try_from(tree.to_owned()).is_err() {
        return Response::error("tree names are Artifacts repo names", 400);
    }
    // Sprouting hands out write tokens, so nothing past here is public.
    let expected = env.secret("FICUS_ADMIN_TOKEN")?.to_string();
    let presented = req.headers().get("authorization")?.unwrap_or_default();
    if !same_secret(
        presented.strip_prefix("Bearer ").unwrap_or_default(),
        &expected,
    ) {
        return Response::error("unauthorized", 401);
    }
    let stub = env.durable_object("TREES")?.get_by_name(tree)?;
    stub.fetch_with_request(req).await
}

/// Compare without stopping at the first differing byte.
fn same_secret(presented: &str, expected: &str) -> bool {
    presented.len() == expected.len()
        && presented
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}
