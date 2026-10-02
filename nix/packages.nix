# Tools nixpkgs does not carry at the version Ficus needs.
{ pkgs }:

{
  # nixpkgs has 0.8.5; `--emscripten` (crates/ficus-git) landed in 0.8.7.
  # worker-build provisions its own pinned, patched emsdk into its cache on
  # first use, so emscripten itself is deliberately NOT a nix package here —
  # nixpkgs' emcc would be unpatched and the wrong version.
  worker-build = pkgs.rustPlatform.buildRustPackage rec {
    pname = "worker-build";
    version = "0.8.7";
    src = pkgs.fetchCrate {
      inherit pname version;
      hash = "sha256-xeIjka/SfDC8KVkzQRTqt/HT6B4heAYH94jCZ4aEdeQ=";
    };
    cargoHash = "sha256-o0WqkB2ey36wH26RSnCLWCX4uToKYGme+Y69JdOttrM=";
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = [ pkgs.openssl ];
    doCheck = false;
  };
}
