/**
 * pi-durable's `ExecutionEnv` over an agent's container: every file and shell
 * operation is a request to the agent's `Worktree` Durable Object
 * (src/sandbox/workspace.ts), which runs it as `ficus-scorer fs <op>` or
 * `ficus-scorer exec` in the container.
 *
 * The container answers in pi's own `Result` shape with pi's error codes, so
 * this is a pass-through: decode at the boundary, rebuild pi's error classes.
 * pi's interface is promise-based, so each method runs its Effect at the edge.
 */
import posix from "node:path/posix";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  type ExecutionEnv,
  FileError,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The `Worktree` stub for this agent's container. */
export interface SandboxStub {
  readonly fetch: (request: Request) => Promise<Response>;
}

const FILE_CODES = [
  "aborted",
  "not_found",
  "permission_denied",
  "not_directory",
  "is_directory",
  "invalid",
  "not_supported",
  "unknown",
] as const;

const EXEC_CODES = ["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"] as const;

const Failure = Schema.Struct({ code: Schema.String, message: Schema.String });

interface Failure extends Schema.Schema.Type<typeof Failure> {}

/** pi's `Result`, before its value is decoded. */
const Envelope = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: Failure }),
]);

const FileInfoSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  size: Schema.Number,
  mtimeMs: Schema.Number,
});

const ExecAnswer = Schema.Struct({
  exitCode: Schema.Number,
  output: Schema.String,
  spillPath: Schema.optional(Schema.String),
});

const isFileCode = Schema.is(Schema.Literals(FILE_CODES));

const isExecCode = Schema.is(Schema.Literals(EXEC_CODES));

export class SandboxError extends Schema.TaggedError<SandboxError>()("Sandbox.SandboxError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** One request to the sandbox, decoded as pi's `Result`, then its value as `A`. */
const request = Effect.fn("Sandbox.request")(function* <A>(
  stub: SandboxStub,
  path: string,
  body: Readonly<Record<string, string | number | boolean | undefined | Readonly<Record<string, string>>>>,
  value: Schema.Decoder<A>,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      stub.fetch(
        new Request(`http://sandbox${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    catch: (cause) => new SandboxError({ operation: path, cause }),
  });

  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new SandboxError({ operation: `${path} (status ${response.status})`, cause }),
  });

  // The sandbox answers pi's Result as JSON; anything else is its own failure, in words.
  if (!response.ok) {
    return yield* new SandboxError({ operation: `${path} (status ${response.status})`, cause: text });
  }

  const json = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) => new SandboxError({ operation: `${path}: not JSON`, cause }),
  });

  const envelope = yield* Schema.decodeUnknownEffect(Envelope)(json).pipe(
    Effect.mapError((cause) => new SandboxError({ operation: `${path} decode`, cause })),
  );

  if (!envelope.ok) {
    return { ok: false as const, error: envelope.error };
  }

  const decoded = yield* Schema.decodeUnknownEffect(value)(envelope.value).pipe(
    Effect.mapError((cause) => new SandboxError({ operation: `${path} decode value`, cause })),
  );

  return { ok: true as const, value: decoded };
});

/** pi's shell timeouts are seconds (its own env does `timeout * 1000`); the sandbox's are milliseconds. */
export const timeoutMs = (seconds: number | undefined) => (seconds === undefined ? undefined : seconds * 1000);

const fileError = (failure: Failure, path?: string): FileError =>
  new FileError(isFileCode(failure.code) ? failure.code : "unknown", failure.message, path);

/** Run a file operation; transport failures become pi `FileError`s too. */
const fileOp = <A>(
  stub: SandboxStub,
  op: string,
  body: Readonly<Record<string, string | number | boolean | undefined>>,
  value: Schema.Decoder<A>,
  path?: string,
): Promise<Result<A, FileError>> =>
  Effect.runPromise(
    request(stub, `/fs/${op}`, body, value).pipe(
      Effect.map((decoded): Result<A, FileError> =>
        decoded.ok ? { ok: true, value: decoded.value } : { ok: false, error: fileError(decoded.error, path) },
      ),
      Effect.catchTag("Sandbox.SandboxError", (error) =>
        Effect.succeed<Result<A, FileError>>({
          ok: false,
          error: new FileError("unknown", `sandbox ${error.operation}: ${String(error.cause)}`, path),
        }),
      ),
    ),
  );

const base64 = (content: string | Uint8Array): string => {
  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
};

const fromBase64 = (encoded: string): Uint8Array => Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));

/**
 * The agent's container as pi's execution environment. `id` names the
 * container's file namespace; `cwd` is the attempt's checkout inside it.
 */
export class ContainerEnv implements ExecutionEnv {
  constructor(
    private readonly stub: SandboxStub,
    public readonly id: string,
    public cwd: string,
  ) {}

  private resolve(path: string): string {
    return posix.resolve(this.cwd, path);
  }

  absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return Promise.resolve({ ok: true, value: this.resolve(path) });
  }

  joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return Promise.resolve({ ok: true, value: posix.join(...parts) });
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, context);

    return bytes.ok ? { ok: true, value: new TextDecoder().decode(bytes.value) } : bytes;
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path, context);

    if (!text.ok) {
      return text;
    }

    const lines = text.value.split("\n");

    if (text.value.endsWith("\n")) {
      lines.pop();
    }

    return { ok: true, value: options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines) };
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path, context);

    if (!text.ok) {
      return text;
    }

    const pieces = text.value.split("\n");
    let next = 0;

    return {
      ok: true,
      value: {
        readLine: () => {
          if (next >= pieces.length || (next === pieces.length - 1 && pieces[next] === "")) {
            return Promise.resolve({ ok: true, value: undefined });
          }

          const terminated = next < pieces.length - 1;
          const line = { text: pieces[next] ?? "", terminated };

          next += 1;

          return Promise.resolve({ ok: true, value: line });
        },
        close: () => Promise.resolve(),
      },
    };
  }

  async readBinaryFile(path: string, _context: Context): Promise<Result<Uint8Array, FileError>> {
    const full = this.resolve(path);
    const read = await fileOp(this.stub, "read", { path: full }, Schema.String, full);

    return read.ok ? { ok: true, value: fromBase64(read.value) } : read;
  }

  async writeFile(path: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    const full = this.resolve(path);
    const written = await fileOp(this.stub, "write", { path: full, content: base64(content) }, Schema.Null, full);

    return written.ok ? { ok: true, value: undefined } : written;
  }

  async appendFile(path: string, content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
    const full = this.resolve(path);
    const appended = await fileOp(this.stub, "append", { path: full, content: base64(content) }, Schema.Null, full);

    return appended.ok ? { ok: true, value: undefined } : appended;
  }

  async truncateFile(path: string, size: number, _context: Context): Promise<Result<void, FileError>> {
    const full = this.resolve(path);
    const done = await fileOp(this.stub, "truncate", { path: full, size }, Schema.Null, full);

    return done.ok ? { ok: true, value: undefined } : done;
  }

  async flushFile(path: string, _context: Context): Promise<Result<void, FileError>> {
    const full = this.resolve(path);
    const done = await fileOp(this.stub, "flush", { path: full }, Schema.Null, full);

    return done.ok ? { ok: true, value: undefined } : done;
  }

  async renameFile(sourcePath: string, destinationPath: string, _context: Context): Promise<Result<void, FileError>> {
    const from = this.resolve(sourcePath);
    const done = await fileOp(this.stub, "rename", { path: from, to: this.resolve(destinationPath) }, Schema.Null, from);

    return done.ok ? { ok: true, value: undefined } : done;
  }

  fileInfo(path: string, _context: Context): Promise<Result<FileInfo, FileError>> {
    const full = this.resolve(path);

    return fileOp(this.stub, "info", { path: full }, FileInfoSchema, full);
  }

  async listDir(path: string, _context: Context): Promise<Result<FileInfo[], FileError>> {
    const full = this.resolve(path);
    const listed = await fileOp(this.stub, "list", { path: full }, Schema.Array(FileInfoSchema), full);

    return listed.ok ? { ok: true, value: [...listed.value] } : listed;
  }

  canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
    const full = this.resolve(path);

    return fileOp(this.stub, "canonical", { path: full }, Schema.String, full);
  }

  exists(path: string, _context: Context): Promise<Result<boolean, FileError>> {
    const full = this.resolve(path);

    return fileOp(this.stub, "exists", { path: full }, Schema.Boolean, full);
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    _context: Context,
  ): Promise<Result<void, FileError>> {
    const full = this.resolve(path);
    const done = await fileOp(this.stub, "mkdir", { path: full, recursive: options?.recursive }, Schema.Null, full);

    return done.ok ? { ok: true, value: undefined } : done;
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    _context: Context,
  ): Promise<Result<void, FileError>> {
    const full = this.resolve(path);
    const body = { path: full, recursive: options?.recursive, force: options?.force };
    const done = await fileOp(this.stub, "remove", body, Schema.Null, full);

    return done.ok ? { ok: true, value: undefined } : done;
  }

  createTempDir(prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    return fileOp(this.stub, "tempdir", { prefix }, Schema.String);
  }

  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    _context: Context,
  ): Promise<Result<string, FileError>> {
    return fileOp(this.stub, "tempfile", { prefix: options?.prefix, suffix: options?.suffix }, Schema.String);
  }

  /**
   * The container's output arrives whole when the command ends, not
   * streamed, so `onOutput` sees it once.
   */
  exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const body = {
      command,
      cwd: options?.cwd ?? this.cwd,
      env: options?.env,
      inherit_env: options?.inheritEnv,
      timeout_ms: timeoutMs(options?.timeout),
      spill_after_bytes: options?.spill?.afterBytes,
      spill_after_lines: options?.spill?.afterLines,
    };

    return Effect.runPromise(
      request(this.stub, "/exec", body, ExecAnswer).pipe(
        Effect.map((decoded): Result<ShellExecResult, ExecutionError> => {
          if (!decoded.ok) {
            const code = isExecCode(decoded.error.code) ? decoded.error.code : "unknown";

            return { ok: false, error: new ExecutionError(code, decoded.error.message) };
          }

          options?.onOutput?.(decoded.value.output, context);

          return {
            ok: true,
            value:
              decoded.value.spillPath === undefined
                ? { exitCode: decoded.value.exitCode }
                : { exitCode: decoded.value.exitCode, spillPath: decoded.value.spillPath },
          };
        }),
        Effect.catchTag("Sandbox.SandboxError", (error) =>
          Effect.succeed<Result<ShellExecResult, ExecutionError>>({
            ok: false,
            error: new ExecutionError("shell_unavailable", `sandbox ${error.operation}: ${String(error.cause)}`),
          }),
        ),
      ),
    );
  }

  cleanup(_context: Context): Promise<void> {
    return Promise.resolve();
  }
}
