/**
 * An agent's workspace: the files and shell of its container, shaped after
 * pi-durable's `ExecutionEnv` so infra/src/agents/sandbox-env.ts is a
 * pass-through. The sandbox runs `ficus-scorer fs <op>` and `ficus-scorer
 * exec` with the request as JSON on stdin; each prints one answer on stdout.
 *
 * Every answer is pi's `Result`: `{"ok":true,"value":...}` or
 * `{"ok":false,"error":{"code":...,"message":...}}`, with pi's error codes.
 * Bytes travel as base64. The container belongs to one agent, so there is no
 * path confinement: the agent may touch anything a root shell could.
 */
import { spawn } from "node:child_process";
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** pi's `FileError` / `ExecutionError` codes. */
type FailureCode = "aborted" | "not_found" | "permission_denied" | "not_directory" | "is_directory" | "invalid" | "not_supported" | "timeout" | "spawn_error" | "unknown";

/** A failed operation, as pi reads it. */
class Failure extends Schema.TaggedError<Failure>()("Workspace.Failure", {
  code: Schema.String,
  message: Schema.String,
}) {}

const fail = (code: FailureCode, message: string) => new Failure({ code, message });

/** Node's errno codes, as pi's. */
const CODES: ReadonlyMap<string, FailureCode> = new Map([
  ["ENOENT", "not_found"],
  ["EACCES", "permission_denied"],
  ["EPERM", "permission_denied"],
  ["ENOTDIR", "not_directory"],
  ["EISDIR", "is_directory"],
  ["EINVAL", "invalid"],
  ["ENOTEMPTY", "invalid"],
  ["ENOTSUP", "not_supported"],
]);

const ErrnoLike = Schema.Struct({ code: Schema.String, message: Schema.String });

/** A file operation's rejection, as pi's error for `path`. */
const fileFailure = (path: string) => (cause: unknown) => {
  return Option.match(Schema.decodeUnknownOption(ErrnoLike)(cause), {
    onSome: (errno) => fail(CODES.get(errno.code) ?? "unknown", `${path}: ${errno.message}`),
    onNone: () => fail("unknown", `${path}: ${String(cause)}`),
  });
};

const onFile = <A>(path: string, operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: fileFailure(path) });

export const FsRequest = Schema.Struct({
  path: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  /** base64, for write and append. */
  content: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Int),
  recursive: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
  prefix: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
});

export type FsRequest = typeof FsRequest.Type;

const FileInfo = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  size: Schema.Number,
  mtimeMs: Schema.Number,
});

const info = Effect.fn("Workspace.info")(function* (path: string) {
  const metadata = yield* onFile(path, () => lstat(path));
  const kind = metadata.isSymbolicLink() ? "symlink" : metadata.isDirectory() ? "directory" : "file";

  return FileInfo.make({ name: basename(path), path, kind, size: metadata.size, mtimeMs: Math.floor(metadata.mtimeMs) });
});

const need = (value: string | undefined, name: string, op: string) => (value === undefined ? Effect.fail(fail("invalid", `\`${name}\` is required for ${op}`)) : Effect.succeed(value));

const removePath = Effect.fn("Workspace.remove")(function* (path: string, request: FsRequest) {
  const metadata = yield* onFile(path, () => lstat(path)).pipe(
    Effect.catchTag("Workspace.Failure", (failure) => (failure.code === "not_found" && request.force === true ? Effect.succeed(undefined) : Effect.fail(failure))),
  );

  if (metadata === undefined) {
    return null;
  }

  if (!metadata.isDirectory()) {
    yield* onFile(path, () => unlink(path));
  } else if (request.recursive === true) {
    yield* onFile(path, () => rm(path, { recursive: true }));
  } else {
    yield* onFile(path, () => rmdir(path));
  }

  return null;
});

/** One file operation: what pi's `FileSystem` method of that name answers. */
const fsOp = Effect.fn("Workspace.fs")(function* (op: string, request: FsRequest) {
  const path = () => need(request.path, "path", op);

  switch (op) {
    case "read": {
      const at = yield* path();

      return (yield* onFile(at, () => readFile(at))).toString("base64");
    }

    case "write":
    case "append": {
      const at = yield* path();
      const content = Buffer.from(yield* need(request.content, "content", op), "base64");

      yield* onFile(at, () => (op === "append" ? appendFile(at, content) : writeFile(at, content)));

      return null;
    }

    case "truncate": {
      const at = yield* path();

      if (request.size === undefined) {
        return yield* fail("invalid", "`size` is required");
      }

      const size = request.size;

      yield* onFile(at, () => truncate(at, size));

      return null;
    }

    case "flush": {
      const at = yield* path();

      yield* onFile(at, async () => {
        const file = await open(at, "r");

        try {
          await file.sync();
        } finally {
          await file.close();
        }
      });

      return null;
    }

    case "rename": {
      const [from, to] = [yield* path(), yield* need(request.to, "to", op)];

      yield* onFile(from, () => rename(from, to));

      return null;
    }

    case "info":
      return yield* info(yield* path());

    case "list": {
      const at = yield* path();
      const names = yield* onFile(at, () => readdir(at));

      return yield* Effect.forEach(names, (name) => info(join(at, name)));
    }

    case "canonical": {
      const at = yield* path();

      return yield* onFile(at, () => realpath(at));
    }

    case "exists": {
      const at = yield* path();

      return yield* onFile(at, () => stat(at)).pipe(
        Effect.as(true),
        Effect.catchTag("Workspace.Failure", (failure) => (failure.code === "not_found" ? Effect.succeed(false) : Effect.fail(failure))),
      );
    }

    case "mkdir": {
      const at = yield* path();

      yield* onFile(at, () => mkdir(at, { recursive: request.recursive === true }));

      return null;
    }

    case "remove":
      return yield* removePath(yield* path(), request);

    case "tempdir":
      return yield* onFile("tempdir", () => mkdtemp(join(tmpdir(), request.prefix ?? "pi-")));

    case "tempfile": {
      const dir = yield* onFile("tempfile", () => mkdtemp(join(tmpdir(), request.prefix ?? "pi-")));
      const file = join(dir, `file${request.suffix ?? ""}`);

      yield* onFile(file, () => writeFile(file, ""));

      return file;
    }

    default:
      return yield* fail("not_supported", `no filesystem operation ${JSON.stringify(op)}`);
  }
});

/** pi's `Result` from an operation's outcome. */
const answer = <A>(work: Effect.Effect<A, Failure>) =>
  work.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catchTag("Workspace.Failure", (failure) => Effect.succeed({ ok: false as const, error: { code: failure.code, message: failure.message } })),
  );

const unreadable = (issue: { readonly message: string }) => fail("invalid", `the request is not JSON of the expected shape: ${issue.message}`);

/** `ficus-scorer fs <op>`, the request (JSON) in `request`. */
export const fs = (op: string, request: string) =>
  answer(
    Schema.decodeUnknownEffect(Schema.fromJsonString(FsRequest))(request).pipe(
      Effect.mapError(unreadable),
      Effect.flatMap((decoded) => fsOp(op, decoded)),
    ),
  );

export const ExecRequest = Schema.Struct({
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** pi's default: the child sees the container's environment plus `env`. */
  inherit_env: Schema.optional(Schema.Boolean),
  timeout_ms: Schema.optional(Schema.Int),
  spill_after_bytes: Schema.optional(Schema.Int),
  spill_after_lines: Schema.optional(Schema.Int),
});

export type ExecRequest = typeof ExecRequest.Type;

const EXEC_TIMEOUT_MS = 600_000;

/**
 * Run `command` under bash, both streams interleaved in one pipe, in its own
 * process group so a timeout kills everything it started.
 */
const runShell = (request: ExecRequest) =>
  Effect.callback<{ readonly exitCode: number; readonly output: Buffer }, Failure>((resume) => {
    // pi's default: the container's environment, plus the request's.
    const inherited = request.inherit_env === false ? undefined : process.env;

    const child = spawn("bash", ["-c", `exec 2>&1\n${request.command}`], {
      cwd: request.cwd,
      env: { ...inherited, ...request.env },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });

    const chunks: Array<Buffer> = [];
    const timeoutMs = request.timeout_ms ?? EXEC_TIMEOUT_MS;

    const timer = setTimeout(() => {
      // Killing only bash would leave its children holding the pipe open.
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }

      resume(Effect.fail(fail("timeout", `timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resume(Effect.fail(fail("spawn_error", error.message)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resume(Effect.succeed({ exitCode: code ?? -1, output: Buffer.concat(chunks) }));
    });
  });

const execOp = Effect.fn("Workspace.exec")(function* (request: ExecRequest) {
  const ran = yield* runShell(request);
  const output = ran.output.toString("utf8");
  const lines = output.split("\n").length - (output.endsWith("\n") ? 1 : 0);

  const spill =
    (request.spill_after_bytes !== undefined && ran.output.length > request.spill_after_bytes) ||
    (request.spill_after_lines !== undefined && lines > request.spill_after_lines);

  if (!spill) {
    return { exitCode: ran.exitCode, output };
  }

  const spillPath = join(tmpdir(), `pi-spill-${Date.now()}-${process.pid}.log`);

  yield* onFile(spillPath, () => writeFile(spillPath, ran.output));

  return { exitCode: ran.exitCode, spillPath, output };
});

/** `ficus-scorer exec`, the request (JSON) in `request`: pi's `ShellExecResult` plus the output, or a spill file holding it. */
export const exec = (request: string) =>
  answer(
    Schema.decodeUnknownEffect(Schema.fromJsonString(ExecRequest))(request).pipe(
      Effect.mapError(unreadable),
      Effect.flatMap((decoded) => execOp(decoded)),
    ),
  );
