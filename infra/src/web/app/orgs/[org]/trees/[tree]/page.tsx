import { Badge, Empty, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import { LeafStatus } from "../../../../../components/leaf-status.tsx";
import { PageHeader } from "../../../../../components/page-header.tsx";
import * as Api from "../../../../../lib/api.ts";
import { load } from "../../../../../lib/run.ts";
import { buds, pruneReason, short, trunk } from "../../../../../lib/view.ts";
import { LayerCardPrimary, LayerCardSecondary, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../../../components/kumo.ts";

export const dynamic = "force-dynamic";

export default async function TreePage({ params }: { readonly params: Promise<{ org: string; tree: string }> }) {
  const { org, tree: name } = await params;
  const tree = await load(Api.showTree(org, name));
  const base = `/orgs/${org}/trees/${name}`;
  const budViews = buds(tree);

  return (
    <>
      <PageHeader
        trail={[
          ["Organizations", "/"],
          [org, `/orgs/${org}`],
        ]}
        title={name}
      />
      <LayerCard>
        <LayerCardSecondary>Trunk: the root, then one node per harvested bud</LayerCardSecondary>
        <LayerCardPrimary className="p-0">
          <Table>
            <TableBody>
              {trunk(tree).map((node) => (
                <TableRow key={node.id}>
                  <TableCell>
                    <Link href={`${base}/nodes/${node.id}`}>node {node.id}</Link>
                  </TableCell>
                  <TableCell>
                    <Text variant="mono-secondary">
                      {short(node.commit)}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text variant="secondary" as="span" size="sm">
                      {node.fruit_of === null ? "root" : `fruit of leaf ${node.fruit_of}`}
                    </Text>
                  </TableCell>
                  <TableCell>{node.id === tree.head ? <Badge variant="primary">head</Badge> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </LayerCardPrimary>
      </LayerCard>
      <Text variant="heading" as="h3">
        Buds
      </Text>
      {budViews.length === 0 ? (
        <Empty title="No buds yet" description="A bud is an intent; agents grow leaves for it through the Api." />
      ) : null}
      {budViews.map(({ bud, leaves, fruit }) => (
        <LayerCard key={bud.id}>
          <LayerCardSecondary className="flex flex-wrap items-center justify-between gap-2">
            <span>
              bud {bud.id}: {bud.intent}
            </span>
            {fruit === undefined ? (
              <Badge variant="outline">open</Badge>
            ) : (
              <Link href={`${base}/nodes/${fruit}`}>
                <Badge variant="green">harvested into node {fruit}</Badge>
              </Link>
            )}
          </LayerCardSecondary>
          <LayerCardPrimary className="p-0">
            {leaves.length === 0 ? (
              <Empty size="sm" title="No leaves yet" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Leaf</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Grew from</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leaves.map((leaf) => (
                    <TableRow key={leaf.id}>
                      <TableCell>
                        <Link href={`${base}/leaves/${leaf.id}`}>leaf {leaf.id}</Link>
                      </TableCell>
                      <TableCell>{leaf.agent}</TableCell>
                      <TableCell>
                        <Text variant="secondary" as="span" size="sm">
                          node {leaf.base}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <LeafStatus state={leaf.state} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </LayerCardPrimary>
        </LayerCard>
      ))}
      <Text variant="heading" as="h3">
        Compost
      </Text>
      {tree.compost.length === 0 ? (
        <Empty size="sm" title="Nothing pruned yet" />
      ) : (
        <LayerCard>
          <LayerCardPrimary className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Leaf</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Why it lost</TableHead>
                  <TableHead>Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tree.compost.map((entry) => (
                  <TableRow key={entry.leaf}>
                    <TableCell>
                      <Link href={`${base}/leaves/${entry.leaf}`}>leaf {entry.leaf}</Link>
                    </TableCell>
                    <TableCell>
                      {entry.agent}, bud {entry.bud}
                    </TableCell>
                    <TableCell>{pruneReason(entry.reason)}</TableCell>
                    <TableCell>
                      <Text variant="secondary" as="span" size="sm">
                        {entry.score === null
                          ? "not scored"
                          : `${entry.score.checks_passed}/${entry.score.checks_total}, cost ${entry.score.cost}`}
                      </Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </LayerCardPrimary>
        </LayerCard>
      )}
    </>
  );
}
