import { Banner, Input, LayerCard, Text } from "@cloudflare/kumo";
import * as Result from "effect/Result";
import { notFound } from "next/navigation";
import { AgentWork } from "../../../../../../../components/agent-work.tsx";
import { AutoRefresh } from "../../../../../../../components/auto-refresh.tsx";
import { DiffView } from "../../../../../../../components/diff-view.tsx";
import { ChainOfThought, ChainOfThoughtStep } from "../../../../../../../components/elements/chain-of-thought.tsx";
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
  LayerCardPrimary,
  LayerCardSecondary,
} from "../../../../../../../components/kumo.ts";
import { OperationOutcome } from "../../../../../../../components/operation-outcome.tsx";
import { PageHeader } from "../../../../../../../components/page-header.tsx";
import { RepoBrowser } from "../../../../../../../components/repo-browser.tsx";
import { ScoringSteps } from "../../../../../../../components/scoring-steps.tsx";
import { StandingBadge } from "../../../../../../../components/standing-badge.tsx";
import { SubmitButton } from "../../../../../../../components/submit-button.tsx";
import * as Api from "../../../../../../../lib/api.ts";
import { attempt, load } from "../../../../../../../lib/run.ts";
import { say } from "../../../../../../../lib/standing.ts";
import { timeline } from "../../../../../../../lib/timeline.ts";
import { regrowLeaf, submitLeaf, witherLeaf } from "../../../../../../actions.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string; leaf: string }>;
  readonly searchParams: Promise<{ path?: string; file?: string; op?: string; trace?: string; error?: string }>;
}

function Hidden({ org, tree, leaf }: { readonly org: string; readonly tree: string; readonly leaf: number }) {
  return (
    <>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="tree" value={tree} />
      <input type="hidden" name="leaf" value={leaf} />
    </>
  );
}

export default async function LeafPage({ params, searchParams }: Props) {
  const [{ org, tree, leaf: raw }, { path, file, op, trace, error }] = await Promise.all([params, searchParams]);
  const leaf = Number(raw);

  if (!Number.isInteger(leaf) || leaf < 0) {
    notFound();
  }

  const detail = await load(Api.showLeaf(org, tree, leaf));

  const [race, change, agent] = await Promise.all([
    load(Api.showBud(org, tree, detail.leaf.bud)),
    attempt(Api.diff(org, tree, { kind: "leaves", id: leaf })),
    attempt(Api.agentStatus(org, tree, leaf)),
  ]);

  const standing = race.leaves.find((entry) => entry.leaf.id === leaf)?.standing ?? "Growing";
  const base = `/orgs/${org}/trees/${tree}`;
  const state = detail.leaf.state;
  // Still in the race: it can be withdrawn, and moved on.
  const { tone } = say(standing);
  const live = tone !== "fruit" && tone !== "pruned";

  return (
    <>
      <PageHeader
        trail={[
          ["Organizations", "/"],
          [org, `/orgs/${org}`],
          [tree, base],
          [`bud ${detail.leaf.bud}`, `${base}/buds/${detail.leaf.bud}`],
        ]}
        title={`leaf ${leaf}: ${detail.leaf.agent}`}
      >
        <StandingBadge standing={standing} />
        <AutoRefresh active={standing === "Growing" || standing === "Ripening"} what="this leaf is still moving" />
      </PageHeader>
      <Text size="sm">{say(standing).sentence}</Text>
      <Text variant="secondary" size="sm">
        For: {race.bud.intent}
      </Text>
      <OperationOutcome org={org} op={op} trace={trace} error={error} />

      <ChainOfThought>
        {timeline(state, detail.leaf.base).map((moment) => (
          <ChainOfThoughtStep key={moment.label} status={moment.status} label={moment.label} />
        ))}
      </ChainOfThought>

      {live ? (
        <span className="flex flex-wrap items-end gap-3">
          {state === "Growing" ? (
            <form action={submitLeaf}>
              <Hidden org={org} tree={tree} leaf={leaf} />
              <SubmitButton pending="Submitting…">Submit for scoring</SubmitButton>
            </form>
          ) : null}
          {standing === "Stale" ? (
            <form action={regrowLeaf}>
              <Hidden org={org} tree={tree} leaf={leaf} />
              <SubmitButton pending="Regrowing…">Regrow on the head</SubmitButton>
            </form>
          ) : null}
          <form action={witherLeaf} className="flex flex-wrap items-end gap-2">
            <Hidden org={org} tree={tree} leaf={leaf} />
            <Input name="note" label="Withdraw it" placeholder="why (kept in the compost)" size="sm" />
            <SubmitButton pending="Withering…" variant="secondary-destructive">
              Wither
            </SubmitButton>
          </form>
        </span>
      ) : null}

      {Result.isSuccess(agent) ? (
        <LayerCard>
          <LayerCardSecondary>The agent at work</LayerCardSecondary>
          <LayerCardPrimary>
            <AgentWork status={agent.success} />
          </LayerCardPrimary>
        </LayerCard>
      ) : null}

      <section id="change" className="flex flex-col gap-3">
        <Text variant="heading" as="h3">
          The change
        </Text>
        {Result.isSuccess(change) ? (
          <DiffView diff={change.success} />
        ) : (
          <Banner variant="secondary" description={`The change cannot be shown: ${change.failure.message}`} />
        )}
      </section>

      {detail.scoring === undefined || detail.scoring === null || detail.scoring.entries.length === 0 ? null : (
        <LayerCard>
          <LayerCardSecondary>Scoring, in its sandbox</LayerCardSecondary>
          <LayerCardPrimary>
            <ScoringSteps ledger={detail.scoring} />
          </LayerCardPrimary>
        </LayerCard>
      )}
      <LayerCard>
        <LayerCardSecondary>Checks</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-2">
          {detail.report === null ? (
            <Text variant="secondary" size="sm">
              Not scored yet: the root's checks run once the leaf is submitted.
            </Text>
          ) : (
            detail.report.checks.map((check) => (
              <CollapsibleRoot key={check.name}>
                <CollapsibleTrigger>
                  <span className={check.passed ? "text-kumo-success" : "text-kumo-danger"}>
                    {check.passed ? "Passed" : "Failed"}: {check.name} · {(check.millis / 1000).toFixed(1)} s
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-kumo-recessed p-3 font-mono text-xs text-kumo-default">
                    {check.tail || "(no output)"}
                  </pre>
                </CollapsiblePanel>
              </CollapsibleRoot>
            ))
          )}
        </LayerCardPrimary>
      </LayerCard>

      <Text variant="heading" as="h3">
        Files
      </Text>
      <RepoBrowser org={org} tree={tree} subject={{ kind: "leaves", id: leaf }} here={`${base}/leaves/${leaf}`} path={path ?? ""} file={file} />
    </>
  );
}
