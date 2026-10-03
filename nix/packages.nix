# Tools nixpkgs does not carry at the version Ficus needs.
{ pkgs }:

{
  # infra/ (alchemy, Effect, oxlint). infra/package.json's `packageManager`
  # names the same version; the hash is the one expanse pins for 1.4.2.
  bun = pkgs.bun.overrideAttrs (old: rec {
    version = "1.4.2";
    src = pkgs.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-x64.zip";
      hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM=";
    };
  });
}
