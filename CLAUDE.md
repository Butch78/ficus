# Ficus

Rust git platform on Cloudflare Workers + Artifacts. Contest entry, deadline 2026-10-14.

- Toolchain + every tool come from devenv (`devenv shell -- <cmd>` or direnv).
- `just test` / `just fl` after Rust changes; `just build` and `just git-build` for the Workers.
- `crates/ficus-core`: no Workers APIs, native-testable. Put logic here.
- `crates/ficus-worker`: wasm32-unknown-unknown Worker.
- `crates/ficus-git`: wasm32-unknown-emscripten Worker (experimental), a standalone
  crate excluded from the workspace — has its own Cargo.lock. Bin target with empty `main`.
- worker-build 0.8.7 is packaged in nix/packages.nix (nixpkgs has 0.8.5, no `--emscripten`).
- nixpkgs' wrangler/workerd caps `compatibility_date` at 2026-09-10.
- On expanse-5950x the shared sccache daemon runs as gh-runner and cannot write a
  root-owned target/: build as root with `RUSTC_WRAPPER=""`.
