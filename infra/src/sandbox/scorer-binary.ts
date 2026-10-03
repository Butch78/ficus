/**
 * `ficus-scorer` (src/scorer, bundled for bun by scripts/build-scorer) built
 * into the container image's context. Both container classes read its hash
 * into their image context, which is the edge that builds the bundle before
 * either image copies it.
 */
import * as Command from "alchemy/Command";

export const ScorerBinary = Command.Build("ScorerBinary", {
  cwd: "..",
  command: "scripts/build-scorer",
  outdir: "infra/src/sandbox/context",
  memo: {
    include: ["infra/src/scorer/**", "infra/src/core/**", "infra/package.json", "infra/bun.lock", "scripts/build-scorer"],
    lockfile: false,
  },
});
