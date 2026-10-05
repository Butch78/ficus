# The sandbox container image, built by nix instead of Docker, so a sandbox
# (which has nix and no Docker daemon) can build it for Ficus's own deploy.
# The same image infra/src/sandbox/context/Dockerfile describes for `alchemy
# dev`: nix as root with its database, devenv, bun, and the ficus-scorer
# tools in /usr/local/bin. Its layout follows nix's own docker.nix (the
# nixos/nix image).
#
#   scripts/build-sandbox-image     builds it (after scripts/build-scorer)
{
  pkgs,
  # infra/src/sandbox/context: the scorer bundle and the shell tools.
  context,
  tag ? "latest",
}:
let
  inherit (pkgs) lib;

  # Containers have no user namespaces for nix's sandbox and no nixbld
  # users; flakes for devenv; the devenv cache so a root's shell is mostly
  # downloads, not builds.
  nixConf = pkgs.writeText "nix.conf" ''
    experimental-features = nix-command flakes
    sandbox = false
    build-users-group =
    accept-flake-config = true
    substituters = https://cache.nixos.org/
    trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=
    extra-substituters = https://devenv.cachix.org
    extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=
  '';

  # ficus-scorer (bundled by scripts/build-scorer, run by bun) and the
  # entrypoint and egress-CA scripts.
  tools = pkgs.runCommand "ficus-sandbox-tools" { } ''
    mkdir -p $out/bin $out/lib
    cp ${context}/ficus-scorer.js $out/lib/ficus-scorer.js
    install -m 0755 ${context}/entrypoint.sh $out/bin/ficus-entrypoint
    install -m 0755 ${context}/trust-egress.sh $out/bin/ficus-trust-egress
    cat > $out/bin/ficus-scorer <<EOF
    #!/bin/sh
    exec ${pkgs.bun}/bin/bun $out/lib/ficus-scorer.js "\$@"
    EOF
    chmod 0755 $out/bin/ficus-scorer
  '';

  packages = with pkgs; [
    nix
    bashInteractive
    coreutils-full
    findutils
    gnugrep
    gnused
    gnutar
    gzip
    which
    curl
    gitMinimal
    cacert.out
    iana-etc
    devenv
    bun
  ];

  profile = pkgs.buildEnv {
    name = "ficus-sandbox-profile";
    paths = packages;
  };

  root = pkgs.runCommand "ficus-sandbox-root" { } ''
    mkdir -p $out/etc/nix $out/etc/ssl/certs $out/usr/local/bin $out/usr/bin $out/bin \
      $out/root $out/nix/var/nix/profiles/per-user/root $out/work $out/run

    cat > $out/etc/passwd <<EOF
    root:x:0:0:System administrator:/root:${pkgs.bashInteractive}/bin/bash
    nobody:x:65534:65534:Unprivileged account:/var/empty:/bin/false
    EOF
    cat > $out/etc/group <<EOF
    root:x:0:
    nogroup:x:65534:
    EOF
    echo 'root:!x:::::::' > $out/etc/shadow
    cp ${nixConf} $out/etc/nix/nix.conf

    # The image's CA bundle; ficus-trust-egress replaces it with one that
    # also trusts the egress CA, from the profile's original.
    ln -s /nix/var/nix/profiles/default/etc/ssl/certs/ca-bundle.crt $out/etc/ssl/certs/ca-bundle.crt
    ln -s /nix/var/nix/profiles/default/etc/ssl/certs/ca-bundle.crt $out/etc/ssl/certs/ca-certificates.crt

    ln -s ${profile} $out/nix/var/nix/profiles/default-1-link
    ln -s /nix/var/nix/profiles/default-1-link $out/nix/var/nix/profiles/default
    ln -s /nix/var/nix/profiles/default $out/root/.nix-profile

    for tool in ficus-scorer ficus-trust-egress ficus-entrypoint; do
      ln -s ${tools}/bin/$tool $out/usr/local/bin/$tool
    done

    ln -s ${pkgs.bashInteractive}/bin/bash $out/bin/sh
    ln -s ${pkgs.coreutils-full}/bin/env $out/usr/bin/env
  '';
in
pkgs.dockerTools.buildLayeredImageWithNixDb {
  name = "ficus-sandbox";
  inherit tag;
  contents = [ root ];
  # /tmp for nix and devenv, world-writable as on any system.
  extraCommands = ''
    mkdir -p tmp var/tmp
    chmod 1777 tmp var/tmp
  '';
  maxLayers = 70;
  config = {
    Entrypoint = [ "/usr/local/bin/ficus-entrypoint" ];
    WorkingDir = "/";
    Env = [
      "PATH=/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin"
      "HOME=/root"
      "USER=root"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=/etc/ssl/certs/ca-bundle.crt"
    ];
  };
}
