/**
 * `ficus-scorer` (static musl) built into the container image's context.
 * Both container classes read its hash into their env, which is the edge
 * that builds the binary before either image copies it.
 */
import * as Command from "alchemy/Command";

export const ScorerBinary = Command.Build("ScorerBinary", {
  cwd: "..",
  command: "scripts/build-scorer",
  outdir: "infra/src/sandbox/context",
  memo: {
    include: [
      "crates/ficus-scorer/**",
      "crates/ficus-core/**",
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "scripts/build-scorer",
    ],
    lockfile: false,
  },
});
