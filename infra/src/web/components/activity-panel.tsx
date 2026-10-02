"use client";

/**
 * "What happened", from Cloudflare's traces: polls /api/activity for an
 * operation's steps and draws them as a waterfall. Traces arrive about
 * 15-20 seconds after the work, so it waits, then fills in, then stops once
 * the trace has stopped growing.
 */
import { Badge, LayerCard, Loader, Text } from "@cloudflare/kumo";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

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

export function ActivityPanel({ org, operation }: { readonly org: string; readonly operation: string }) {
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

      setView(found.length === 0 ? { kind: "waiting" } : { kind: "steps", steps: found, settled });

      if (found.length === 0 && Date.now() - started > PATIENCE_MS) {
        setView({ kind: "unavailable", reason: "no trace arrived; it may have been sampled out" });

        return;
      }

      if (!settled) {
        setTimeout(poll, POLL_MS);
      }
    };

    void poll();

    return () => {
      stopped = true;
    };
  }, [org, operation]);

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-2">
        <span>What happened, from Cloudflare's traces</span>
        {view.kind === "steps" && !view.settled ? <Loader size={14} /> : null}
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-1">
        {view.kind === "waiting" ? (
          <span className="flex items-center gap-2">
            <Loader size={14} />
            <Text variant="secondary" as="span" size="sm">
              Waiting for the trace: Cloudflare makes it queryable about 15-20 seconds after the work.
            </Text>
          </span>
        ) : null}
        {view.kind === "unavailable" ? (
          <Text variant="secondary" size="sm">
            No trace to show: {view.reason}.
          </Text>
        ) : null}
        {view.kind === "steps" ? <Waterfall steps={view.steps} /> : null}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Waterfall({ steps }: { readonly steps: ReadonlyArray<Step> }) {
  const total = Math.max(1, ...steps.map((step) => step.offset + step.duration));

  return (
    <div className="flex flex-col gap-1">
      <Text variant="secondary" size="xs">
        {(total / 1000).toFixed(1)}s from the UI through the Api to the tree's Durable Object, one trace across
        Workers.
      </Text>
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
