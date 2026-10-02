# Ficus on Ficus: replacing GitHub for this repo

Status: design note, 2026-10-02. Nothing here is built yet; the gaps at the end are the follow-ups.

Today GitHub hosts Ficus: the source of truth (`Butch78/ficus`), pull requests and review, Actions
(`ci.yml`; `deploy.yml` with a `pr-<n>` stage per pull request), secrets, issues, and the preview
comment. This note covers what it takes for Ficus to host itself instead, and the order to get there
without a flag day.

## The mapping

Ficus does not have branches and pull requests. It has a tree, and that changes some of the mapping.

| GitHub                         | Ficus today                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| repository, `main`             | a tree `ficus` in organization `ficus`; the head node is `main`             |
| issue (actionable)             | a bud: an intent, with no diff yet                                          |
| branch + pull request          | a leaf: its own Artifacts repo, forked from the head, with a write token    |
| required checks                | the root's `ficus.toml`, run in a sandbox on `ripe`; the leaf cannot edit it |
| merge                          | harvest: the cheapest leaf that passes becomes fruit, the new head          |
| merge conflict, rebase         | regrow: a stale leaf starts again from the new head, with the compost       |
| closed, unmerged pull requests | compost: who tried, why it lost, how it scored                              |
| PR page, checks tab            | the web UI's leaf page: state, scoring report, repo browser                 |

Two consequences shape the plan:

- **No merge, so no merge queue.** "Merge when green" is harvest, and it is already serialized per
  tree by `TreeObject`. Conflicts become regrows, so a busy repo leans on regrow working well.
- **Harvest picks, people approve.** Harvest takes the cheapest passing leaf. For agent swarms that
  is the point. For a project people maintain, someone has to say yes first, and nothing in
  `ficus-core::tree` models that yet.

## What works today

- Plant from GitHub: `POST /trees/<t>/plant {source: "https://github.com/Butch78/ficus"}` imports
  the repo through Artifacts.
- Leaves over plain git (`http.extraHeader` bearer token), scoring with the root's own checks in
  containers with the internet off, cost-ranked harvest, regrow, compost.
- Accounts, organizations, and API keys (Better Auth), one tenant per organization.
- The web UI (`infra/src/web`): sign in, organizations and trees, buds → leaves → fruit, each leaf's
  state and report, and browsing any leaf's or node's repo (history, directories, files) through
  Artifacts' read methods.
- A `pr-<n>` stage per pull request, Api and UI, with an end-to-end smoke test of each.

## What is missing

Roughly in the order they block self-hosting:

1. **Checks for this repo.** There is no `ficus.toml` at the root. Its checks are `just fl`,
   `just test`, and `just infra-check`, and they need crates.io, the npm registry, and the
   devenv/nix caches. Egress only lets the prepare phase reach the leaf repo and the nix caches, so
   cargo and bun cannot fetch anything. A cold devenv for this repo is also far heavier than the
   demo root's, so `standard-1` and the scorer's timeouts need measuring.
2. **A stable trunk remote.** Each harvest makes the fruit leaf's repo the new head, so `main`'s
   clone URL changes on every harvest. The Artifacts binding has no ref-update or push method, so
   keeping one trunk repo fast-forwarded means a sandbox pushing to it (with a token Egress adds) on
   harvest.
3. **Following an outside `main`.** A tree is planted once. While GitHub stays the source of truth,
   its `main` moves without a harvest. Ficus needs a graft: import an outside commit as a new head
   node, marking open leaves stale like a harvest would.
4. **Review.** The UI can show a leaf, but there is no diff of a leaf against its base (Artifacts
   has no diff method; the scorer already computes the diff to cost it and could ship it, truncated,
   in the report). There are no comments, and no approval gate on harvest. Org roles exist in Better
   Auth (owner, admin, member), but the Api does not check them, so any member can harvest.
5. **Acting from the UI and from a CLI.** The UI only plants trees and creates organizations.
   Sprouting a leaf, submitting it, harvesting, and regrowing all need the API with an API key.
   People need buttons, and a `ficus` CLI (`sprout`, `push`, `ripe`) that wraps the curl and git
   steps `scripts/e2e` does by hand.
6. **CI on push.** Scoring runs on `ripe`, which freezes the leaf. That suits agents, but people
   expect feedback while they are still working. Two parts: an event when a leaf repo is pushed
   (the Artifacts binding exposes no push notification, so polling `log` is the stopgap), and a preview
   score that does not freeze the leaf.
7. **Events and webhooks.** `TreeObject` changes state silently. Every integration below needs a
   stream of leaf-ripened, harvested, and regrown events, delivered from a Queue as HMAC-signed
   webhooks.
8. **Deploys.** `deploy.yml` deploys `pr-<n>` and `prod` from GitHub. On Ficus that becomes a
   per-leaf preview stage after scoring and `prod` after harvest: a deploy phase in `ficus.toml`,
   run in a sandbox, with the Cloudflare token added by Egress so it never enters the container.
   Secrets need a per-tree home (Secrets Store), replacing repository secrets.
9. **Mirror to and from GitHub during the transition.**
   - Ficus → GitHub: after each harvest, push the head to GitHub `main` (from a sandbox, token added
     by Egress). Branch protection then allows only the mirror to push.
   - GitHub → Ficus: a GitHub App turns each pull request into a leaf (import the PR's head, sprout,
     submit) and reports the score back as a check run. Outside contributors keep using GitHub, and
     maintainers see Ficus's verdict there.
10. **Issues.** A bud is an actionable intent. An issue is also a bug report, a question, or a
    discussion. Buds need listing and creation in the UI, comments, and labels before issues move.
    Until then issues stay on GitHub.
11. **Durability.** Tree state lives in one Durable Object's storage, and code in Artifacts. There is
    no export of a tree's history (buds, compost, reports). The tree directory in D1 (added with the
    UI) only lists trees planted after it shipped.

## The path

Each step is useful on its own and can be reverted without losing work.

1. **Shadow checks** (gaps 1, 3). Add `ficus.toml` and the Egress allowances. Plant a `ficus` tree
   and graft GitHub `main` into it on every push. Exit criterion: on ten consecutive pull requests,
   a leaf's score agrees with `ci.yml`.
2. **Shadow review** (gaps 9 inbound, 7, 6). The GitHub App mirrors every pull request into a leaf
   and posts the score as a check run, required but not yet sole. Events start here, because the
   App needs them.
3. **Review in Ficus** (gaps 4, 5). Diffs, comments, an approval gate on harvest that checks Better
   Auth roles, and leaf actions in the UI and CLI. Maintainers review on the leaf page and keep
   merging on GitHub.
4. **Flip** (gaps 2, 9 outbound, 8). Harvest becomes the merge. The mirror pushes the head to GitHub
   `main`, and branch protection admits only the mirror. Post-harvest deploys replace `deploy.yml`'s
   `prod` job, and per-leaf preview stages replace `pr-<n>`. The trunk remote is the clone URL in the
   README.
5. **Issues** (gap 10). Move open issues to buds once buds have comments, and close GitHub issues
   to new reports.
6. **GitHub as a mirror only** (gap 11). With tree export and backups in place, the GitHub repo is a
   read-only mirror plus the inbound bridge for outside contributors. Turning that off is a separate
   decision.

## Follow-ups

One per gap above, so each can be picked up alone:

- [ ] `ficus.toml` for this repo, Egress prepare-phase allowances for crates.io, npm, and the devenv
      caches, and measured scorer timeouts and instance type.
- [ ] Trunk repo: fast-forward a stable Artifacts repo per tree on harvest, from a sandbox.
- [ ] `POST /trees/<t>/graft {source, branch}`: import an outside commit as the new head node.
- [ ] Leaf diff in the scoring report (truncated), rendered on the leaf page.
- [ ] Comments on leaves and buds; approval-gated harvest that checks Better Auth org roles in the Api.
- [ ] UI actions (bud, sprout, ripe, harvest, regrow, wither) and a `ficus` CLI.
- [ ] Push detection for leaf repos (poll `log` until Artifacts has events) and non-freezing preview scores.
- [ ] Tree events to a Queue; signed webhook deliveries with retries.
- [ ] Deploy phase in `ficus.toml`; per-tree secrets; per-leaf preview stages.
- [ ] GitHub mirror out (head → `main` on harvest) and GitHub App in (pull request → leaf → check run).
- [ ] Buds in the UI, with comments and labels; an issue → bud importer.
- [ ] Tree export (JSON of nodes, buds, leaves, compost, reports) and backfill of the D1 tree directory.
