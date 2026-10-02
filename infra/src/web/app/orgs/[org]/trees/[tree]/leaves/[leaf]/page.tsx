import { Badge, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { notFound } from "next/navigation";
import { LeafStatus } from "../../../../../../../components/leaf-status.tsx";
import { PageHeader } from "../../../../../../../components/page-header.tsx";
import { RepoBrowser } from "../../../../../../../components/repo-browser.tsx";
import * as Api from "../../../../../../../lib/api.ts";
import { load } from "../../../../../../../lib/run.ts";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger, LayerCardPrimary, LayerCardSecondary } from "../../../../../../../components/kumo.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string; leaf: string }>;
  readonly searchParams: Promise<{ path?: string; file?: string }>;
}

export default async function LeafPage({ params, searchParams }: Props) {
  const [{ org, tree, leaf: raw }, { path, file }] = await Promise.all([params, searchParams]);
  const leaf = Number(raw);

  if (!Number.isInteger(leaf) || leaf < 0) {
    notFound();
  }

  const detail = await load(Api.showLeaf(org, tree, leaf));
  const base = `/orgs/${org}/trees/${tree}`;

  return (
    <>
      <PageHeader
        trail={[
          ["Organizations", "/"],
          [org, `/orgs/${org}`],
          [tree, base],
        ]}
        title={`leaf ${leaf}: ${detail.leaf.agent}`}
      />
      <div className="flex flex-col gap-1">
        <LeafStatus state={detail.leaf.state} />
        <Text variant="secondary" size="sm">
          Bud {detail.leaf.bud}, grown from node {detail.leaf.base}.
        </Text>
      </div>
      <LayerCard>
        <LayerCardSecondary className="flex items-center justify-between">
          <span>Scoring report</span>
          {detail.report === null ? null : <Badge variant="outline">cost {detail.report.cost}</Badge>}
        </LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-2">
          {detail.report === null ? (
            <Empty size="sm" title="Not scored yet" description="The root's checks run once the leaf is submitted." />
          ) : (
            detail.report.checks.map((check) => (
              <CollapsibleRoot key={check.name}>
                <CollapsibleTrigger>
                  <span className="inline-flex items-center gap-2">
                    <Badge variant={check.passed ? "success" : "error"}>{check.passed ? "passed" : "failed"}</Badge>
                    <Text variant="mono">
                      {check.name}
                    </Text>
                    <Text variant="secondary" as="span" size="sm">
                      {(check.millis / 1000).toFixed(1)}s
                    </Text>
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-kumo-recessed p-3 font-mono text-sm text-kumo-default">
                    {check.tail || "(no output)"}
                  </pre>
                </CollapsiblePanel>
              </CollapsibleRoot>
            ))
          )}
        </LayerCardPrimary>
      </LayerCard>
      <RepoBrowser
        org={org}
        tree={tree}
        subject={{ kind: "leaves", id: leaf }}
        here={`${base}/leaves/${leaf}`}
        path={path ?? ""}
        file={file}
      />
    </>
  );
}
