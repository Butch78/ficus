# Ficus dev shell: a checkout plus nix runs every recipe in the justfile.
#
# Rust comes from rust-toolchain.toml (the one source of the version), via
# rust-overlay. Everything else a recipe shells out to is declared below.
{ pkgs, lib, config, ... }:

let
  ficus = import ./nix/packages.nix { inherit pkgs; };
in

{
  languages.rust = {
    enable = true;
    toolchainFile = ./rust-toolchain.toml;

    # Both default ON on Linux and both act through env vars that outrank
    # .cargo/config.toml — mold via RUSTFLAGS, which would also reach the
    # wasm32 target and replace its `[target.wasm32-unknown-unknown]` flags.
    mold.enable = false;
    clangLinker.enable = false;
  };

  packages = with pkgs; [
    just
    cargo-nextest

    # The Worker: worker-build compiles crates/ficus-worker to wasm and emits
    # build/worker/shim.mjs; wrangler runs it locally and deploys it.
    ficus.worker-build
    wasm-bindgen-cli
    binaryen
    wrangler
    nodejs

    # Must match the box's shared sccache server (0.17.0), or the client
    # starts a rival server instead of attaching to the warm cache.
    sccache

    # infra/: alchemy stacks, Effect, oxlint.
    ficus.bun

    git
    jq
    curl
  ];

  # Filtered rather than defaulted to "": Effect's Config treats an empty
  # string as a value, so a missing token must stay absent.
  env = lib.filterAttrs (_: v: v != null) {
    CLOUDFLARE_ACCOUNT_ID = config.secretspec.secrets.CLOUDFLARE_ACCOUNT_ID or null;
    CLOUDFLARE_API_TOKEN = config.secretspec.secrets.CLOUDFLARE_API_TOKEN or null;
  };

  enterTest = ''
    cargo --version
    worker-build --version
    wrangler --version
    bun --version
  '';
}
