import { Empty, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import { FailureBanner } from "../../../components/failure-banner.tsx";
import { PageHeader } from "../../../components/page-header.tsx";
import { InitForm } from "../../../components/init-form.tsx";
import * as Api from "../../../lib/api.ts";
import { load } from "../../../lib/run.ts";
import { LayerCardPrimary, LayerCardSecondary, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/kumo.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string }>;
  readonly searchParams: Promise<{ error?: string }>;
}

export default async function Organization({ params, searchParams }: Props) {
  const [{ org }, { error }] = await Promise.all([params, searchParams]);
  const { trees } = await load(Api.trees(org));

  return (
    <>
      <PageHeader trail={[["Organizations", "/"]]} title={org} />
      <FailureBanner error={error} />
      {trees.length === 0 ? (
        <Empty title="No trees yet" description="Init one from a public git remote below." />
      ) : (
        <LayerCard>
          <LayerCardSecondary>Trees</LayerCardSecondary>
          <LayerCardPrimary className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tree</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trees.map((tree) => (
                  <TableRow key={tree.name}>
                    <TableCell>
                      <Link href={`/orgs/${org}/trees/${tree.name}`}>{tree.name}</Link>
                    </TableCell>
                    <TableCell>
                      <Text variant="secondary" as="span" size="sm">
                        {new Date(tree.createdAt).toISOString().slice(0, 10)}
                      </Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </LayerCardPrimary>
        </LayerCard>
      )}
      <LayerCard>
        <LayerCardSecondary>Init a tree</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-3">
          <Text variant="secondary" size="sm">
            From a public HTTPS git remote: its default branch becomes the root. You will see each step as it happens.
            Tasks and attempts come from agents, through the Api.
          </Text>
          <InitForm org={org} />
        </LayerCardPrimary>
      </LayerCard>
    </>
  );
}
