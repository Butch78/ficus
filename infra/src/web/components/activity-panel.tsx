"use client";

/**
 * What an operation did, from its Cloudflare trace, shown like an agent's
 * task (AI Elements' Task and ChainOfThought, ported to Kumo): one line,
 * which opens to the steps in words, which open to the raw spans. Traces arrive about 15-20 seconds after the work, so it waits,
 * then fills in, then stops once the trace has stopped growing.
 */
import { Badge, LayerCard, Loader, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { narrate } from "../lib/activity.ts";
import { ChainOfThought, ChainOfThoughtStep } from "./elements/chain-of-thought.tsx";
import { Task, TaskContent, TaskTrigger } from "./elements/task.tsx";

const Step = Schema.Struct({
  id: Schema.String,
  depth: Schema.Number,
  where: Schema.String,
  label: Schema.String,
  offset: Schema.Number,
  duration: Schema.Number,
  count: Schema.Number,
  failed: Schema.Boolean,
});

type Step = typeof Step.Type;

const Answer = Schema.Union([
  Schema.Struct({ steps: Schema.Array(Step) }),
  Schema.Struct({ error: Schema.String }),
]);

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

const POLL_MS = 3000;

/** Give up waiting for a first span after this long. */
const PATIENCE_MS = 90_000;

/**
 * Polls with the same span count, after the first, before the trace counts
 * as whole. A Durable Object's spans land after the rest, so this is long.
 */
const SETTLED = 8;

const WHERE = { UI: "blue", Api: "purple", Tree: "green", Sandbox: "orange" } as const;

const badgeFor = (where: string) =>
  where === "UI" || where === "Api" || where === "Tree" || where === "Sandbox" ? WHERE[where] : "neutral";

type View =
  | { readonly kind: "waiting" }
  | { readonly kind: "steps"; readonly steps: ReadonlyArray<Step>; readonly settled: boolean }
  | { readonly kind: "unavailable"; readonly reason: string };

interface Props {
  readonly org: string;
  readonly operation: string;
  /** What the operation was, as its one line: "Plant site". */
  readonly title: string;
  /** Whether the Api accepted it; a refusal still has a trace worth reading. */
  readonly refused: boolean;
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The one line's tail: how long it took, or why that is not known yet. */
const status = (view: View, total: number | undefined) => {
  if (view.kind === "waiting") {
    return "reading its trace from Cloudflare (about 20 s)";
  }

  return view.kind === "unavailable" ? "no trace" : seconds(total ?? 0);
};

/**
 * One line, like an agent's tool call: what was done, whether it worked,
 * how long it took. Open it for what happened in words; open "spans" for
 * the trace itself.
 */
export function ActivityPanel({ org, operation, title, refused }: Props) {
  const view = useTrace(org, operation);
  const found = view.kind === "steps" ? view.steps : [];
  // The whole trace's extent: a streamed operation's own span closes as soon
  // as its response starts, long before the work under it is done.
  const total = found.length === 0 ? undefined : Math.max(...found.map((step) => step.offset + step.duration));

  return (
    <LayerCard>
      <LayerCard.Primary className="py-3">
        <Task defaultOpen={false}>
          <TaskTrigger
            icon={
              view.kind === "waiting" ? (
                <Loader size={14} />
              ) : refused ? (
                <WarningCircleIcon size={16} className="text-kumo-danger" />
              ) : (
                <CheckCircleIcon size={16} className="text-kumo-success" />
              )
            }
            title={title}
            detail={status(view, total)}
          />
          <TaskContent>
            {view.kind === "waiting" ? (
              <Text variant="secondary" size="sm">
                Cloudflare makes a trace readable about 15-20 seconds after the work; this fills in when it does.
              </Text>
            ) : null}
            {view.kind === "unavailable" ? (
              <Text variant="secondary" size="sm">
                No trace to show: {view.reason}.
              </Text>
            ) : null}
            {view.kind === "steps" ? (
              <>
                <ChainOfThought>
                  {narrate(view.steps).map((sentence) => (
                    <ChainOfThoughtStep
                      key={`${sentence.offset}-${sentence.text}`}
                      status={sentence.failed ? "error" : "complete"}
                      label={sentence.text}
                      aside={seconds(sentence.duration)}
                    />
                  ))}
                  {view.settled ? null : <ChainOfThoughtStep status="active" label="More of the trace may still arrive" />}
                </ChainOfThought>
                <Task defaultOpen={false}>
                  <TaskTrigger title={`Spans (${view.steps.length})`} detail="as Cloudflare traced them" />
                  <TaskContent>
                    <Waterfall steps={view.steps} />
                  </TaskContent>
                </Task>
              </>
            ) : null}
          </TaskContent>
        </Task>
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** Polls /api/activity until the operation's trace has stopped growing. */
function useTrace(org: string, operation: string) {
  const [view, setView] = useState<View>({ kind: "waiting" });

  useEffect(() => {
    let stopped = false;
    let unchanged = 0;
    let last = -1;
    const started = Date.now();

    const poll = async () => {
      const response = await fetch(`/api/activity?${new URLSearchParams({ org, op: operation }).toString()}`);
      const answer = decode(await response.text());

      if (stopped) {
        return;
      }

      if (Option.isNone(answer)) {
        setView({ kind: "unavailable", reason: `the activity route answered ${response.status}` });

        return;
      }

      if ("error" in answer.value) {
        setView({ kind: "unavailable", reason: answer.value.error });

        return;
      }

      const found = answer.value.steps;

      unchanged = found.length > 0 && found.length === last ? unchanged + 1 : 0;
      last = found.length;

      const settled = unchanged >= SETTLED;

      if (found.length === 0 && Date.now() - started > PATIENCE_MS) {
        setView({ kind: "unavailable", reason: "no trace arrived; it may have been sampled out" });

        return;
      }

      setView(found.length === 0 ? { kind: "waiting" } : { kind: "steps", steps: found, settled });

      if (!settled) {
        setTimeout(poll, POLL_MS);
      }
    };

    void poll();

    return () => {
      stopped = true;
    };
  }, [org, operation]);

  return view;
}

function Waterfall({ steps }: { readonly steps: ReadonlyArray<Step> }) {
  const total = Math.max(1, ...steps.map((step) => step.offset + step.duration));

  return (
    <div className="flex flex-col gap-1">
      {steps.map((step) => (
        <div key={step.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4rem] items-center gap-3">
          <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${Math.min(step.depth, 8) * 0.75}rem` }}>
            <Badge variant={badgeFor(step.where)}>{step.where}</Badge>
            <Text as="span" size="sm" truncate>
              {step.label}
            </Text>
            {step.count > 1 ? (
              <Text variant="secondary" as="span" size="xs">
                ×{step.count}
              </Text>
            ) : null}
          </span>
          <span className="relative h-2 rounded-full bg-kumo-recessed">
            <span
              className={step.failed ? "absolute h-2 rounded-full bg-kumo-danger" : "absolute h-2 rounded-full bg-kumo-brand"}
              style={{
                left: `${(step.offset / total) * 100}%`,
                width: `${Math.max(0.5, (step.duration / total) * 100)}%`,
              }}
            />
          </span>
          <Text variant="secondary" as="span" size="xs">
            {step.duration < 1000 ? `${step.duration} ms` : `${(step.duration / 1000).toFixed(1)} s`}
          </Text>
        </div>
      ))}
    </div>
  );
}
