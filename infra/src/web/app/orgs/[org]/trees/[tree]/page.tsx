import { Badge, Banner, Empty, Input, LayerCard, Link, Text } from "@cloudflare/kumo";
import { ActivityPanel } from "../../../../../components/activity-panel.tsx";
import { AutoRefresh } from "../../../../../components/auto-refresh.tsx";
import { Glossary } from "../../../../../components/glossary.tsx";
import { LayerCardPrimary, LayerCardSecondary } from "../../../../../components/kumo.ts";
import { OperationOutcome } from "../../../../../components/operation-outcome.tsx";
import { PageHeader } from "../../../../../components/page-header.tsx";
import { TONE_BADGE } from "../../../../../components/standing-badge.tsx";
import { SubmitButton } from "../../../../../components/submit-button.tsx";
import * as Api from "../../../../../lib/api.ts";
import { load } from "../../../../../lib/run.ts";
import { glance } from "../../../../../lib/standing.ts";
import { short } from "../../../../../lib/view.ts";
import { createBud } from "../../../../actions.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string }>;
  /** `planted` + `trace`: a plant just landed; `op`/`trace`/`error`: another change did. */
  readonly searchParams: Promise<{ planted?: string; trace?: string; op?: string; error?: string }>;
}

const GLANCE_WORDS = {
  winner: "ready to harvest",
  passing: "passing",
  ripening: "checks running",
  growing: "growing",
  failing: "failing",
  stale: "stale",
  fruit: "fruit",
  pruned: "pruned",
} as const;

export default async function TreePage({ params, searchParams }: Props) {
  const [{ org, tree: name }, { planted, trace, op, error }] = await Promise.all([params, searchParams]);
  const tree = await load(Api.showTree(org, name));
  const base = `/orgs/${org}/trees/${name}`;
  const buds = Object.values(tree.buds).toSorted((a, b) => b.id - a.id);
  const open = buds.filter((bud) => bud.state === "Open");
  const races = await Promise.all(open.map((bud) => load(Api.showBud(org, name, bud.id))));
  const harvested = buds.flatMap((bud) => (bud.state === "Open" ? [] : [{ bud, ...bud.state.Fruited }]));
  const head = tree.nodes[String(tree.head)];
  const headLeaf = head?.fruit_of === null || head === undefined ? undefined : tree.leaves[String(head.fruit_of)];
  const inFlight = races.some((race) => race.leaves.some(({ standing }) => standing === "Growing" || standing === "Ripening"));

  return (
    <>
      <PageHeader trail={[["Organizations", "/"], [org, `/orgs/${org}`]]} title={name}>
        <AutoRefresh active={inFlight} what="leaves are growing or being checked" />
      </PageHeader>
      {planted === undefined ? null : (
        <>
          <Banner title={`Planted ${name}`} description={`Its root is the default branch of ${planted}, at node 0.`} />
          {trace === undefined ? null : <ActivityPanel org={org} operation={trace} title={`Plant ${name}`} refused={false} />}
        </>
      )}
      {planted === undefined ? <OperationOutcome org={org} op={op} trace={trace} error={error} /> : null}
      <Glossary />

      <LayerCard>
        <LayerCardSecondary>The code now</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-wrap items-center justify-between gap-3">
          {head === undefined ? null : (
            <>
              <span className="flex flex-col gap-1">
                <Text size="sm">
                  Node {head.id} at <Text variant="mono">{short(head.commit)}</Text>
                </Text>
                <Text variant="secondary" size="xs">
                  {headLeaf === undefined
                    ? "The root, as planted."
                    : `The fruit of leaf ${headLeaf.id} (${headLeaf.agent}): "${tree.buds[String(headLeaf.bud)]?.intent ?? ""}".`}
                </Text>
              </span>
              <span className="flex gap-3">
                <Link href={`${base}/nodes/${head.id}`}>Browse the files</Link>
                {head.parent === null ? null : <Link href={`${base}/nodes/${head.id}#change`}>What changed</Link>}
              </span>
            </>
          )}
        </LayerCardPrimary>
      </LayerCard>

      <LayerCard>
        <LayerCardSecondary>Open buds: work in progress</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-3">
          {open.length === 0 ? (
            <Text variant="secondary" size="sm">
              Nothing open. Say what you want changed, and agents grow leaves for it.
            </Text>
          ) : null}
          {races.map((race) => (
            <div key={race.bud.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2">
              <Link href={`${base}/buds/${race.bud.id}`}>{race.bud.intent}</Link>
              <span className="flex flex-wrap gap-1">
                {race.leaves.length === 0 ? <Badge variant="outline">no leaves yet</Badge> : null}
                {glance(race).map(({ tone, count }) => (
                  <Badge key={tone} variant={TONE_BADGE[tone]} appearance="dot">
                    {count} {GLANCE_WORDS[tone]}
                  </Badge>
                ))}
              </span>
            </div>
          ))}
          <form action={createBud} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="tree" value={name} />
            <Input name="intent" label="New bud" placeholder="What should change? e.g. slugify should drop punctuation" className="min-w-96" required />
            <SubmitButton pending="Creating…">Create bud</SubmitButton>
          </form>
        </LayerCardPrimary>
      </LayerCard>

      <LayerCard>
        <LayerCardSecondary>Harvested: the trunk's history</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-2">
          {harvested.length === 0 ? <Empty size="sm" title="Nothing harvested yet" /> : null}
          {harvested.map(({ bud, leaf, node }) => (
            <div key={bud.id} className="flex flex-wrap items-center justify-between gap-2">
              <Link href={`${base}/buds/${bud.id}`}>{bud.intent}</Link>
              <Text variant="secondary" as="span" size="sm">
                leaf {leaf} ({tree.leaves[String(leaf)]?.agent ?? "?"}) → <Link href={`${base}/nodes/${node}`}>node {node}</Link>
              </Text>
            </div>
          ))}
          <Text variant="secondary" size="xs">
            The root is <Link href={`${base}/nodes/0`}>node 0</Link>. {tree.compost.length} earlier attempts are in the compost, on their buds' pages.
          </Text>
        </LayerCardPrimary>
      </LayerCard>
    </>
  );
}
