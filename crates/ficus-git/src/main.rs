//! The Ficus git engine, on `wasm32-unknown-emscripten`.
//!
//! The emscripten target gives the Worker a libc and an in-memory
//! filesystem, so `std::fs` and C-backed crates work here. An emscripten
//! build links a bin target (emcc is the linker and runs wasm-bindgen
//! post-link), hence `main.rs` with an empty `main`.

use std::fs;
use worker::*;

fn main() {}

#[event(fetch)]
async fn fetch(_req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    let dir = std::env::temp_dir().join("ficus");
    let probe = (|| -> std::io::Result<String> {
        fs::create_dir_all(&dir)?;
        fs::write(dir.join("HEAD"), "ref: refs/heads/main\n")?;
        fs::read_to_string(dir.join("HEAD"))
    })()
    .map_err(|e| Error::RustError(e.to_string()))?;
    Response::ok(format!("ficus-git (emscripten) HEAD = {probe}"))
}
