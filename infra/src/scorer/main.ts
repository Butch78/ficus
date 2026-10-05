/**
 * `ficus-scorer`, run inside the sandbox container with the platform's
 * `exec` (scripts/build-scorer bundles it; the image runs it under bun).
 * Three scoring phases, because the sandbox changes the network between
 * them, and one rebase command:
 *
 *   ficus-scorer prepare '<AttemptRef JSON>'   network: Artifacts
 *       clones the attempt, restores the root's locked files; prints
 *       {"workdir": "...", "hosts": [...]}: the hosts its `[fetch]` needs
 *   ficus-scorer fetch <workdir>             network: nix caches + those hosts
 *       builds the root's devenv shell and runs its fetch; a failure is
 *       recorded for `check`, which fails every check with it
 *   ficus-scorer check <workdir>             network: none
 *       runs the root's checks then the task's, costs the diff; prints a
 *       CheckRun: the ScoreReport, plus the root's judges and the diff they judge
 *   ficus-scorer rebase '<RebaseRef JSON>'   network: Artifacts
 *       replays a behind attempt's commits onto the head in a fresh attempt
 *       and pushes them; prints a RebaseReport
 *   ficus-scorer hosts <checkout>
 *       the hosts its committed ficus.toml's `[fetch]` names, as JSON
 *
 * Two deploy phases, for a released node:
 *
 *   ficus-scorer deploy-prepare '<DeployRef JSON>'   network: Artifacts
 *       clones the released commit, reads its `[deploy]`; prints
 *       {"workdir": "...", "deploys": bool, "hosts": [...]}
 *   ficus-scorer deploy <workdir>      network: nix caches, those hosts, the Cloudflare API
 *       builds the root's devenv shell and runs the part of its `[deploy]`
 *       the ref named (`run` or `deployer`); prints a DeployReport
 *
 * Exit 0 with JSON on stdout on success; 2 when the attempt or root cannot
 * be scored or the replay conflicts (retrying will not help); 1 for anything
 * else. The reason is on stderr either way.
 *
 * An agent's workspace (the same image, another sandbox) also runs
 * `ficus-scorer fs <op>` and `ficus-scorer exec`, the request JSON on stdin;
 * each prints pi's `Result` JSON and exits 0, failures in the answer.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DeployRef } from "../core/deploy.ts";
import { AttemptRef, RebaseRef } from "../core/scoring.ts";
import { check, deploy, deployPrepare, fetch, fetchHosts, prepare, rebase } from "./scorer.ts";
import { isInputProblem, ScoreError } from "./shell.ts";
import * as Workspace from "./workspace.ts";

/** Where `prepare` puts workdirs: one per head commit. */
const WORK_ROOT = "/work/score";

const USAGE =
  "usage: ficus-scorer prepare '<AttemptRef JSON>' | fetch <workdir> | check <workdir> | hosts <checkout> | rebase '<RebaseRef JSON>' | deploy-prepare '<DeployRef JSON>' | deploy <workdir> | fs <op> | exec";

const unreadable = (what: string) => (issue: { readonly message: string }) =>
  new ScoreError({ kind: "Io", message: `the ${what} is not JSON of the expected shape: ${issue.message}` });

const decodeAttempt = Schema.decodeUnknownEffect(Schema.fromJsonString(AttemptRef));

const decodeRebase = Schema.decodeUnknownEffect(Schema.fromJsonString(RebaseRef));

const decodeDeploy = Schema.decodeUnknownEffect(Schema.fromJsonString(DeployRef));

/** What a scoring command prints on success, as JSON. */
const command = (args: ReadonlyArray<string>): Effect.Effect<string, ScoreError> | undefined => {
  const [name, argument] = args;

  if (argument === undefined || args.length !== 2) {
    return undefined;
  }

  switch (name) {
    case "prepare":
      return decodeAttempt(argument).pipe(
        Effect.mapError(unreadable("attempt")),
        Effect.flatMap((attempt) => prepare(WORK_ROOT, attempt)),
        Effect.map((prepared) => JSON.stringify(prepared)),
      );

    case "fetch":
      return fetch(argument).pipe(Effect.as("{}"));

    case "check":
      return check(argument).pipe(Effect.map((run) => JSON.stringify(run)));

    case "hosts":
      return fetchHosts(argument).pipe(Effect.map((hosts) => JSON.stringify(hosts)));

    case "rebase":
      return decodeRebase(argument).pipe(
        Effect.mapError(unreadable("rebase")),
        Effect.flatMap((job) => rebase(WORK_ROOT, job)),
        Effect.map((report) => JSON.stringify(report)),
      );

    case "deploy-prepare":
      return decodeDeploy(argument).pipe(
        Effect.mapError(unreadable("deploy")),
        Effect.flatMap((ref) => deployPrepare(WORK_ROOT, ref)),
        Effect.map((prepared) => JSON.stringify(prepared)),
      );

    case "deploy":
      return deploy(argument).pipe(Effect.map((report) => JSON.stringify(report)));

    default:
      return undefined;
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const [name, op] = args;

  if (name === "fs" && op !== undefined) {
    console.log(JSON.stringify(await Effect.runPromise(Workspace.fs(op, await Bun.stdin.text()))));

    return 0;
  }

  if (name === "exec" && args.length === 1) {
    console.log(JSON.stringify(await Effect.runPromise(Workspace.exec(await Bun.stdin.text()))));

    return 0;
  }

  const work = command(args);

  if (work === undefined) {
    console.error(USAGE);

    return 1;
  }

  const exit = await Effect.runPromiseExit(work);

  if (Exit.isSuccess(exit)) {
    console.log(exit.value);

    return 0;
  }

  return Option.match(Exit.findErrorOption(exit), {
    onNone: () => {
      console.error(String(exit.cause));

      return 1;
    },
    onSome: (failure) => {
      console.error(failure.message);

      return isInputProblem(failure) ? 2 : 1;
    },
  });
};

process.exit(await main());
