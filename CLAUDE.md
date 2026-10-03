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
- `infra/`: alchemy from the alchemy-run/alchemy#1904 preview (`pkg.alchemy.run/alchemy/pr:1904:<sha>`, for
  Durable Object-managed containers; back to a release once it lands) + Effect 4.0.0 + bun 1.4.2 (nix pin). `just infra-check`
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
  `POST /trees/<t>/release {node?}` · `GET /trees/<t>/release` · `GET /trees/<t>`.
  Every attempt/node is its own Artifacts repo (`<t>-a<id>`); git auth is `http.extraHeader="Authorization: Bearer <token>"`.
- `POST /trees/<t>/init {}` with no `source` creates an empty root and returns a write token; push, init again.
- Scoring: TreeObject's alarm first rebases every behind submitted attempt (one `Sandbox` per attempt,
  `POST /rebase`: Egress grants the behind repo read and the fresh repo write; a conflict is 422
  and final, a sandbox failure retries up to 5 times), then scores every Checking attempt in parallel,
  one `Sandbox` per attempt.
  `infra/src/sandbox` is an Effect-native alchemy Worker: `Sandbox` (scoring, rebasing) and `Workspace`
  (an agent's container) are `Cloudflare.DurableObject`s, each with its own `Cloudflare.Container` (same
  image, `schedulingPolicy: "durable_object"`: the DO picks `images.default` or a snapshot, and the
  size, at each `start()`; the only policy with snapshots, and immutable). They drive the raw `state.container` (exec, `interceptOutboundHttps`, `snapshotContainer`):
  alchemy's container handle has none of those and starts eagerly, so `containers.ts` binds through
  alchemy's internal `~alchemy/Container/Binding` key (recheck on alchemy upgrades). NOT the legacy
  @cloudflare/containers class, which ends 2026-12-31. Internet is off; Egress is the Worker's default
  export, routed per host via `ctx.exports.default({ props })` (an Effect-native Worker cannot export a
  named WorkerEntrypoint): prepare phase = attempt repo (token added by Egress, never in the container)
  + nix/devenv caches; check phase = nothing. `ficus-scorer prepare|check|rebase|fs` is a CLI run by
  native exec. The root's `ficus.toml` and devenv files come from the base commit (LOCKED_PATHS), so an
  attempt cannot change its own checks; the task's checks travel in the request and run after the
  root's. Cost = diff lines; the report also lists `touched` paths.
  `[[judge]]` in ficus.toml = a yes/no question on `{task, diff}` the Sandbox asks Clef (Workers AI binding)
  after the container is gone; counts as a check, and its mean confidence breaks cost ties at acceptance.
  Image: `infra/src/sandbox/context` (nix + devenv; binary from `scripts/build-scorer`).
- Snapshots: per base commit. The first cold scoring of a base warms one (prepare the base alone, clear
  the workdir, `snapshotContainer`) and TreeObject stores its id (`snapshot:<base>`); later scorings and
  agents' Workspaces of that base boot from it, falling back to the image if it will not restore. Boots
  carry a nonce so a ready-marker restored from a snapshot never passes for the new boot's.
- Agents: every attempt start/retry starts an `AgentActor` (async `ficus-agents` Worker: pi's Lifecycle needs
  a plain DO class) unless the body says `start_agent: false`; the Api does it (`src/api/agents.ts`), so the
  deploy order stays tree → agents → Api. The e2e opts out. Local dev cannot run it end to end:
  cross-script DO calls lose `ctx.id.name`, which pi's Lifecycle requires.
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
