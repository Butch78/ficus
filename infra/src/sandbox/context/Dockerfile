# The sandbox image for `alchemy dev`: the pinned base (infra/src/sandbox/base,
# scripts/build-sandbox-base keeps this line in step with base-image) and
# Ficus's files: the same layer scripts/sandbox-image appends without Docker
# on every other stage. Pulling the base needs `docker login registry.cloudflare.com`.
FROM registry.cloudflare.com/fbf58b6d00f3fde29392c6032df6c42d/ficus-sandbox-base@sha256:7622cac3a000d21124032a9b5934478ba97b2dda1bca7f344a2f41436e9b728d

COPY ficus-scorer.js /usr/local/lib/ficus-scorer.js
COPY ficus-scorer /usr/local/bin/ficus-scorer
COPY entrypoint.sh /usr/local/bin/ficus-entrypoint
COPY trust-egress.sh /usr/local/bin/ficus-trust-egress
