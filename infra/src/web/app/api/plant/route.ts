/**
 * `POST /api/plant {org, tree, source, operation}`: plant, and stream its
 * progress back as it happens (one JSON object per line). A refusal before
 * any progress (not signed in, not a member) is a JSON `{error}` with its
 * status.
 */
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Api from "../../../lib/api.ts";
import { attempt } from "../../../lib/run.ts";

const PlantRequest = Schema.Struct({
  org: Schema.NonEmptyString,
  tree: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  operation: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
});

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PlantRequest));

export const POST = async (request: Request) => {
  const asked = decode(await request.text());

  if (Option.isNone(asked)) {
    return Response.json({ error: "org, tree, source and an operation id are required" }, { status: 400 });
  }

  const { org, tree, source, operation } = asked.value;
  const answer = await attempt(Api.plant(org, tree, source, operation));

  if (Result.isFailure(answer)) {
    return Response.json({ error: answer.failure.message }, { status: answer.failure.status });
  }

  return new Response(answer.success.body, {
    headers: { "content-type": Api.PROGRESS, "cache-control": "no-store" },
  });
};
