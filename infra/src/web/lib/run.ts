/**
 * Running the Api's Effects from a page or a server action: the request's
 * cookie and origin go in, and a failure becomes what Next.js pages do with
 * one (sign in again, not found, or the error boundary).
 */
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import * as CloudflareTracer from "../../observability/tracer.ts";
import * as Api from "./api.ts";
import { type ApiError, Upstream } from "./api.ts";
import { landing } from "./visitor.ts";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const upstream = async () => {
  const incoming = await headers();
  const host = incoming.get("host") ?? "localhost";

  return {
    api: env.API,
    // Workers are reached over https; `alchemy dev` serves plain http.
    origin: `${LOCAL_HOST.test(host) ? "http" : "https"}://${host}`,
    cookie: incoming.get("cookie") ?? undefined,
  };
};

/** The program's outcome, failures included: for pages that show them in place. */
export const run = async <A>(program: Effect.Effect<A, ApiError, Upstream>) =>
  Effect.runPromise(
    program.pipe(
      Effect.result,
      Effect.provideService(Upstream, await upstream()),
      // The program's Effect spans join the request's Cloudflare trace.
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- runs the request's Effect: an entry point
      Effect.provide(CloudflareTracer.layer),
    ),
  );

/** The program's value; a signed-out caller is sent to sign in, a missing thing is a 404. */
export const load = async <A>(program: Effect.Effect<A, ApiError, Upstream>) => {
  const outcome = await run(program);

  if (Result.isSuccess(outcome)) {
    return outcome.success;
  }

  const { status, message } = outcome.failure;

  const to = landing(status, (await upstream()).cookie !== undefined);

  if (to === "sign-in") {
    redirect("/sign-in");
  }

  if (to === "not-found") {
    notFound();
  }

  throw new Error(`the Api answered ${status}: ${message}`);
};

/** Whether the visitor has a session: a public tree's page shows an anonymous one only what it may read. */
export const signedIn = async () => (await load(Api.session)) !== null;
