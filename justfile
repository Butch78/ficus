default:
    @just --list

# Run the main Worker locally (rebuilds on change)
dev:
    wrangler dev

# Build the main Worker (wasm32-unknown-unknown)
build:
    cd crates/ficus-worker && worker-build --release

# Run the git engine Worker locally (wasm32-unknown-emscripten, experimental)
git-dev:
    cd crates/ficus-git && wrangler dev

# Build the git engine Worker. First run downloads worker-build's pinned emsdk.
git-build:
    cd crates/ficus-git && worker-build --emscripten --release

# Native tests (ficus-core and anything host-testable)
test:
    cargo nextest run --workspace --exclude ficus-worker --no-tests=warn

# Format + lint, all three targets
fl:
    cargo fmt --all
    cargo fmt --manifest-path crates/ficus-git/Cargo.toml
    cargo clippy --workspace --exclude ficus-worker --all-targets -- -D warnings
    cargo clippy -p ficus-worker --target wasm32-unknown-unknown -- -D warnings
    cargo clippy --manifest-path crates/ficus-git/Cargo.toml --target wasm32-unknown-emscripten -- -D warnings

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

# Deploy the main Worker through alchemy (STAGE defaults to dev)
deploy:
    cd infra && bun run deploy

# Deploy the emscripten git engine Worker
git-deploy:
    cd crates/ficus-git && wrangler deploy
