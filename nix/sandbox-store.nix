# What the sandbox image keeps in its nix store, from what devenv.lock pins:
# devenv (built from the devenv source the lock pins, so the image runs the
# devenv its shells were locked with; `devenv update` moves both) and bun, for
# its profile. Nothing per repo: the image stays small and generic (a warmed
# 4.6 GB image lost its container connections on Cloudflare, 2026-10-13), and
# a repo's shell is the scoring's to build.
#
# Built into the image by infra/src/sandbox/base/Dockerfile.
{ pkgs, lock }:
let
  lockfile = builtins.fromJSON (builtins.readFile lock);
  devenvSource = lockfile.nodes.devenv.locked;
  devenv = (builtins.getFlake "github:${devenvSource.owner}/${devenvSource.repo}/${devenvSource.rev}").packages.${pkgs.system}.devenv;
  ficus = import ./packages.nix { inherit pkgs; };
in
pkgs.buildEnv {
  name = "ficus-sandbox-store";
  paths = [
    devenv
    ficus.bun
  ];
}
