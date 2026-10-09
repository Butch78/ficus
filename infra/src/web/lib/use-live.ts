/**
 * Live parts of a page through TanStack Query: seeded with what the server
 * rendered, asked for again from `/api/live` only while they move, shared by
 * every component on the page under one key. When a part stops moving (an
 * attempt scored, an agent done), the page's server parts refresh once, so
 * what depends on it (the trunk, the case for accepting) catches up.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { liveKey, liveUrl, LiveRace, raceMoving, type LiveAsk } from "./live.ts";

/** How often a moving part is asked for again. */
export const LIVE_EVERY_MS = 3000;

/** Ask `/api/live` for `ask`, decoded as `schema`. */
const fetchLive = <A>(ask: LiveAsk, schema: Schema.Decoder<A>) => async () => {
  const response = await fetch(liveUrl(ask), { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`live ${ask.kind} ${ask.id}: HTTP ${response.status}`);
  }

  return Schema.decodeUnknownSync(schema)(await response.json());
};

/** Refresh the page's server parts once when something that moved stops. */
const useRefreshWhenSettled = (moving: boolean) => {
  const router = useRouter();
  const was = useRef(moving);

  useEffect(() => {
    if (was.current && !moving) {
      router.refresh();
    }

    was.current = moving;
  }, [moving, router]);
};

/** One live part: `initial` until the browser has asked, then fresh every few seconds while `moving` says so. */
export const useLive = <A>(ask: LiveAsk, schema: Schema.Decoder<A>, initial: A, moving: (value: A) => boolean): A => {
  const { data } = useQuery({
    queryKey: liveKey(ask),
    queryFn: fetchLive(ask, schema),
    initialData: initial,
    refetchInterval: (query) => (moving(query.state.data ?? initial) ? LIVE_EVERY_MS : false),
  });

  const value = data ?? initial;

  useRefreshWhenSettled(moving(value));

  return value;
};

/** Several tasks' races at once (the tree page's growing cards), each its own cache entry. */
export const useLiveRaces = (org: string, tree: string, initial: ReadonlyArray<LiveRace>): ReadonlyArray<LiveRace> => {
  const races = useQueries({
    queries: initial.map((seed) => {
      const ask: LiveAsk = { kind: "race", org, tree, id: seed.race.task.id };

      return {
        queryKey: liveKey(ask),
        queryFn: fetchLive(ask, LiveRace),
        initialData: seed,
        refetchInterval: (query: { readonly state: { readonly data: LiveRace | undefined } }) => (raceMoving(query.state.data ?? seed) ? LIVE_EVERY_MS : false),
      };
    }),
    combine: (results): ReadonlyArray<LiveRace> => results.flatMap((result) => (result.data === undefined ? [] : [result.data])),
  });

  useRefreshWhenSettled(races.some(raceMoving));

  return races;
};
