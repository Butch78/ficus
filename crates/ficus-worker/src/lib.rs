use ficus_core::RepoPath;
use worker::*;

#[event(fetch)]
async fn fetch(req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    match RepoPath::parse(&path) {
        Some(repo) => Response::ok(format!("ficus: {}/{}", repo.owner, repo.name)),
        None => Response::ok("ficus 🌿"),
    }
}
