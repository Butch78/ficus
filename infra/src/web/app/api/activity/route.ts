/**
 * `GET /api/activity?org=<slug>&op=<id>`: the steps of one of the caller's
 * operations, from its Cloudflare trace. Members of the organization only:
 * the Api answers for membership first, and the trace is found by both the
 * operation's id and the organization it was marked with.
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { steps } from "../../../lib/activity.ts";
import * as Api from "../../../lib/api.ts";
import { attempt } from "../../../lib/run.ts";
import { operationTrace } from "../../../lib/trace.ts";

const OPERATION = /^[0-9a-f-]{36}$/;

export const GET = async (request: Request) => {
  const query = new URL(request.url).searchParams;
  const org = query.get("org") ?? "";
  const operation = query.get("op") ?? "";

  if (org === "" || !OPERATION.test(operation)) {
    return Response.json({ error: "org and op are required" }, { status: 400 });
  }

  const member = await attempt(Api.trees(org));

  if (Result.isFailure(member)) {
    return Response.json({ error: member.failure.message }, { status: member.failure.status });
  }

  const trace = await Effect.runPromise(Effect.result(operationTrace(org, operation)));

  return Result.isSuccess(trace)
    ? Response.json({ steps: steps(trace.success) }, { headers: { "cache-control": "no-store" } })
    : Response.json({ error: trace.failure.message }, { status: 503 });
};
