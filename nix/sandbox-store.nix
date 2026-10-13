# What the sandbox image keeps in its nix store, from what devenv.lock pins:
# devenv (built from the devenv source the lock pins, so the image runs the
# devenv its shells were locked with; `devenv update` moves both) and bun for
# its profile, Ficus's own devenv shell's inputs, and
# every input devenv.lock pins (devenv's source, the patched nixpkgs and the
# nixpkgs it is built from), which devenv fetches before it evaluates. So
# scoring an attempt at Ficus downloads next to nothing before its checks run. mkShell's inputDerivation
# references every input with the outputs (dev, man) and the stdenv a shell
# builds against. Keep the list in step with devenv.nix `packages`.
#
# Built into the image by infra/src/sandbox/base/Dockerfile.
{ pkgs, lock }:
let
  lockfile = builtins.fromJSON (builtins.readFile lock);
  devenvSource = lockfile.nodes.devenv.locked;
  devenv = (builtins.getFlake "github:${devenvSource.owner}/${devenvSource.repo}/${devenvSource.rev}").packages.${pkgs.system}.devenv;
  # Every locked input of devenv.lock, fetched as devenv would (by narHash).
  locked = builtins.filter (node: node ? locked) (builtins.attrValues lockfile.nodes);
  # `dir` names a subdirectory of the fetched tree: fetchTree takes the whole source.
  inputs = map (node: builtins.fetchTree (removeAttrs node.locked [ "dir" ])) locked;
  ficus = import ./packages.nix { inherit pkgs; };
  devenvInputs =
    (pkgs.mkShell {
      packages = with pkgs; [
        just
        ficus.bun
        nodejs
        actionlint
        zizmor
        git
        jq
        curl
        crane
        gnutar
      ];
    }).inputDerivation;
in
pkgs.runCommand "ficus-sandbox-store" { } ''
  mkdir -p $out/bin $out/share/ficus
  ln -s ${devenv}/bin/devenv $out/bin/devenv
  ln -s ${ficus.bun}/bin/bun $out/bin/bun
  # Never read: they keep the shell's inputs and its nixpkgs in the store.
  ln -s ${devenvInputs} $out/share/ficus/devenv-inputs
  ln -s ${builtins.storePath (toString pkgs.path)} $out/share/ficus/nixpkgs
  ${pkgs.lib.concatImapStringsSep "\n" (i: input: "ln -s ${input.outPath} $out/share/ficus/input-${toString i}") inputs}
''
