//! The Ficus tree Worker. Internal only: it has no public URL, and the public
//! edge (`infra/src/api`) is the one caller. The edge authenticates the user,
//! authorizes them against an organization, and forwards `/trees/<tree>/...`
//! with that organization's tenant key in `x-ficus-tenant`; this Worker hands
//! the request to the tenant's tree Durable Object.

mod artifacts;
mod diff;
mod progress;
mod tree_object;

use ficus_core::tenant::{TENANT_HEADER, TenantKey};
use ficus_core::tree::RepoName;
use worker::{Context, Env, Request, Response, Result, event};

pub use tree_object::TreeObject;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    let Some(tree) = path
        .strip_prefix("/trees/")
        .and_then(|rest| rest.split('/').next())
    else {
        return Response::error("not found", 404);
    };
    let tenant = match tenant_of(&req)? {
        Ok(tenant) => tenant,
        Err(response) => return Ok(response),
    };
    let scoped = tenant.scope(tree);
    if RepoName::try_from(scoped.clone()).is_err() {
        return Response::error(
            "tree names are letters, digits, '.', '-' and '_', and at most 40 characters",
            400,
        );
    }
    let stub = env.durable_object("TREES")?.get_by_name(&scoped)?;
    stub.fetch_with_request(req).await
}

/// The tenant the edge vouched for, or the response refusing the request.
pub(crate) fn tenant_of(req: &Request) -> Result<std::result::Result<TenantKey, Response>> {
    let Some(header) = req.headers().get(TENANT_HEADER)? else {
        return Response::error("no tenant: requests come through the Ficus API", 401).map(Err);
    };
    match TenantKey::try_from(header) {
        Ok(key) => Ok(Ok(key)),
        Err(error) => Response::error(error.to_string(), 400).map(Err),
    }
}
