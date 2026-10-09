# Ficus

Git platform on Cloudflare Workers + Artifacts, all Effect TypeScript in `infra/`. Contest entry,
deadline 2026-10-14.

- Toolchain + every tool come from devenv (`devenv shell -- <cmd>` or direnv): bun, node, just,
  actionlint, zizmor. No Rust any more (ported to Effect 2026-10-03; trees stored before still load).
- `infra/src/core`: the domain, no Workers APIs, pure functions answering `Result` (bun-testable). Put logic
  here. `infra/src/tree`: the tree Worker (`TreeObject` DO, Artifacts reads, scoring/rebase/agents
  plumbing). `infra/src/scorer`: the `ficus-scorer` CLI, bundled by `scripts/build-scorer` and run by bun
  in the sandbox image. The sandbox and agents import core's schemas; never copy them.
- nixpkgs' wrangler/workerd caps `compatibility_date` at 2026-09-10.
- `src/core/tree.ts`: the tree model (task → attempts → accept → node; closed attempts go to
  history; never a merge). A submitted attempt left behind is **rebased** first: the alarm replays its
  commits onto the head in a fresh attempt (`rebaseStart/Done/Failed/Retry`) and scores it there;
  only a conflict sends it back to its agent to **retry** (`MAX_RETRIES` per task, then the
  owner decides). Attempts and nodes record `touched` paths, so `behind` can say what overlaps.
  Tasks carry their own `checks` (run after the root's, never in the repo). `acceptNext` takes the
  oldest ready task. `release` is a pointer at a node (older node = rollback). Keep matches exhaustive
  (`Phase` is a `Data.TaggedEnum`; stored enums stay externally tagged, `legacy.ts` renames old keys).
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
  `POST /trees/<t>/attempts/<id>/submit` (checks there is a commit beyond the base before it revokes tokens, so a refused submit keeps them; reads head from Artifacts, queues scoring; 202) ·
  `GET /trees/<t>/attempts/<id>` (state + report) · `POST /trees/<t>/tasks/<id>/accept` ·
  `POST /trees/<t>/accept` (oldest ready task; both set the alarm that rebases the behind attempts) ·
  `GET /trees/<t>/behind` · `POST /trees/<t>/attempts/<id>/{retry,abandon}` ·
  `POST /trees/<t>/tasks/<id>/close {note}` (closes a task with no open attempt, unaccepted; 409 otherwise) ·
  `POST /trees/<t>/release {node?}` · `GET /trees/<t>/release` · `GET /trees/<t>` ·
  `POST /trees/<t>/visibility {public}` (members; `public` is optional in the tree, absent = private) ·
  `POST /trees/<t>/graft {source, branch?}` (imports an outside commit into `<t>-g<id>` as the new head;
  open attempts become behind and are rebased; `.github/workflows/graft.yml` follows GitHub's main) ·
  `GET /trees/<t>/{attempts,nodes}/<id>/{log,tree,file}?ref=&path=` (reads through Artifacts; the tree picks
  the repo, `src/core/browse.ts`; files leave as text/plain or octet-stream, never HTML).
  The Api lists an org's trees (`GET /v1/orgs/<org>/trees`) from D1 (`ficus_tree`), recorded on each 2xx init.
  Public trees (`src/core/visibility.ts`): a request with no session and no API key passes the Api only for GET
  `/v1/orgs/<org>/trees/<t>` and `.../{attempts,nodes}/<id>/{log,tree,file,diff}` (`anonymousMay`); the Api finds
  the org id by slug in Better Auth's `organization` table and forwards with `x-ficus-anonymous` (stripped from
  every caller's request), and the tree Worker answers it 404 `no such tree` unless the tree is public, the same as
  an unknown tree or organization. Members' requests are unchanged; everything else needs a member.
- Api D1: Drizzle 1.0 RC (pinned to alchemy's peer, `1.0.0-rc.5-ab785fc`). Ficus's tables are declared in
  `infra/src/api/schema.ts` and queried through `drizzle-orm/effect-d1` (`@effect/sql-d1`'s `D1Client`, provided
  per request). Migrations are drizzle-kit folders in `src/api/migrations`: alchemy's `Drizzle.Schema` writes
  one on deploy for any change to schema.ts. Better Auth's tables are not in schema.ts: `bun run auth:schema
  <name>` asks Better Auth what the chain lacks and writes a custom migration. The baseline is `IF NOT EXISTS`
  so stages migrated before Drizzle adopt it (`migrations.test.ts`). Skip `drizzle-orm/effect-schema`: it calls
  `Schema.isLengthBetween`, which effect 4.0.0 lacks.
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
- Agents: `infra/src/agents` (Worker `ficus-agents-<stage>`), one `AgentActor` per agent attempt: pi-durable on
  Workers AI in two phases (a cheap scout plans, `@cf/moonshotai/kimi-k2.7-code` changes), Clef judging the plan
  and the diff (`gates.ts`). `POST /trees/<t>/tasks/<id>/agents {agents, model}` starts + forks attempts and keeps
  each assignment; the TreeObject alarm (`src/tree/agents.ts`) hands them to the `AGENTS` binding, then polls
  `GET /status`: submitted → the tree submits the attempt; stopped/failed/unassigned → abandons it with the
  agent's last words. Nothing calls the tree back (cross-Worker DO bindings both ways can't deploy on a fresh
  stage). The agent's workspace is a Sandbox: `POST /workspace` (egress: the attempt repo with Egress-added
  token + nix caches; the Sandbox checks the attempt out), `/fs/<op>` and `/exec` run `ficus-scorer fs|exec`
  (request on stdin). Egress routes belong to the Sandbox DO instance: `#open` reopens them from storage on each
  new instance. `/grow` answers at once and opens the workspace in a detached fiber (placing a container can
  take minutes; the tree's alarm must not wait). Once an attempt stops working the tree `POST /stop`s its agent,
  which aborts pi and `DELETE /workspace`s: an idle workspace holds one of the Sandbox class's instances, and
  when they run out new ones fail with "There is no container instance that can be provided". pi's shell
  timeouts are seconds (`sandbox-env.ts` `timeoutMs`).
- UI pages: tree (head, open tasks and how each stands, New task, accepted history); task (standings from
  `src/core/tree.ts` `standings`, which shares the winner with `accept`; the case for accepting; Start
  agents; work one yourself); attempt (timeline, actions, diff via `GET .../{attempts,nodes}/<id>/diff`, scoring
  ledger, the agent at work).
- Tracing is Effect's: `infra/src/observability/tracer.ts` is an Effect `Tracer` layer that records every
  `Effect.fn`/`withSpan` as a Cloudflare span (scalar annotations → attributes), nested with the platform's own.
  The Api and the UI provide it per request; name spans with `Effect.fn("Area.what")`, annotate with
  `Effect.annotateCurrentSpan`. Never call `cloudflare:workers` `tracing` directly.
- Live progress: `POST /trees/<t>/init` with `Accept: application/x-ndjson` streams one JSON line per step
  (`src/core/progress.ts`: import → settle → lock → save, then the outcome, the answer the plain call gives);
  without that header it answers as before. `TreeObject`'s `#initStreaming` runs the
  work under `waitUntil` while a TransformStream answers. The Api passes the stream through and appends `record` after a 2xx outcome.
  The UI's `InitForm` reads it via `/api/init` and ticks steps off (`lib/init-progress.ts`), shown with AI
  Elements' Task and ChainOfThought ported to Kumo (`components/elements/`, Apache-2.0, LICENSE there).
  Scoring streams the same way (Sandbox `/score` → `scoring:<attempt>` ledger, shown live on attempt pages).
- "What happened" panel: the UI shows an operation's trace like an agent's tool call: one line
  (`✓ Init site · 3.7 s`) → steps in words (`lib/activity.ts` `sentence()`/`narrate()`, keyed on span names;
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
  `[fetch] {hosts, run}` in ficus.toml (from the base, like the checks): scoring is `ficus-scorer prepare` (clone,
  restore; reports the hosts) → the Sandbox opens them → `fetch` (devenv build + `run`) → every route closes →
  `check`. Agent workspaces open the same hosts, read once at the base (`ficus-scorer hosts`). Ficus's own
  `ficus.toml` mirrors ci.yml. Attempts push `HEAD` (their default branch may not be `main`).
  `[[judge]]` in ficus.toml = a yes/no question on `{task, diff}` the Sandbox asks Clef (Workers AI binding)
  after the container is gone; counts as a check, and its mean confidence breaks cost ties at acceptance.
  Image: `infra/src/sandbox/context` (nix + devenv + bun; `ficus-scorer.js` from `scripts/build-scorer`). Run
  `scripts/build-scorer` before `bun run deploy`: alchemy builds the image before its ScorerBinary step, so
  otherwise the image copies a missing or stale bundle.
- Deploys: `[deploy] {run, deployer?, hosts?, timeout_secs?}` in ficus.toml, read from the released commit itself (accepted, so
  trusted). `POST /trees/<t>/release` starts one `Deploy` Workflow instance (`<tree>-deploy-<n>`, `src/deploys`: an
  Effect-native alchemy Worker, `Cloudflare.Workflow` + `Workflows.task`) and records it; `GET /trees/<t>/deploys`
  reads each instance's status. The Workflow mints a read token and asks a Sandbox `POST /deploy {part}`: `ficus-scorer
  deploy-prepare` (clone, read `[deploy]`) → its hosts + `api.cloudflare.com` open (Egress `cloudflare` mode swaps the
  container's placeholder `CLOUDFLARE_API_TOKEN` for the deploy token; credentials the API issued, like asset upload
  JWTs, pass as sent) → `ficus-scorer deploy`. Step `deploy` runs `run` in the deployer (`ficus-deployer-<stage>`,
  `deployer.run.ts`: the Sandbox code and image as a stack of its own); once it passed, step `deployer` runs
  `deployer` in a scoring sandbox. So a deploy never replaces the Worker its container runs under (a redeploy resets
  its Durable Objects and cuts the exec off). Deploy the deployer stack before the Ficus stack on a deploys stage: the
  deploys Worker binds it by `Worker.ref`. A fresh deployer stack fails its first deploy at the container's precreate
  (the image is still an unresolved build output); the image is built by then, so run it again.
  Only a stage deployed with `FICUS_DEPLOYS=true` gets the deploys Worker and the tree's `DEPLOYS` binding; the
  Workflow binds the stage's deploy token from the Secrets Store by reference (`secrets.run.ts`, stack
  `FicusSecrets`: `STAGE=prod bun run deploy:secrets` mints `ficus-deploy-<stage>` with `src/permissions.ts`, or
  keeps a given `FICUS_DEPLOY_TOKEN`), so deploying never needs the token's value.
- Ficus deploys itself: `[deploy] run` in ficus.toml is `bun run deploy` + `deploy:web` as prod, `deployer` is
  `deploy:deployer`, each after `scripts/restore-builds prod`: Command.Build calls a missing outdir changed, so in a
  fresh clone the scorer and image builds would always update and redeploy the sandbox (resetting the scoring and
  agents it runs). Rebuilt first (both reproducible), they noop when unchanged. The stack builds
  the sandbox image itself: `Command.Build("SandboxImage")` (src/sandbox/stack.ts, memoized on nix/sandbox-image.nix,
  the context and devenv.lock) runs `scripts/sandbox-image`: nix `dockerTools` build, skopeo push (from the devenv,
  15-minute registry credentials), the reference into `infra/.sandbox-image/reference`; the container deploys it
  as-is. Stage `local` (`alchemy dev`) builds `context/Dockerfile` with Docker instead. Inside the devenv shell,
  secretspec loads `~/.config/ficus/.env` over your environment: run deploys with another token outside it.
- Backups: `GET /trees/<t>/export` (all storage, assignments left out); the Api's nightly cron writes every tree in
  the directory to R2 `ficus-backups-<stage>` as `trees/<org>/<tree>/<date>.json`, expired after 90 days.
- On expanse-5950x one of Cloudflare's IPv6 edges for workers.dev is unreachable: run scripts against deployed
  stages with `CURL_HOME=<dir with .curlrc: ipv4>` if they hang.
- The deploy token needs Containers: Edit (registry credentials) on top of Workers, Workers AI, Artifacts.
- `just e2e` (FICUS_API=https://ficus-dev.fruitcards.workers.dev) runs the full cycle live.
- After a deploy, old isolates keep serving for a few seconds: wait before judging a change live
  (an API key minted 7s after a deploy still got the old 10-requests-a-day limit).
- Better Auth refuses cookie-authenticated POSTs without an `Origin` header (CSRF); scripts must send it.
- Fast loop: `cd infra && bun run dev` (alchemy dev, stage `local`): whole stack on localhost in seconds,
  containers via local Docker. Deploy only to verify what local can't (Artifacts, egress interception).
- Debug from telemetry, not re-runs: `scripts/telemetry [minutes] [worker] [limit]` (Workers
  Observability; every Worker has logs + traces on). Egress logs one line per decision.
- Ficus hosts itself: the source of truth is the prod tree `ficus` in organization `ficus`. A change is an attempt
  made with `scripts/attempt` (`task`, `start`, `submit`, `accept`, `mirror`), not a GitHub pull request. GitHub
  `main` is a fast-forward-only mirror (a ruleset blocks force pushes and deletion), kept for the public source
  link and a second run of `ci.yml`. Write a task's intent as the change itself: the Clef judge sees only the task
  and the diff.
- CI/CD (alchemy's guide): `.github/workflows/ci.yml` (infra typecheck/lint/test,
  actionlint + zizmor; on each mirror push) and `deploy.yml` (`pr-<n>` stage per same-repo PR, if any, with a GitHub.Comment and the
  e2e smoke, destroyed on close; `prod` is Ficus's own release, never from GitHub). GitHub-HOSTED runners on purpose: public repo,
  so no self-hosted runners. Credentials as code: `infra/bootstrap.run.ts` (stage `bootstrap`, run
  once from a shell with an API-Tokens-Write credential + GITHUB_TOKEN) mints `ficus-ci` and writes
  the repo secrets + FICUS_DEPLOYS_ENABLED. Pin actions by SHA.
