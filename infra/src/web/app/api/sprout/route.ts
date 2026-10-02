/**
 * `POST /api/sprout {org, tree, bud, agent}`: start a leaf for the caller to
 * grow by hand. The answer carries the leaf's write token, once: the person
 * pushes with it, as an agent would.
 */
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Api from "../../../lib/api.ts";
import { attempt } from "../../../lib/run.ts";

const SproutRequest = Schema.Struct({
  org: Schema.NonEmptyString,
  tree: Schema.NonEmptyString,
  bud: Schema.Number,
  agent: Schema.NonEmptyString,
});

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(SproutRequest));

export const POST = async (request: Request) => {
  const asked = decode(await request.text());

  if (Option.isNone(asked)) {
    return Response.json({ error: "org, tree, bud and agent are required" }, { status: 400 });
  }

  const { org, tree, bud, agent } = asked.value;
  const grown = await attempt(Api.sprout(org, tree, bud, agent, crypto.randomUUID()));

  return Result.isSuccess(grown)
    ? Response.json(grown.success, { headers: { "cache-control": "no-store" } })
    : Response.json({ error: grown.failure.message }, { status: grown.failure.status });
};
