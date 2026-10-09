/**
 * When the trunk's commits landed, for the history's "2 hours ago": the
 * tree keeps no times of its own, but its head's log has every trunk commit.
 */
import * as Result from "effect/Result";
import * as Api from "./api.ts";
import { run } from "./run.ts";

/** As far back as the log reads in one page (src/tree/tree-object.ts `LOG_PAGE_MAX`). */
const TRUNK_DEPTH = 100;

/** Each commit's time, in seconds, by hash; empty when the log cannot be read, which leaves the times unsaid. */
export const commitTimes = async (org: string, tree: string, head: number): Promise<ReadonlyMap<string, number>> => {
  const log = await run(Api.log(org, tree, { kind: "nodes", id: head }, TRUNK_DEPTH));

  return new Map(Result.isSuccess(log) ? log.success.commits.map((commit) => [commit.hash, commit.committed_at] as const) : []);
};
