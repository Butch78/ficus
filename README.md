# Ficus 🌿

A Rust git platform for agents, built on Cloudflare Workers and Artifacts.

Entry for Cloudflare's [next git platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare)
challenge (submissions close 2026-10-14).

## Develop

Needs [nix](https://nixos.org) + [devenv](https://devenv.sh).

```sh
direnv allow          # or: devenv shell
just test             # native tests
just dev              # wrangler dev on the main Worker
just git-dev          # wrangler dev on the emscripten git engine
just fl               # fmt + clippy (native and wasm32)
```

## Layout

- `crates/ficus-core` — domain logic, no Workers APIs, tested natively
- `crates/ficus-worker` — the main Worker (`workers-rs`, `wasm32-unknown-unknown`)
- `crates/ficus-git` — the git engine Worker on the experimental
  [`wasm32-unknown-emscripten`](https://blog.cloudflare.com/rust-workers-emscripten-target/)
  target: libc + an in-memory filesystem, so `std::fs` and C-backed crates work.
  Standalone crate (own lockfile) built with `worker-build --emscripten`.

## Infra and lint

- `infra/` deploys with [alchemy](https://alchemy.run) (`just deploy`) and is Effect throughout.
- `just infra-check`: typecheck, then oxlint with `@effect/tsgo`'s type-aware rules and the
  vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules (generic + Effect).
- `just clef-review`: asks Cloudflare's [Clef](https://blog.cloudflare.com/clef-decision-models/)
  decision model the judgement calls a linter cannot make (restating comments, swallowed
  failures, unparsed boundaries, tests that cannot fail) about changed TypeScript.

Credentials go in `~/.config/ficus/.env` (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).

## CI/CD

- Every pull request and push: `ci.yml` (Rust fmt, clippy on native/wasm32/emscripten, tests; infra
  typecheck, lint, tests; actionlint and zizmor on the workflows).
- Deploys follow [alchemy's CI guide](https://alchemy.run/guides/ci/): each pull request gets its own
  `pr-<n>` stage (with a comment linking it, and the end-to-end smoke test), destroyed when it closes;
  `main` deploys `prod`.
- Credentials are code: `cd infra && bun run deploy:bootstrap` (once, with a Cloudflare credential that
  can create API tokens and a GitHub token with admin on the repo) mints a scoped CI token and writes
  the repository secrets. Until it has run, deploys skip.

## License

MIT
