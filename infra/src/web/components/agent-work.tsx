/**
 * An agent at work on its attempt, like an assistant's tool calls: each read,
 * edit and command it ran, and whether it worked, then its last words. From
 * the agent's own transcript (src/agents/activity.ts), via the tree.
 */
import { Badge, Text } from "@cloudflare/kumo";
import type { AgentStatus } from "../lib/answers.ts";
import { ChainOfThought, ChainOfThoughtStep } from "./elements/chain-of-thought.tsx";

const STATE_WORDS = {
  working: "working",
  submitted: "submitted",
  stopped: "stopped without submitting",
  failed: "failed",
  unassigned: "never started",
} as const satisfies Record<AgentStatus["state"], string>;

const STATE_BADGE = {
  working: "neutral",
  submitted: "success",
  stopped: "warning",
  failed: "error",
  unassigned: "warning",
} as const satisfies Record<AgentStatus["state"], string>;

const STEP = { running: "active", ok: "complete", error: "error" } as const;

export function AgentWork({ status, compact = false }: { readonly status: AgentStatus; readonly compact?: boolean }) {
  if (compact) {
    const last = status.calls.at(-1);

    return (
      <Text variant="secondary" size="xs">
        {last === undefined ? `${status.model}: starting` : `${last.tool}: ${last.summary}`}
      </Text>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={STATE_BADGE[status.state]} appearance="dot">
          {STATE_WORDS[status.state]}
        </Badge>
        <Text variant="mono-secondary">{status.model}</Text>
      </span>
      {status.reason === undefined ? null : <Text size="sm">{status.reason}</Text>}
      {status.calls.length === 0 ? (
        <Text variant="secondary" size="sm">
          No tool calls yet: the agent is reading its task.
        </Text>
      ) : (
        <ChainOfThought>
          {status.calls.map((call) => (
            <ChainOfThoughtStep key={call.id} status={STEP[call.state]} label={`${call.tool}: ${call.summary}`} />
          ))}
        </ChainOfThought>
      )}
      {status.lastWords === undefined ? null : (
        <blockquote className="border-l-2 border-kumo-hairline pl-3">
          <Text size="sm">{status.lastWords}</Text>
        </blockquote>
      )}
    </div>
  );
}
