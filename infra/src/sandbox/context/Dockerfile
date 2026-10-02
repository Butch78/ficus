# The sandbox: nix + devenv (so any root's `devenv shell` builds here) and
# ficus-scorer (static musl, copied in by scripts/build-scorer). Work arrives
# through the platform's exec; see entrypoint.sh.
FROM nixos/nix:2.35.2

# Containers have no user namespaces for nix's sandbox; flakes for devenv;
# the devenv cache so a root's shell is mostly downloads, not builds.
RUN mkdir -p /etc/nix && printf '%s\n' \
      'experimental-features = nix-command flakes' \
      'sandbox = false' \
      'accept-flake-config = true' \
      'extra-substituters = https://devenv.cachix.org' \
      'extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=' \
      >> /etc/nix/nix.conf

RUN nix profile add nixpkgs#devenv \
 && nix-collect-garbage -d \
 && devenv version

COPY ficus-scorer /usr/local/bin/ficus-scorer
COPY entrypoint.sh /usr/local/bin/ficus-entrypoint
COPY trust-egress.sh /usr/local/bin/ficus-trust-egress

# nix, git and curl all read this bundle; ficus-trust-egress adds the egress CA.
# src/sandbox/sandbox.ts passes the same environment to every exec.
ENV PATH=/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt

ENTRYPOINT ["/usr/local/bin/ficus-entrypoint"]
