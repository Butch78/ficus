/**
 * `POST /api/init {org, tree, source | github, operation}`: init from a public
 * git remote, or from a GitHub repo (GitHub's id) through the Ficus GitHub
 * App, and stream its
 * progress back as it happens (one JSON object per line). A refusal before
 * any progress (not signed in, not a member) is a JSON `{error}` with its
 * status.
 */
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Api from "../../../lib/api.ts";
import { run } from "../../../lib/run.ts";

const InitRequest = Schema.Struct({
  org: Schema.NonEmptyString,
  tree: Schema.NonEmptyString,
  source: Schema.optional(Schema.NonEmptyString),
  github: Schema.optional(Schema.Number),
  operation: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
});

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(InitRequest));

export const POST = async (request: Request) => {
  const asked = decode(await request.text());

  const from: Api.InitSource | undefined = Option.match(asked, {
    onNone: () => undefined,
    onSome: ({ source, github }) => (github !== undefined ? { github } : source !== undefined ? { source } : undefined),
  });

  if (Option.isNone(asked) || from === undefined) {
    return Response.json({ error: "org, tree, a source or a GitHub repo, and an operation id are required" }, { status: 400 });
  }

  const { org, tree, operation } = asked.value;
  const answer = await run(Api.init(org, tree, from, operation));

  if (Result.isFailure(answer)) {
    return Response.json({ error: answer.failure.message }, { status: answer.failure.status });
  }

  return new Response(answer.success.body, {
    headers: { "content-type": Api.PROGRESS, "cache-control": "no-store" },
  });
};
