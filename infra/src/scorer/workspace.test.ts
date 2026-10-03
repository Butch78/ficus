import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Workspace from "./workspace.ts";

const scratch: Array<string> = [];

afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ficus-workspace-"));

  scratch.push(dir);

  return dir;
};

const fs = (op: string, request: Workspace.FsRequest) => Effect.runPromise(Workspace.fs(op, JSON.stringify(request)));

const exec = (request: Workspace.ExecRequest) => Effect.runPromise(Workspace.exec(JSON.stringify(request)));

const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("an agent's files", () => {
  test("write, append, read and truncate round-trip", async () => {
    const file = join(tempDir(), "a.txt");

    await fs("write", { path: file, content: base64("hello") });
    await fs("append", { path: file, content: base64(" world") });

    const read = await fs("read", { path: file });

    expect(read.ok && Predicate.isString(read.value) ? Buffer.from(read.value, "base64").toString() : read).toBe("hello world");
    await fs("truncate", { path: file, size: 5 });
    expect(await fs("info", { path: file })).toMatchObject({ ok: true, value: { kind: "file", size: 5, name: "a.txt" } });
  });

  test("missing paths fail with pi's codes", async () => {
    const missing = join(tempDir(), "nope");

    expect(await fs("read", { path: missing })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await fs("exists", { path: missing })).toEqual({ ok: true, value: false });
    expect(await fs("remove", { path: missing, force: true })).toEqual({ ok: true, value: null });
    expect(await fs("remove", { path: missing })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await fs("frobnicate", { path: missing })).toMatchObject({ ok: false, error: { code: "not_supported" } });
  });

  test("directories list, and need recursive to remove", async () => {
    const dir = tempDir();
    const top = join(dir, "x");

    await fs("mkdir", { path: join(top, "y"), recursive: true });
    expect(await fs("list", { path: top })).toMatchObject({ ok: true, value: [{ kind: "directory", name: "y" }] });
    expect((await fs("remove", { path: top })).ok).toBe(false);
    await fs("remove", { path: top, recursive: true });
    expect(existsSync(top)).toBe(false);
  });
});

describe("an agent's shell", () => {
  test("interleaves both streams and reports the exit code", async () => {
    expect(await exec({ command: "echo out; echo err >&2; echo again; exit 3" })).toEqual({ ok: true, value: { exitCode: 3, output: "out\nerr\nagain\n" } });
  });

  test("spills long output to a file", async () => {
    const ran = await exec({ command: "seq 1 100", spill_after_lines: 10 });

    if (!ran.ok || !("spillPath" in ran.value) || ran.value.spillPath === undefined) {
      throw new Error("the output did not spill");
    }

    expect(readFileSync(ran.value.spillPath, "utf8").trim().split("\n")).toHaveLength(100);
  });

  test("a timeout kills the whole group", async () => {
    const started = Date.now();

    expect(await exec({ command: "sleep 30 & sleep 30; wait", timeout_ms: 300 })).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("uses cwd and env", async () => {
    const dir = tempDir();
    const ran = await exec({ command: 'echo "$FICUS_X $(pwd)"', cwd: dir, env: { FICUS_X: "hi" } });

    expect(ran).toMatchObject({ ok: true, value: { output: `hi ${realpathSync(dir)}\n` } });
  });
});
