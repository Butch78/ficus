/**
 * `POST /api/start {org, tree, task, agent}`: start an attempt for the caller to
 * work by hand. The answer carries the attempt's write token, once: the person
 * pushes with it, as an agent would.
 */
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Api from "../../../lib/api.ts";
import { run } from "../../../lib/run.ts";

const StartRequest = Schema.Struct({
  org: Schema.NonEmptyString,
  tree: Schema.NonEmptyString,
  task: Schema.Number,
  agent: Schema.NonEmptyString,
});

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(StartRequest));

export const POST = async (request: Request) => {
  const asked = decode(await request.text());

  if (Option.isNone(asked)) {
    return Response.json({ error: "org, tree, task and agent are required" }, { status: 400 });
  }

  const { org, tree, task, agent } = asked.value;
  const started = await run(Api.start(org, tree, task, agent, crypto.randomUUID()));

  return Result.isSuccess(started)
    ? Response.json(started.success, { headers: { "cache-control": "no-store" } })
    : Response.json({ error: started.failure.message }, { status: started.failure.status });
};
