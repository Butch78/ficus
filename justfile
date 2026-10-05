default:
    @just --list

# The whole stack on localhost (alchemy dev, stage `local`), containers via local Docker
dev:
    cd infra && bun run dev

# Typecheck + lint (effect-tsgo, anti-slop) + test infra/
infra-check:
    cd infra && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run test

# Ask Clef the judgement-call anti-slop questions about changed infra/ TypeScript
clef-review base="HEAD":
    #!/usr/bin/env bash
    set -euo pipefail
    cd infra
    files=$(git diff --name-only --diff-filter=d --relative "{{base}}" -- '*.ts' | grep -v '^tools/' || true)
    if [ -z "$files" ]; then echo "no changed .ts files"; exit 0; fi
    bun run clef-review $files

# Deploy the Ficus stack through alchemy (STAGE defaults to dev)
deploy:
    cd infra && bun run deploy

# Run the full tree cycle through a deployed Api (FICUS_API: its URL)
e2e:
    scripts/e2e

# The web UI's end-to-end through a deployed stage (FICUS_WEB, FICUS_API: their URLs)
e2e-web:
    scripts/e2e-web

# Agents end to end on a deployed stage (FICUS_API; opt-in: spends Workers AI, takes minutes)
e2e-agents:
    scripts/e2e-agents

# Deploy the web UI stack (after `just deploy`, same STAGE)
deploy-web:
    cd infra && bun run deploy:web
