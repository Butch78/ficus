"use client";

/**
 * Plant a tree and watch it happen: the tree streams each step as it starts
 * and ends (lib/plant-progress.ts), shown like an agent's task — a line for
 * the whole plant, the steps ticking off under it. On success it moves on to
 * the tree, whose page replays the plant's Cloudflare trace.
 */
import { Banner, Button, Input, Loader } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import {
  apply,
  connected,
  description,
  label,
  PLANT_STEPS,
  type PlantProgress,
  refused,
  split,
  started,
  type StepProgress,
} from "../lib/plant-progress.ts";
import { ActivityPanel } from "./activity-panel.tsx";
import { ChainOfThought, ChainOfThoughtStep } from "./elements/chain-of-thought.tsx";
import { Task, TaskContent, TaskTrigger } from "./elements/task.tsx";

const Refusal = Schema.Struct({ error: Schema.String });

const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Refusal));

const field = (form: FormData, name: string) => {
  const value = form.get(name);

  return value instanceof File ? "" : (value ?? "").trim();
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

interface Planting {
  readonly tree: string;
  readonly source: string;
  readonly operation: string;
  readonly startedAt: number;
  readonly progress: PlantProgress;
}

/** Re-renders every half second while something is running, for the clocks. */
const useNow = (running: boolean) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 500);

    return () => clearInterval(timer);
  }, [running]);

  return now;
};

const elapsed = (step: StepProgress, now: number) =>
  step.startedAt === undefined ? undefined : seconds((step.endedAt ?? now) - step.startedAt);

export function PlantForm({ org }: { readonly org: string }) {
  const router = useRouter();
  const [planting, setPlanting] = useState<Planting | undefined>(undefined);
  const running = planting !== undefined && planting.progress.outcome === undefined;
  const now = useNow(running);

  const advance = (change: (progress: PlantProgress) => PlantProgress) =>
    setPlanting((current) => (current === undefined ? current : { ...current, progress: change(current.progress) }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const tree = field(form, "tree");
    const source = field(form, "source");
    const operation = crypto.randomUUID();

    setPlanting({ tree, source, operation, startedAt: Date.now(), progress: started(Date.now()) });

    const response = await fetch("/api/plant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org, tree, source, operation }),
    });

    if (!response.ok || response.body === null) {
      const text = await response.text();
      const why = Option.match(decodeRefusal(text), { onNone: () => `HTTP ${response.status}`, onSome: (body) => body.error });

      advance((progress) => refused(progress, why, Date.now()));

      return;
    }

    // The stream's own copy of the progress; React's follows it.
    let progress = connected(started(Date.now()), Date.now());

    advance(() => progress);

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const { lines, rest } = split(buffer + chunk.value);

      buffer = rest;
      progress = lines.reduce((current, line) => apply(current, line, Date.now()), progress);

      const now = progress;

      advance(() => now);
    }

    if (progress.outcome?.succeeded === true) {
      // A beat to see every step ticked, then the tree.
      setTimeout(() => {
        router.push(
          `/orgs/${encodeURIComponent(org)}/trees/${encodeURIComponent(tree)}?${new URLSearchParams({ planted: source, trace: operation }).toString()}`,
        );
      }, 900);
    }
  };

  const outcome = planting?.progress.outcome;

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Input name="tree" label="Name" placeholder="site" pattern="[A-Za-z0-9._\-]{1,40}" required />
        <Input name="source" type="url" label="Source" placeholder="https://github.com/owner/repo" className="min-w-80" required />
        <Button type="submit" variant="primary" loading={running} disabled={running}>
          {running ? "Planting…" : "Plant"}
        </Button>
      </form>
      {planting === undefined ? null : (
        <Task>
          <TaskTrigger
            icon={
              running ? (
                <Loader size={14} />
              ) : outcome?.succeeded === true ? (
                <CheckCircleIcon size={16} className="text-kumo-success" />
              ) : (
                <WarningCircleIcon size={16} className="text-kumo-danger" />
              )
            }
            title={running ? `Planting ${planting.tree}` : outcome?.succeeded === true ? `Planted ${planting.tree}` : `Could not plant ${planting.tree}`}
            detail={seconds(now - planting.startedAt)}
          />
          <TaskContent>
            <ChainOfThought>
              {PLANT_STEPS.map((step) => {
                const state = planting.progress.steps.get(step);

                if (state === undefined) {
                  return null;
                }

                return (
                  <ChainOfThoughtStep
                    key={step}
                    status={state.status}
                    label={label(step, state.status, { org, source: planting.source })}
                    description={description(step, state)}
                    aside={elapsed(state, now)}
                  />
                );
              })}
            </ChainOfThought>
          </TaskContent>
        </Task>
      )}
      {outcome === undefined || outcome.succeeded ? null : (
        <>
          <Banner variant="error" title={`Could not plant ${planting?.tree ?? "the tree"}`} description={outcome.message} />
          {planting === undefined ? null : (
            <ActivityPanel org={org} operation={planting.operation} title={`Plant ${planting.tree}`} refused />
          )}
        </>
      )}
    </div>
  );
}
