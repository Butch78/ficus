/**
 * Commands the scorer runs: git, the root's devenv, its checks. Each is an
 * Effect at this boundary; what a command printed comes back as a tail a
 * person can read.
 */
import { rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Characters of a command's output kept for a report. */
export const TAIL_CHARS = 4000;

/** Error lines from before the tail that a tail keeps, at most. */
const EARLIER_ERRORS = 12;

/** Why scoring or a rebase could not go on. `isInputProblem` decides the exit code. */
export const ScoreErrorKind = Schema.Literals(["Git", "NoRootChecks", "RootChecks", "NotDescendant", "Conflict", "Io"]);

export class ScoreError extends Schema.TaggedError<ScoreError>()("Scorer.Error", {
  kind: ScoreErrorKind,
  message: Schema.String,
}) {}

/** Whether the attempt or root is at fault, rather than the scorer: retrying will not help. */
export const isInputProblem = (error: ScoreError) =>
  error.kind === "NoRootChecks" || error.kind === "RootChecks" || error.kind === "NotDescendant" || error.kind === "Conflict";

const io = (message: string) => (cause: unknown) => new ScoreError({ kind: "Io", message: `${message}: ${String(cause)}` });

/** `text` without terminal escape sequences (`ESC [ ... letter`). */
// oxlint-disable-next-line no-control-regex -- the escape character is what is being removed
export const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * What a person needs from a command's output: its last `TAIL_CHARS`, and
 * before them the first error lines the cut dropped (nix says why a build
 * failed long before its last line). Terminal colours are stripped.
 */
export const tail = (output: string) => {
  const text = stripAnsi(output);
  const start = Math.max(0, text.length - TAIL_CHARS);

  const earlier = text
    .slice(0, start)
    .split("\n")
    .filter((line) => line.toLowerCase().includes("error"))
    .slice(0, EARLIER_ERRORS)
    .map((line) => line.trim().slice(0, 300));

  return earlier.length === 0 ? text.slice(start) : `${earlier.join("\n")}\n…\n${text.slice(start)}`;
};

/** How a command went. */
export interface Ran {
  readonly passed: boolean;
  readonly millis: number;
  readonly tail: string;
}

/**
 * Run `argv` in `dir` with `CI=1`, for at most `timeoutSecs`. Its output (stderr
 * first: test runners report on stdout, and the tail keeps the end) comes back
 * as a tail; a command that overran says so.
 */
export const run = Effect.fn("Scorer.run")(function* (dir: string, argv: ReadonlyArray<string>, timeoutSecs: number) {
  const started = Date.now();

  const done = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...argv], {
        cwd: dir,
        env: { ...process.env, CI: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutSecs * 1000,
        killSignal: "SIGKILL",
      });

      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

      return { stdout, stderr, exitCode, killed: child.signalCode !== null && exitCode !== 0 };
    },
    catch: io(`running ${argv[0] ?? "a command"}`),
  });

  const millis = Date.now() - started;

  if (done.killed && millis >= timeoutSecs * 1000) {
    return { passed: false, millis, tail: `timed out after ${timeoutSecs}s` } satisfies Ran;
  }

  return { passed: done.exitCode === 0, millis, tail: tail(done.stderr + done.stdout) } satisfies Ran;
});

/** `git <args>` in `dir`: its stdout, or a `Git` error with what it said. */
export const git = Effect.fn("Scorer.git")(function* (dir: string, step: string, args: ReadonlyArray<string>) {
  const done = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["git", ...args], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

      return { stdout, stderr, exitCode };
    },
    catch: io(`git ${step}`),
  });

  if (done.exitCode !== 0) {
    return yield* new ScoreError({ kind: "Git", message: `git ${step} failed: ${done.stderr.trim()}` });
  }

  return done.stdout;
});

/** Whether `git <args>` in `dir` succeeds; what it printed does not matter. */
export const succeeds = Effect.fn("Scorer.succeeds")(function* (dir: string, args: ReadonlyArray<string>) {
  return yield* Effect.tryPromise({
    try: async () => (await Bun.spawn(["git", ...args], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0,
    catch: io(`git ${args[0] ?? ""}`),
  });
});

/** Remove `path` and everything under it, if it is there. */
export const removeAll = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { recursive: true, force: true }),
    catch: io(`removing ${path}`),
  });
