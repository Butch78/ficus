/**
 * What the Sandbox and Workspace objects do to their container, over the
 * runtime's native container API (`ctx.container`): boot it, from a
 * snapshot when there is one; open hosts to it through Egress; run
 * commands in it; snapshot it.
 *
 * A snapshot is the container's writable root filesystem (the nix store a
 * root's devenv shell built, above all), not its memory: a container
 * started from one runs its entrypoint again. Each boot carries a nonce the
 * entrypoint writes to /run/ficus-ready, so a marker restored from a
 * snapshot never passes for this boot's.
 */
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { EgressProps } from "./egress.ts";

/**
 * The environment every exec runs with: the image's (context/Dockerfile), so
 * it does not depend on what the platform's exec inherits. The CA bundle is
 * the one ficus-trust-egress extends with the egress CA.
 */
export const EXEC_ENV = {
  PATH: "/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin",
  HOME: "/root",
  USER: "root",
  SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
  NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
  GIT_SSL_CAINFO: "/etc/ssl/certs/ca-bundle.crt",
} as const;

export const SCORER = "/usr/local/bin/ficus-scorer";

/**
 * What a root's devenv shell downloads while it builds: binary caches, and
 * GitHub for flake inputs such as cachix/devenv-nixpkgs.
 */
export const NIX_HOSTS = [
  "cache.nixos.org",
  "devenv.cachix.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
] as const;

export class SandboxFailure extends Schema.TaggedError<SandboxFailure>()("Sandbox.Failure", {
  status: Schema.Number,
  message: Schema.String,
}) {}

export const failure = (status: number, message: string) => new SandboxFailure({ status, message });

/** The Worker's own default export (worker.ts), called with props: Egress. */
interface Loopback {
  readonly default: (options: { readonly props: EgressProps }) => cf.Fetcher;
}

/** A Durable Object's container and its way back into its own Worker. */
export interface Machine {
  readonly container: cf.Container;
  readonly loopback: Loopback;
}

/** The runtime state an Effect-native Durable Object exposes as `state.raw`. */
interface RawState {
  readonly container?: cf.Container | undefined;
  readonly exports: object;
}

export const machineOf = (raw: RawState): Effect.Effect<Machine, SandboxFailure> => {
  if (raw.container === undefined) {
    return Effect.fail(failure(500, "this Durable Object has no container: check its container binding"));
  }

  // SAFETY: worker.ts's default export is the WorkerEntrypoint alchemy
  // generates for this Worker; ctx.exports holds a constructor for it that
  // takes props. workers-types types `exports` per Worker module, which an
  // Effect-native Worker does not declare.
  return Effect.succeed({ container: raw.container, loopback: raw.exports as Loopback });
};

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `argv` in the container; `stdin` is written to it when given. */
export const exec = Effect.fn("Machine.exec")(function* (
  machine: Machine,
  argv: ReadonlyArray<string>,
  options: { readonly stdin?: string; readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
) {
  const output = yield* Effect.tryPromise({
    try: async () => {
      const execOptions: cf.ContainerExecOptions = { env: { ...EXEC_ENV, ...options.env } };

      if (options.cwd !== undefined) {
        execOptions.cwd = options.cwd;
      }

      if (options.stdin !== undefined) {
        execOptions.stdin = "pipe";
      }

      const process = await machine.container.exec([...argv], execOptions);

      if (options.stdin !== undefined && process.stdin !== null) {
        const writer = process.stdin.getWriter();

        await writer.write(new TextEncoder().encode(options.stdin));
        await writer.close();
      }

      return process.output();
    },
    catch: (cause) => failure(503, `${argv.slice(0, 2).join(" ")}: ${String(cause)}`),
  });

  const decoder = new TextDecoder();

  return {
    exitCode: output.exitCode,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  } satisfies Ran;
});

/** Wait until this boot's entrypoint has marked the container ready. */
const ready = (machine: Machine, nonce: string, times: number) =>
  Effect.tryPromise({
    try: async () => {
      const probe = await machine.container.exec(
        ["/bin/sh", "-c", 'test "$(cat /run/ficus-ready 2>/dev/null)" = "$0"', nonce],
        { env: { ...EXEC_ENV } },
      );

      if ((await probe.exitCode) !== 0) {
        throw new Error("entrypoint still running");
      }
    },
    catch: (cause) => failure(503, `the container did not become ready: ${String(cause)}`),
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times }));

const start = (machine: Machine, nonce: string, snapshot: string | undefined) =>
  Effect.try({
    try: () =>
      machine.container.start(
        snapshot === undefined
          ? { enableInternet: false, env: { FICUS_BOOT: nonce } }
          : { enableInternet: false, env: { FICUS_BOOT: nonce }, containerSnapshot: { id: snapshot } },
      ),
    catch: (cause) => failure(503, `starting the container: ${String(cause)}`),
  });

/** How a boot went: whether it came from the snapshot, and whether that snapshot is gone. */
export interface Booted {
  readonly restored: boolean;
  readonly stale: boolean;
}

/**
 * Start the container with the internet off, from `snapshot` if given. A
 * snapshot that cannot be restored (expired, or from elsewhere) falls back
 * to the image and is reported stale. A running container is left as is.
 */
export const boot = Effect.fn("Machine.boot")(function* (machine: Machine, snapshot: string | undefined) {
  if (machine.container.running) {
    return { restored: false, stale: false } satisfies Booted;
  }

  if (snapshot !== undefined) {
    const nonce = crypto.randomUUID();

    const restored = yield* start(machine, nonce, snapshot).pipe(
      Effect.andThen(ready(machine, nonce, 60)),
      Effect.as(true),
      Effect.catchTag("Sandbox.Failure", (error) =>
        Effect.logWarning(`snapshot ${snapshot} did not restore; booting the image`, error.message).pipe(
          Effect.andThen(destroy(machine)),
          Effect.as(false),
        ),
      ),
    );

    if (restored) {
      return { restored: true, stale: false } satisfies Booted;
    }
  }

  const nonce = crypto.randomUUID();

  yield* start(machine, nonce, undefined);
  yield* ready(machine, nonce, 120);

  return { restored: false, stale: snapshot !== undefined } satisfies Booted;
});

/** Route `host`'s HTTPS through Egress with `props`. Replaces any earlier route. */
export const route = Effect.fn("Machine.route")(function* (machine: Machine, host: string, props: EgressProps) {
  yield* Effect.tryPromise({
    try: () => machine.container.interceptOutboundHttps(host, machine.loopback.default({ props })),
    catch: (cause) => failure(500, `routing ${host}: ${String(cause)}`),
  });
});

/** Trust the egress CA, which exists only once HTTPS interception is on. */
export const trustEgress = Effect.fn("Machine.trustEgress")(function* (machine: Machine) {
  const trusted = yield* exec(machine, ["/usr/local/bin/ficus-trust-egress"]);

  if (trusted.exitCode !== 0) {
    return yield* failure(503, `trusting the egress CA: ${trusted.stderr.trim()}`);
  }
});

/**
 * Snapshot the container's root filesystem; `undefined` when the platform
 * will not. A missing snapshot only costs the next container its warm
 * start, so a failure here is logged, not raised.
 */
export const snapshot = Effect.fn("Machine.snapshot")(function* (machine: Machine, name: string) {
  return yield* Effect.tryPromise({
    try: (): Promise<cf.ContainerSnapshot> => machine.container.snapshotContainer({ name }),
    catch: (cause) => failure(503, `snapshotting: ${String(cause)}`),
  }).pipe(
    Effect.map((taken): string | undefined => taken.id),
    Effect.catchTag("Sandbox.Failure", (error) =>
      Effect.logWarning("no snapshot taken", error.message).pipe(Effect.as(undefined)),
    ),
  );
});

/**
 * Stop and delete the container. Its work is over either way; a container
 * that will not go is the platform's to reap, so the failure is logged.
 */
export const destroy = (machine: Machine) =>
  Effect.tryPromise({
    try: () => machine.container.destroy(),
    catch: (cause) => failure(503, `destroying the container: ${String(cause)}`),
  }).pipe(Effect.catchTag("Sandbox.Failure", (error) => Effect.logWarning(error.message)));
