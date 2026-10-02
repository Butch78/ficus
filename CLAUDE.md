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
- `ficus-core::tree`: the tree model (bud → leaves → harvest → fruit node; stale leaves
  regrow, never merge; pruned leaves go to compost). Keep its matches exhaustive.
- `infra/`: alchemy 2.0.0-beta.80 + Effect 4.0.0 + bun 1.4.2 (nix pin). `just infra-check`
  after TS changes. Unstable Effect modules (effect/http, …) are allowed: deps track the
  latest release, so bump them rather than avoid an API (`effecttsgo/unstable-api-usage` is off).
- Lint layers: oxlint with @effect/tsgo (type-aware) + vendored anti-slop at
  `infra/tools/oxlint/anti-slop` (ours to edit; UPSTREAM-COMMIT records the source).
  Judgement-call slop rules go to Clef (`@cf/cloudflare/clef`): `just clef-review`.
- Clef is an `effect/ai` DecisionModel provider (`infra/src/clef/clef.ts`: `layerBinding` in Workers,
  `layerRest` elsewhere). Write questions as `Decision.make` definitions, ask with `DecisionModel.decide`;
  `@effect/ai-typesafe` (Jev) would be a drop-in layer behind the same definitions.
- Secrets: secretspec, `~/.config/ficus/.env`. Agents must set SECRETSPEC_REASON to enter the shell.
- Public entry is the Api Worker (`infra/src/api`): Better Auth on D1 (orgs, API keys via `x-api-key`).
  It forwards `/v1/orgs/<org>/trees/<t>/...` over a service binding to the internal tree Worker
  (no workers.dev) with `x-ficus-tenant` = tenant key (first 50 bits of SHA-256(org id), base32).
  Tree DO name and root repo are `<tenant>-<tree>`. Tree Worker routes, one `TreeObject` DO per tree:
  `POST /trees/<t>/plant {source}` · `POST /trees/<t>/buds {intent}` ·
  `POST /trees/<t>/buds/<b>/leaves {agent}` → fork + write token · `POST /trees/<t>/leaves/<l>/ripe`
  (revokes tokens, reads head from Artifacts, queues scoring; 202) · `GET /trees/<t>/leaves/<l>` (state + report) ·
  `POST /trees/<t>/buds/<b>/harvest` · `POST /trees/<t>/leaves/<l>/{regrow,wither}` · `GET /trees/<t>`.
  Every leaf/node is its own Artifacts repo (`<t>-l<id>`); git auth is `http.extraHeader="Authorization: Bearer <token>"`.
- `POST /trees/<t>/plant {}` with no `source` creates an empty root and returns a write token; push, plant again.
- Scoring: TreeObject's alarm scores every Ripening leaf in parallel, one `Sandbox` per leaf
  (infra/src/sandbox: TS Durable Object on native `ctx.container`, Sandbox SDK 1.0 style; NOT the
  legacy @cloudflare/containers class, which ends 2026-12-31). Internet is off; `Egress` (a
  WorkerEntrypoint via ctx.exports with props) is the only way out: prepare phase = leaf repo (token
  added by Egress, never in the container) + nix/devenv caches; check phase = nothing.
  `ficus-scorer prepare|check` is a CLI run by native exec. The root's `ficus.toml` and devenv files
  come from the base commit (LOCKED_PATHS), so a leaf cannot change its own checks. Cost = diff lines.
  Image: `infra/src/sandbox/context` (nix + devenv; binary from `scripts/build-scorer`).
- The deploy token needs Containers: Edit (registry credentials) on top of Workers, Workers AI, Artifacts.
- `just e2e` (FICUS_API=https://ficus-dev.fruitcards.workers.dev) runs the full cycle live.
- After a deploy, old isolates keep serving for a few seconds: wait before judging a change live
  (an API key minted 7s after a deploy still got the old 10-requests-a-day limit).
- Better Auth refuses cookie-authenticated POSTs without an `Origin` header (CSRF); scripts must send it.
- Fast loop: `cd infra && bun run dev` (alchemy dev, stage `local`): whole stack on localhost in seconds,
  containers via local Docker. Deploy only to verify what local can't (Artifacts, egress interception).
- Debug from telemetry, not re-runs: `scripts/telemetry [minutes] [worker] [limit]` (Workers
  Observability; every Worker has logs + traces on). Egress logs one line per decision.
- CI/CD (alchemy's guide): `.github/workflows/ci.yml` (Rust fmt/clippy/test, infra typecheck/lint/test,
  actionlint + zizmor) and `deploy.yml` (`pr-<n>` stage per same-repo PR with a GitHub.Comment and the
  e2e smoke, destroyed on close; `prod` from main). GitHub-HOSTED runners on purpose: public repo,
  so no self-hosted runners. Credentials as code: `infra/bootstrap.run.ts` (stage `bootstrap`, run
  once from a shell with an API-Tokens-Write credential + GITHUB_TOKEN) mints `ficus-ci` and writes
  the repo secrets + FICUS_DEPLOYS_ENABLED. Pin actions by SHA.
