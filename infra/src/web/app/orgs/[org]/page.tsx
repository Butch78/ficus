import { Button, Empty, Input, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import { FailureBanner } from "../../../components/failure-banner.tsx";
import { PageHeader } from "../../../components/page-header.tsx";
import * as Api from "../../../lib/api.ts";
import { load } from "../../../lib/run.ts";
import { plantTree } from "../../actions.ts";
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
        <Empty title="No trees yet" description="Plant one from a public git remote below." />
      ) : (
        <LayerCard>
          <LayerCardSecondary>Trees</LayerCardSecondary>
          <LayerCardPrimary className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tree</TableHead>
                  <TableHead>Planted</TableHead>
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
                        {new Date(tree.plantedAt).toISOString().slice(0, 10)}
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
        <LayerCardSecondary>Plant a tree</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-3">
          <Text variant="secondary" size="sm">
            From a public HTTPS git remote: its default branch becomes the root. Buds and leaves come from agents,
            through the Api.
          </Text>
          <form action={plantTree} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="org" value={org} />
            <Input name="tree" label="Name" placeholder="site" pattern="[A-Za-z0-9._\-]{1,40}" required />
            <Input
              name="source"
              type="url"
              label="Source"
              placeholder="https://github.com/owner/repo"
              className="min-w-80"
              required
            />
            <Button type="submit" variant="primary">
              Plant
            </Button>
          </form>
        </LayerCardPrimary>
      </LayerCard>
    </>
  );
}
