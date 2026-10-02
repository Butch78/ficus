# The scorer: ficus-scorer (static musl, copied in by the build) on an image
# with nix and devenv, so any root's `devenv shell` builds here.
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

ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ficus-scorer"]
