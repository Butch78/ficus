/**
 * `GET /api/live?kind=&org=&tree=&id=`: one live part of a page, fresh, for
 * the browser's TanStack Query (lib/live.ts): a task's race with what its
 * working agents report, an attempt's agent, or an attempt. Asked with the
 * caller's session, so it answers exactly what the page itself may show.
 */
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { agentStatuses } from "../../../lib/agents.ts";
import * as Api from "../../../lib/api.ts";
import { agentAttempts } from "../../../lib/growing.ts";
import { LiveAsk, toLive, type LiveAsk as Ask } from "../../../lib/live.ts";
import { run } from "../../../lib/run.ts";

const decodeAsk = Schema.decodeUnknownOption(LiveAsk);

const NO_STORE = { "cache-control": "no-store" };

const answer = (outcome: Result.Result<unknown, Api.ApiError>) =>
  Result.isSuccess(outcome)
    ? Response.json(outcome.success, { headers: NO_STORE })
    : Response.json({ error: outcome.failure.message }, { status: outcome.failure.status, headers: NO_STORE });

const race = async ({ org, tree, id }: Ask) => {
  const shown = await run(Api.showTask(org, tree, id));

  if (Result.isFailure(shown)) {
    return shown;
  }

  return Result.succeed(toLive(shown.success, await agentStatuses(org, tree, agentAttempts([shown.success]))));
};

const ASKERS = {
  race,
  agent: ({ org, tree, id }: Ask) => run(Api.agentStatus(org, tree, id)),
  attempt: ({ org, tree, id }: Ask) => run(Api.showAttempt(org, tree, id)),
} as const;

export const GET = async (request: Request) => {
  const asked = decodeAsk(Object.fromEntries(new URL(request.url).searchParams));

  if (Option.isNone(asked)) {
    return Response.json({ error: "kind (race, agent or attempt), org, tree and id are required" }, { status: 400, headers: NO_STORE });
  }

  return answer(await ASKERS[asked.value.kind](asked.value));
};
