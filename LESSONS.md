# Lessons

Mistakes Ficus has made, newest first. Built-in agents read this with their task and the `[[judge]]`
questions read it with the diff (read at the attempt's base, so an attempt cannot change what its own
judges see). Keep each lesson to a line or two.

- 2026-10-13: run the FULL checks (`just infra-check`: typecheck, lint, tests) before a release, never
  part of them: a release whose last fixes were only typechecked failed lint in Ficus's own scoring.
- 2026-10-13: test any sandbox, container or Durable Object change with `just e2e-upgrade <stage>` (prod's
  released commit, then the change), not only on a fresh stage: those failures showed only on the upgrade path.
- 2026-10-13: Durable Object-managed containers: the env given to `start` does not reach the entrypoint.
- 2026-10-13: a container cannot switch scheduling policy in place: use a new class and container id, and
  deploy the deployer stack first.
- 2026-10-13: a new Durable Object class with its container needs two deploy runs (the first fails at precreate).
- 2026-10-13: Cloudflare's image preparation fails `nixos/nix`-based images, nix-built ones included: base on Debian.
- 2026-10-13: `snapshotContainer` did not answer on Durable Object-managed containers: snapshot warming stays off.
- 2026-10-13: a Durable Object whose first container start failed can fail every later start: use a fresh one per run.
- 2026-10-13: destroying a stage deletes files in `infra/src/sandbox/context`: restore them from git after.
- 2026-10-13: a new `ficus.toml` key ships one release after the scorer learns it: releases deploy with the
  previous release's scorer, which parses `ficus.toml` strictly.
