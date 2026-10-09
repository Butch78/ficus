/**
 * What the agents at work report now, asked of the tree for each attempt an
 * agent is working (src/agents/actor.ts `#status`, via the tree Worker).
 */
import * as Result from "effect/Result";
import * as Api from "./api.ts";
import { run } from "./run.ts";

/** Each attempt's agent status; undefined where it cannot be read, which leaves the page saying less. */
export const agentStatuses = async (org: string, tree: string, attempts: ReadonlyArray<number>) =>
  new Map(
    await Promise.all(
      attempts.map(async (attempt) => {
        const status = await run(Api.agentStatus(org, tree, attempt));

        return [attempt, Result.isSuccess(status) ? status.success : undefined] as const;
      }),
    ),
  );
