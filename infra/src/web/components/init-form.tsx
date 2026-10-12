"use client";

/**
 * Init a tree and watch it happen: the tree streams each step as it starts
 * and ends (lib/init-progress.ts), shown like an agent's task — a line for
 * the whole init, the steps ticking off under it. On success it moves on to
 * the tree, whose page replays the init's Cloudflare trace.
 *
 * Given `repositories` (the GitHub repos the person can add through the Ficus
 * GitHub App), it picks one of them instead of taking a remote, and names the
 * tree after it.
 */
import { Banner, Button, Input, Loader, Select } from "@cloudflare/kumo";
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
  INIT_STEPS,
  type InitProgress,
  refused,
  split,
  started,
  type StepProgress,
} from "../lib/init-progress.ts";
import type { GitHubRepository } from "../lib/answers.ts";
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

interface Initializing {
  readonly tree: string;
  readonly source: string;
  readonly operation: string;
  readonly startedAt: number;
  readonly progress: InitProgress;
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

interface Props {
  readonly org: string;
  /** Pick from these GitHub repos instead of taking a remote. */
  readonly repositories?: ReadonlyArray<GitHubRepository>;
}

/** A tree's name from a repo's: what GitHub allows in one, Ficus allows in the other. */
const treeNameOf = (repository: GitHubRepository) => repository.full_name.split("/").at(-1) ?? repository.full_name;

const submitLabel = (running: boolean, fromGitHub: boolean) => {
  if (running) {
    return "Initializing…";
  }

  return fromGitHub ? "Add" : "Init";
};

/** A repo's line in the picker: its name, and whether it is private. */
const repoLabel = (repository: GitHubRepository) => (repository.private ? `${repository.full_name} (private)` : repository.full_name);

interface PickerProps {
  readonly repositories: ReadonlyArray<GitHubRepository>;
  readonly picked: GitHubRepository | undefined;
  readonly onPick: (repository: GitHubRepository) => void;
}

/** One of the person's GitHub repos. */
function RepoPicker({ repositories, picked, onPick }: PickerProps) {
  return (
    <Select
      label="Repository"
      className="min-w-80"
      placeholder="Choose a repo"
      value={picked === undefined ? null : String(picked.id)}
      onValueChange={(value) => {
        const repository = repositories.find((candidate) => String(candidate.id) === value);

        if (repository !== undefined) {
          onPick(repository);
        }
      }}
      items={repositories.map((repository) => ({ value: String(repository.id), label: repoLabel(repository) }))}
    />
  );
}

export function InitForm({ org, repositories }: Props) {
  const router = useRouter();
  const [initializing, setInitializing] = useState<Initializing | undefined>(undefined);
  const [picked, setPicked] = useState<GitHubRepository | undefined>(undefined);
  const [name, setName] = useState("");
  const running = initializing !== undefined && initializing.progress.outcome === undefined;
  const now = useNow(running);

  const advance = (change: (progress: InitProgress) => InitProgress) =>
    setInitializing((current) => (current === undefined ? current : { ...current, progress: change(current.progress) }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const tree = field(form, "tree");

    if (repositories !== undefined && picked === undefined) {
      return;
    }

    // What the steps say it came from; a GitHub repo travels by its id.
    const source = picked === undefined ? field(form, "source") : `https://github.com/${picked.full_name}`;
    const from = picked === undefined ? { source } : { github: picked.id };
    const operation = crypto.randomUUID();

    setInitializing({ tree, source, operation, startedAt: Date.now(), progress: started(Date.now()) });

    const response = await fetch("/api/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org, tree, operation, ...from }),
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
          `/orgs/${encodeURIComponent(org)}/trees/${encodeURIComponent(tree)}?${new URLSearchParams({ initialized: source, trace: operation }).toString()}`,
        );
      }, 900);
    }
  };

  const outcome = initializing?.progress.outcome;

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        {repositories === undefined ? (
          <Input name="source" type="url" label="Source" placeholder="https://github.com/owner/repo" className="min-w-80" required />
        ) : (
          <RepoPicker
            repositories={repositories}
            picked={picked}
            onPick={(repository) => {
              setPicked(repository);
              setName(treeNameOf(repository));
            }}
          />
        )}
        <Input name="tree" label="Name" placeholder="site" pattern="[A-Za-z0-9._\-]{1,40}" value={name} onChange={(event) => setName(event.target.value)} required />
        <Button type="submit" variant="primary" loading={running} disabled={running || (repositories !== undefined && picked === undefined)}>
          {submitLabel(running, repositories !== undefined)}
        </Button>
      </form>
      {initializing === undefined ? null : (
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
            title={running ? `Initializing ${initializing.tree}` : outcome?.succeeded === true ? `Initialized ${initializing.tree}` : `Could not init ${initializing.tree}`}
            detail={seconds(now - initializing.startedAt)}
          />
          <TaskContent>
            <ChainOfThought>
              {INIT_STEPS.map((step) => {
                const state = initializing.progress.steps.get(step);

                if (state === undefined) {
                  return null;
                }

                return (
                  <ChainOfThoughtStep
                    key={step}
                    status={state.status}
                    label={label(step, state.status, { org, source: initializing.source })}
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
          <Banner variant="error" title={`Could not init ${initializing?.tree ?? "the tree"}`} description={outcome.message} />
          {initializing === undefined ? null : (
            <ActivityPanel org={org} operation={initializing.operation} title={`Init ${initializing.tree}`} refused />
          )}
        </>
      )}
    </div>
  );
}
