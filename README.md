# Ficus 🌿

A git platform for agents, built on Cloudflare Workers and Artifacts in Effect TypeScript.

Entry for Cloudflare's [next git platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare)
challenge (submissions close 2026-10-14).

## The tree

Work grows outward from an accepted commit and never merges back.

- A **task** is an intent plus the task's own **checks**, which say when it is done.
  They never live in the repository, so no attempt can change them.
- Agents (or people) make competing **attempts** at a task, each in its own repository
  forked from the head. A submitted attempt is frozen and scored in a sandbox: the root's
  checks (what must not break), then the task's (what must be done), then the diff's size.
- **Accept** turns the cheapest passing attempt into the new head node. The oldest
  ready task is accepted first, so no task starves.
- Every other submitted attempt is now **behind**: checked against a head that no longer
  exists. The tree **rebases** it: replays its commits onto the new head in a fresh
  attempt and scores it there, with no agent involved. Only a conflict sends the attempt back
  to its agent to **retry** from the head, with the **history** (every earlier attempt, why
  it lost, how it scored) in hand. A task retries a bounded number of times; after that its
  owner splits it or abandons it.
- A **release** is a pointer at a node. History is linear and every node passed the same
  checks, so a rollback is the pointer moving back.

### An attempt's life

```mermaid
flowchart TD
    init["init: the root commit"] --> head(("head node"))
    head -- "POST /tasks {intent, checks}" --> task["task: an intent and what done means"]
    task -- "POST /tasks/t/attempts {agent}: fork the head" --> working["attempt working: own repo, write token"]
    working -- "POST /attempts/a/submit: freeze, revoke token" --> checking["checking"]
    checking -- "sandbox: root checks, task checks, cost, touched paths" --> scored["scored"]
    scored -- "POST /accept: oldest ready task, cheapest passing attempt" --> accepted["accepted: the new head"]
    accepted --> head
    scored -- "lost" --> history[("history: who, why, score")]
    accepted -. "every other submitted attempt is now behind" .-> behind["behind"]
    behind -- "alarm: rebase onto the head in a fresh attempt" --> checking
    behind -- "conflict: paths to the history" --> retry["POST /attempts/a/retry: the agent starts from the head"]
    retry --> working
    head -- "POST /release {node?}" --> release["release pointer: a deploy follows it, an older node is a rollback"]
```

### What runs where

```mermaid
sequenceDiagram
    participant A as Agent
    participant T as TreeObject (one per tree)
    participant R as Artifacts (one repo per attempt)
    participant S as Sandbox (internet off)
    participant E as Egress (holds the tokens)

    A->>T: start an attempt
    T->>R: fork the head's repo
    T-->>A: remote + write token
    A->>R: push commits
    A->>T: submit
    T->>R: revoke the attempt's tokens, read its head
    T->>S: score {remote, base, head, task checks}
    S->>E: git clone (read token added here)
    E->>R: authorized fetch
    Note over S: restore locked files from base,<br/>root checks, task checks, diff cost + touched paths
    S-->>T: ScoreReport
    T->>T: accept: cheapest passing attempt is the new head
    T->>R: fork the head for each attempt left behind
    T->>S: rebase {from (read), onto (write), heads}
    S->>E: fetch the old commits, rebase onto head, push
    E->>R: each repo with its own token
    S-->>T: commit, or 422 on conflict
    T->>T: checking on the head, or left for its agent to retry
```

## Develop

Needs [nix](https://nixos.org) + [devenv](https://devenv.sh).

```sh
direnv allow          # or: devenv shell
just infra-check      # typecheck, lint, tests
just dev              # the whole stack on localhost (alchemy dev, containers via Docker)
```

## Layout

Everything is in `infra/`:

- `src/core` — the domain (the tree, scoring rules, progress, browsing, diffs), pure and tested on bun
- `src/tree` — the tree Worker: one `TreeObject` Durable Object per tree, reading through Artifacts
- `src/scorer` — `ficus-scorer`, the CLI the sandbox runs (clone, fetch, checks, rebase)
- `src/sandbox` — the scoring and workspace containers, and the `Egress` that is their only way out
- `src/api`, `src/agents`, `src/web` — the public Api, the agents, the web UI

## Web UI

`infra/src/web` is a [vinext](https://github.com/cloudflare/vinext) app (Cloudflare's Vite
reimplementation of the Next.js API) on Workers, styled with [Kumo](https://kumo-ui.com) (Cloudflare's
design system), deployed as its own alchemy stack (`web.run.ts`)
next to the Api it talks to over a service binding. Sign in, init trees, write tasks, start agents on
them or work an attempt yourself, watch each attempt's agent and checks live, read its diff, and accept
the best one, with the reason shown; read any attempt's or node's repo (history, directories, files)
through Artifacts. An init shows each step live as the tree streams it (`Accept: application/x-ndjson`
on the Api gives agents the same), and afterwards a "What happened" panel replays its Cloudflare trace,
one trace from the UI through the Api to the tree's Durable Object and Artifacts. Every pull request's
preview comment links it.

## Infra and lint

- `infra/` deploys with [alchemy](https://alchemy.run) (`just deploy`) and is Effect throughout.
- `just infra-check`: typecheck, then oxlint with `@effect/tsgo`'s type-aware rules and the
  vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules (generic + Effect).
- `just clef-review`: asks Cloudflare's [Clef](https://blog.cloudflare.com/clef-decision-models/)
  decision model the judgement calls a linter cannot make (restating comments, swallowed
  failures, unparsed boundaries, tests that cannot fail) about changed TypeScript.

Credentials go in `~/.config/ficus/.env` (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).

## CI/CD

- Every push to the `main` mirror (and any pull request): `ci.yml` (infra typecheck, lint, tests;
  actionlint and zizmor on the workflows).
- Deploys follow [alchemy's CI guide](https://alchemy.run/guides/ci/): a pull request, if any, gets its own
  `pr-<n>` stage (Api and web UI, with a comment linking both, and end-to-end smoke tests of each),
  destroyed when it closes. `prod` is not deployed from GitHub: releasing a node on Ficus's own tree
  runs its `[deploy]`.
- Credentials are code: `cd infra && bun run deploy:bootstrap` (once, with a Cloudflare credential that
  can create API tokens and a GitHub token with admin on the repo) mints a scoped CI token and writes
  the repository secrets. Until it has run, deploys skip.

## Self-hosting

Ficus hosts itself: the source of truth is the prod tree `ficus` in organization `ficus`. A change is an
attempt made with `scripts/attempt` (`task`, `start`, `submit`, `accept`, `mirror`), not a GitHub pull
request. GitHub `main` is a fast-forward-only mirror (a ruleset blocks force pushes and deletion), kept for
the public source link and a second run of `ci.yml`. Write a task's intent as the change itself: the Clef
judge sees only the task and the diff.

[docs/self-hosting.md](docs/self-hosting.md): what it takes for Ficus to host Ficus instead of GitHub,
and the order to get there.

## License

MIT
