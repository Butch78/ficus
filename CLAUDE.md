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
- `ficus-core::tree`: the tree model (task → attempts → accept → node; closed attempts go to
  history; never a merge). A submitted attempt left behind is **rebased** first: the alarm replays its
  commits onto the head in a fresh attempt (`rebase_start/done/failed/retry`) and scores it there;
  only a conflict sends it back to its agent to **retry** (`MAX_RETRIES` per task, then the
  owner decides). Attempts and nodes record `touched` paths, so `behind` can say what overlaps.
  Tasks carry their own `checks` (run after the root's, never in the repo). `accept_next` takes the
  oldest ready task. `release` is a pointer at a node (older node = rollback). Keep matches exhaustive.
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
  `POST /trees/<t>/init {source}` · `POST /trees/<t>/tasks {intent, checks?}` ·
  `POST /trees/<t>/tasks/<id>/attempts {agent}` → fork + write token (+ the task's checks) ·
  `POST /trees/<t>/attempts/<id>/submit` (revokes tokens, reads head from Artifacts, queues scoring; 202) ·
  `GET /trees/<t>/attempts/<id>` (state + report) · `POST /trees/<t>/tasks/<id>/accept` ·
  `POST /trees/<t>/accept` (oldest ready task; both set the alarm that rebases the behind attempts) ·
  `GET /trees/<t>/behind` · `POST /trees/<t>/attempts/<id>/{retry,abandon}` ·
  `POST /trees/<t>/release {node?}` · `GET /trees/<t>/release` · `GET /trees/<t>` ·
  `GET /trees/<t>/{attempts,nodes}/<id>/{log,tree,file}?ref=&path=` (reads through Artifacts; the tree picks
  the repo, `ficus-core::browse`; files leave as text/plain or octet-stream, never HTML).
  The Api lists an org's trees (`GET /v1/orgs/<org>/trees`) from D1 (`ficus_tree`), recorded on each 2xx init.
  Every attempt/node is its own Artifacts repo (`<t>-a<id>`); git auth is `http.extraHeader="Authorization: Bearer <token>"`.
- `POST /trees/<t>/init {}` with no `source` creates an empty root and returns a write token; push, init again.
- Web UI: `infra/src/web`, vinext 1.x (Next.js App Router API on Vite) via `Cloudflare.Website.Vinext`,
  its own stack `infra/web.run.ts` (stage = the Ficus stack's; binds `Api` by `Cloudflare.Worker.ref`).
  The browser only talks to the UI's origin: `app/api/auth/*` proxies Better Auth, server components call
  the Api over the binding with the UI's origin, and the Api builds one Better Auth per origin.
  Pages run Effects through `lib/run.ts` (`load`: 401 → /sign-in, 404 → notFound). `just e2e-web` smokes it.
  Styled with Kumo (`@cloudflare/kumo`, Tailwind v4; guide: `node_modules/@cloudflare/kumo/ai/USAGE.md`, or
  `bunx kumo doc <Component>`): Kumo components and semantic tokens only (`bg-kumo-*`, `text-kumo-*`,
  `border-kumo-*`), no palette colors, no `dark:` (`src/web/kumo-styling.test.ts` enforces it). Server
  components take compound parts (`Table.Row`, `LayerCard.Primary`, ...) from `components/kumo.ts`: on a
  client reference, `Table.Row` is undefined (React error #130).
- Agents: `infra/src/agents` (Worker `ficus-agents-<stage>`), one `AgentActor` (pi-durable on Workers AI,
  default `@cf/moonshotai/kimi-k2.7-code`) per agent leaf. `POST /trees/<t>/buds/<b>/grow {agents, model}`
  sprouts + forks and keeps each assignment; the TreeObject alarm (`tree_object/agents.rs`) hands them to the
  `AGENTS` binding, then polls `GET /status`: submitted → the tree submits the leaf; stopped/failed → withers it
  with the agent's last words. Nothing calls the tree back (cross-Worker DO bindings both ways can't deploy on
  a fresh stage). The agent's workspace is a Sandbox: `POST /workspace` (egress: leaf repo with Egress-added
  token + nix caches), `/fs/<op>` and `/exec` run `ficus-scorer fs|exec` (request on stdin). Egress routes
  belong to the Sandbox DO instance: `#open` reopens them from storage on each new instance.
  `/grow` answers at once and opens the workspace in a detached fiber (placing a container can take
  minutes; the tree's alarm must not wait). Once a leaf leaves Growing the tree `POST /stop`s its agent,
  which aborts pi and `DELETE /workspace`s: an idle workspace holds one of the Sandbox class's instances,
  and when they run out new ones fail with "There is no container instance that can be provided".
- UI pages: tree = garden (head, open buds' races, New bud, harvests); bud = the race (standings from
  `ficus-core` `Tree::standings`, which shares `winner()` with `harvest`; harvest case; Grow with agents; grow
  it yourself); leaf = timeline, actions, diff (`GET .../{leaves,nodes}/<id>/diff`), scoring ledger, agent at work.
- Tracing is Effect's: `infra/src/observability/tracer.ts` is an Effect `Tracer` layer that records every
  `Effect.fn`/`withSpan` as a Cloudflare span (scalar annotations → attributes), nested with the platform's own.
  The Api and the UI provide it per request; name spans with `Effect.fn("Area.what")`, annotate with
  `Effect.annotateCurrentSpan`. Never call `cloudflare:workers` `tracing` directly.
- Live progress: `POST /trees/<t>/plant` with `Accept: application/x-ndjson` streams one JSON line per step
  (`ficus-core::progress`: import → settle → lock → save, then the outcome, the answer the plain call gives);
  without that header it answers as before. `TreeObject` holds `Rc<State>` so `plant_streaming` can spawn the
  work while the response streams. The Api passes the stream through and appends `record` after a 2xx outcome.
  The UI's `PlantForm` reads it via `/api/plant` and ticks steps off (`lib/plant-progress.ts`), shown with AI
  Elements' Task and ChainOfThought ported to Kumo (`components/elements/`, Apache-2.0, LICENSE there).
- "What happened" panel: the UI shows an operation's trace like an agent's tool call: one line
  (`✓ Plant site · 3.7 s`) → steps in words (`lib/activity.ts` `sentence()`/`narrate()`, keyed on span names;
  add a case when you add a span worth telling) → the raw spans. Same-account service bindings share one trace
  (UI → Api → tree Worker → TreeObject → Artifacts/D1). A Worker can't read its trace id, so an operation is an
  `Effect.fn("ficus.<op>")` annotated with `ficus.operation` (uuid) + `ficus.org`; `/api/activity` (members only)
  finds it through the Workers Observability query API. Traces land ~15-20 s after the work, Durable Object
  spans later. Needs `FICUS_OBSERVABILITY_TOKEN` (Workers Observability Read; bootstrap mints
  `ficus-observability-read` for CI); unset → "no trace".
- Scoring: TreeObject's alarm first rebases every behind submitted attempt (one `Sandbox` per attempt,
  `POST /rebase`: Egress grants the behind repo read and the fresh repo write; a conflict is 422
  and final, a sandbox failure retries up to 5 times), then scores every Checking attempt in parallel, one `Sandbox` per attempt
  (infra/src/sandbox: TS Durable Object on native `ctx.container`, Sandbox SDK 1.0 style; NOT the
  legacy @cloudflare/containers class, which ends 2026-12-31). Internet is off; `Egress` (a
  WorkerEntrypoint via ctx.exports with props) is the only way out: prepare phase = attempt repo (token
  added by Egress, never in the container) + nix/devenv caches; check phase = nothing.
  `ficus-scorer prepare|check` is a CLI run by native exec. The root's `ficus.toml` and devenv files
  come from the base commit (LOCKED_PATHS), so a attempt cannot change its own checks; the task's checks
  travel in the request and run after the root's. Cost = diff lines; the report also lists `touched` paths.
  `[[judge]]` in ficus.toml = a yes/no question on `{task, diff}` the Sandbox asks Clef (Workers AI binding)
  after the container is gone; counts as a check, and its mean confidence breaks cost ties at acceptance.
  Image: `infra/src/sandbox/context` (nix + devenv; binary from `scripts/build-scorer`). Run
  `scripts/build-scorer` before `bun run deploy`: alchemy builds the image before its ScorerBinary step, so
  otherwise the image copies a missing or stale binary.
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
