# Ficus dev shell: a checkout plus nix runs every recipe in the justfile.
# Everything is TypeScript under infra/, run by bun; the rest is tooling a
# recipe shells out to.
{ pkgs, lib, config, ... }:

let
  ficus = import ./nix/packages.nix { inherit pkgs; };
in

{
  packages = with pkgs; [
    just

    # infra/: alchemy stacks, Effect, oxlint, the scorer.
    ficus.bun
    nodejs

    # .github/: actionlint for syntax and shell, zizmor for the security audit.
    actionlint
    zizmor

    git
    jq
    curl
  ];

  # Filtered rather than defaulted to "": Effect's Config treats an empty
  # string as a value, so a missing token must stay absent.
  env = lib.filterAttrs (_: v: v != null) {
    CLOUDFLARE_ACCOUNT_ID = config.secretspec.secrets.CLOUDFLARE_ACCOUNT_ID or null;
    CLOUDFLARE_API_TOKEN = config.secretspec.secrets.CLOUDFLARE_API_TOKEN or null;
    FICUS_OBSERVABILITY_TOKEN = config.secretspec.secrets.FICUS_OBSERVABILITY_TOKEN or null;
  };

  enterTest = ''
    bun --version
  '';
}
