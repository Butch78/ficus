# Ficus on Ficus: replacing GitHub for this repo

Status: design note, 2026-10-02. Nothing here is built yet; the gaps at the end are the follow-ups.

Today GitHub hosts Ficus: the source of truth (`Butch78/ficus`), pull requests and review, Actions
(`ci.yml`; `deploy.yml` with a `pr-<n>` stage per pull request), secrets, issues, and the preview
comment. This note covers what it takes for Ficus to host itself instead, and the order to get there
without a flag day.

## The mapping

Ficus does not have branches and pull requests. It has a tree, and that changes some of the mapping.

| GitHub                         | Ficus today                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------- |
| repository, `main`             | a tree `ficus` in organization `ficus`; the head node is `main`                   |
| issue (actionable)             | a task: an intent, with checks of its own if it needs them, and no diff yet       |
| branch + pull request          | an attempt: its own Artifacts repo, forked from the head, with a write token      |
| required checks                | the root's `ficus.toml` (and the task's checks), run in a sandbox on `submit`     |
| merge                          | accept: the cheapest attempt that passes every check becomes the new head        |
| rebase                         | rebase: the tree replays a behind attempt onto the new head, without its agent    |
| merge conflict                 | retry: an attempt whose rebase conflicts starts again from the head, with history |
| closed, unmerged pull requests | history: who tried, why it closed, how it scored                                  |
| PR page, checks tab            | the web UI's attempt page: state, scoring report and steps, diff, repo browser    |
| deployment                     | release: a pointer at a node; pointing it back is a rollback                      |

Two consequences shape the plan:

- **No merge, so no merge queue.** "Merge when green" is accept, and it is already serialized per
  tree by `TreeObject`. Every other submitted attempt is then behind: the tree rebases it onto the
  new head and scores it again, and only a conflict goes back to its agent to retry. A busy repo
  leans on rebases applying cleanly.
- **Accept picks, people approve.** Accept takes the cheapest passing attempt. For agent swarms that
  is the point. For a project people maintain, someone has to say yes first, and nothing in
  `infra/src/core/tree.ts` models that yet.

## What works today

- Init from GitHub: `POST /trees/<t>/init {source: "https://github.com/Butch78/ficus"}` imports
  the repo through Artifacts.
- Attempts over plain git (`http.extraHeader` bearer token), scoring with the root's own checks and
  the task's in containers with the internet off, judges asked of Clef, cost-ranked accept, automatic
  rebase of behind attempts, retry, history, and a release pointer.
- Accounts, organizations, and API keys (Better Auth), one tenant per organization.
- The web UI (`infra/src/web`): init, write tasks, start agents on them (pi on Workers AI, each in
  its own sandbox) or work an attempt by hand, watch each task live (agents' tool calls, scoring steps
  as they run),
  review an attempt's diff, accept with the reason shown, retry and abandon; browse any attempt's or node's
  repo through Artifacts; replay any change's Cloudflare trace.
- A `pr-<n>` stage per pull request, Api and UI, with an end-to-end smoke test of each.

## What is missing

Roughly in the order they block self-hosting:

1. **Checks for this repo.** *(Started: `ficus.toml` and `[fetch]` exist; timings are being measured.)*
   There was no `ficus.toml` at the root. Its checks are ci.yml's: `bun run typecheck`, `lint` and
   `test` in `infra/`, plus actionlint and zizmor. They need the npm registry and the devenv/nix
   caches; `[fetch]` opens the registry while `bun install` runs. With Rust gone (ported to Effect),
   the devenv is far lighter than when it filled `standard-1`'s disk; the instance type and the
   scorer's timeouts still need measuring.
2. **A stable trunk remote.** Each accept makes the accepted attempt's repo the new head, so `main`'s
   clone URL changes on every accept. The Artifacts binding has no ref-update or push method, so
   keeping one trunk repo fast-forwarded means a sandbox pushing to it (with a token Egress adds) on
   accept.
3. **Following an outside `main`.** *(Done: `POST /trees/<t>/graft`, and `graft.yml`.)* A tree is initialized once. While GitHub stays the source of truth,
   its `main` moves without an acceptance. Ficus needs a graft: import an outside commit as a new
   head node, leaving open attempts behind (and so rebased) as an acceptance does.
4. **Review.** Attempt and node diffs, the case for accepting and every attempt's standing are in the UI
   now. There are no comments, and no approval gate on accept. Org roles exist in Better Auth
   (owner, admin, member), but the Api does not check them, so any member can accept.
5. **A CLI.** Every action is in the UI now (task, agents or an attempt by hand, submit, accept,
   retry, abandon). People who live in a terminal need a `ficus` CLI (`start`, `push`, `submit`)
   that wraps the curl and git steps `scripts/e2e` does by hand.
6. **CI on push.** Scoring runs on `submit`, which freezes the attempt. That suits agents, but people
   expect feedback while they are still working. Two parts: an event when an attempt repo is pushed
   (the Artifacts binding exposes no push notification, so polling `log` is the stopgap), and a preview
   score that does not freeze the attempt.
7. **Events and webhooks.** `TreeObject` changes state silently. Every integration below needs a
   stream of attempt-scored, accepted, rebased, and retried events, delivered from a Queue as HMAC-signed
   webhooks.
8. **Deploys.** *(Started: `[deploy]` and the `Deploy` Workflow.)* `deploy.yml` deploys `pr-<n>` and
   `prod` from GitHub. On Ficus, moving the release pointer (`POST /trees/<t>/release`) starts a
   Cloudflare Workflow that runs the released commit's `[deploy]` in a sandbox, with the Cloudflare
   token added by Egress so it never enters the container. Still missing: Ficus's own `[deploy]`
   (its sandbox image needs Docker to build, so it must be built and pushed to Cloudflare's registry
   apart from the deploy), per-attempt preview stages, and a per-tree home for secrets (Secrets
   Store) to replace repository secrets.
9. **Mirror to and from GitHub during the transition.**
   - Ficus → GitHub: after each accept, push the head to GitHub `main` (from a sandbox, token added
     by Egress). Branch protection then allows only the mirror to push.
   - GitHub → Ficus: a GitHub App turns each pull request into an attempt (import the PR's head, start,
     submit) and reports the score back as a check run. Outside contributors keep using GitHub, and
     maintainers see Ficus's verdict there.
10. **Issues.** A task is an actionable intent. An issue is also a bug report, a question, or a
    discussion. Tasks need listing and creation in the UI, comments, and labels before issues move.
    Until then issues stay on GitHub.
11. **Durability.** Tree state lives in one Durable Object's storage, and code in Artifacts. There is
    no export of a tree's history (tasks, history, reports). The tree directory in D1 (added with the
    UI) only lists trees initialized after it shipped.

## The path

Each step is useful on its own and can be reverted without losing work.

1. **Shadow checks** (gaps 1, 3). Add `ficus.toml` and the Egress allowances. Init a `ficus` tree
   and graft GitHub `main` into it on every push. Exit criterion: on ten consecutive pull requests,
   an attempt's score agrees with `ci.yml`.
2. **Shadow review** (gaps 9 inbound, 7, 6). The GitHub App mirrors every pull request into an attempt
   and posts the score as a check run, required but not yet sole. Events start here, because the
   App needs them.
3. **Review in Ficus** (gaps 4, 5). Diffs, comments, an approval gate on accept that checks Better
   Auth roles, and attempt actions in the UI and CLI. Maintainers review on the attempt page and keep
   merging on GitHub.
4. **Flip** (gaps 2, 9 outbound, 8). Accept becomes the merge. The mirror pushes the head to GitHub
   `main`, and branch protection admits only the mirror. Post-accept deploys replace `deploy.yml`'s
   `prod` job, and per-attempt preview stages replace `pr-<n>`. The trunk remote is the clone URL in the
   README.
5. **Issues** (gap 10). Move open issues to tasks once tasks have comments, and close GitHub issues
   to new reports.
6. **GitHub as a mirror only** (gap 11). With tree export and backups in place, the GitHub repo is a
   read-only mirror plus the inbound bridge for outside contributors. Turning that off is a separate
   decision.

## Follow-ups

One per gap above, so each can be picked up alone:

- [x] `ficus.toml` for this repo, and `[fetch]`: the root names the hosts its checks need (the
      npm registry), open only while devenv builds and dependencies download.
- [ ] Measured scorer timeouts and instance type for this repo.
- [ ] Trunk repo: fast-forward a stable Artifacts repo per tree on accept, from a sandbox.
- [x] `POST /trees/<t>/graft {source, branch}`: import an outside commit as the new head node;
      `.github/workflows/graft.yml` calls it on every push to `main` once `FICUS_GRAFT_ENABLED` is set.
- [x] Attempt and node diffs, rendered on their pages.
- [ ] Comments on attempts and tasks; approval-gated accept that checks Better Auth org roles in the Api.
- [x] UI actions (task, start agents, start by hand, submit, accept, retry, abandon).
- [ ] A `ficus` CLI.
- [ ] Push detection for attempt repos (poll `log` until Artifacts has events) and non-freezing preview scores.
- [ ] Tree events to a Queue; signed webhook deliveries with retries.
- [x] Deploy phase in `ficus.toml`, run by a Workflow on release (`src/deploys`).
- [ ] Ficus's own `[deploy]`: the sandbox image built without Docker (nix) and pushed to Cloudflare's registry.
- [ ] Per-tree secrets; per-attempt preview stages; deploys in the UI.
- [ ] GitHub mirror out (head → `main` on accept) and GitHub App in (pull request → attempt → check run).
- [ ] Tasks in the UI, with comments and labels; an issue → task importer.
- [ ] Tree export (JSON of nodes, tasks, attempts, history, reports) and backfill of the D1 tree directory.
