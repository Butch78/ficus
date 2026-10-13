# The sandbox's base image: Debian with nix, and devenv and bun from what
# devenv.lock pins (nix/sandbox-store.nix). Small and generic: nothing per repo.
# Built with Docker by scripts/build-sandbox-base, which assembles this
# directory with devenv.lock and nix/, and pinned by digest in
# infra/src/sandbox/base-image; deploys append Ficus's files to it without
# Docker (scripts/sandbox-image, infra/src/sandbox/context).
#
# node:24.20.0-trixie-slim, the source of Cloudflare's managed
# cloudflare/debian-trixie: Cloudflare's Durable Object containers prepare a
# Debian base but fail nixos/nix's minimal one ("runtime image build failed").
FROM node:24.20.0-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl xz-utils ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Single-user nix with no init system (a container has none).
RUN curl -sSfL https://install.determinate.systems/nix | sh -s -- install linux --init none --no-confirm

# Containers have no user namespaces for nix's sandbox; flakes for devenv;
# the devenv cache so a root's shell is mostly downloads, not builds.
RUN printf '%s\n' \
      'experimental-features = nix-command flakes' \
      'sandbox = false' \
      'accept-flake-config = true' \
      'extra-substituters = https://devenv.cachix.org' \
      'extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=' \
      >> /etc/nix/nix.conf

ENV PATH=/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:/usr/sbin:/usr/bin:/sbin:/bin

# devenv and bun, from devenv.lock, into the default profile; nix's CA bundle
# as the one every tool reads,
# which trust-egress.sh extends with the egress CA.
COPY devenv.lock /tmp/sandbox-store/devenv.lock
COPY nix/ /tmp/sandbox-store/nix/
RUN nixpkgs=$(nix eval --raw --impure --expr 'let n = (builtins.fromJSON (builtins.readFile /tmp/sandbox-store/devenv.lock)).nodes.nixpkgs.locked; in "github:${n.owner}/${n.repo}/${n.rev}"') \
 && store=$(nix build --no-link --print-out-paths --impure --expr "import /tmp/sandbox-store/nix/sandbox-store.nix { pkgs = (builtins.getFlake \"$nixpkgs\").legacyPackages.x86_64-linux; lock = /tmp/sandbox-store/devenv.lock; }") \
 && nix profile add --profile /nix/var/nix/profiles/default "$store" \
 && rm -r /tmp/sandbox-store \
 && nix-collect-garbage \
 && cp /nix/var/nix/profiles/default/etc/ssl/certs/ca-bundle.crt /etc/ssl/certs/ca-bundle.crt \
 && devenv version \
 && bun --version

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt

ENTRYPOINT ["/usr/local/bin/ficus-entrypoint"]
