import { Badge, Empty, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import * as Result from "effect/Result";
import { ConnectGitHub } from "../../../components/connect-github.tsx";
import { FailureBanner } from "../../../components/failure-banner.tsx";
import { Hero } from "../../../components/hero.tsx";
import { InitForm } from "../../../components/init-form.tsx";
import * as Api from "../../../lib/api.ts";
import { load, run } from "../../../lib/run.ts";
import { plural } from "../../../lib/trunk-words.ts";
import { LayerCardPrimary, LayerCardSecondary, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/kumo.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string }>;
  readonly searchParams: Promise<{ error?: string }>;
}

export default async function Organization({ params, searchParams }: Props) {
  const [{ org }, { error }] = await Promise.all([params, searchParams]);
  // Asked together; the GitHub card shows only where the stage has the GitHub App.
  const [{ trees }, github] = await Promise.all([load(Api.trees(org)), run(Api.githubRepos)]);
  const offered = Result.isSuccess(github) && github.success.enabled ? github.success : undefined;

  return (
    <>
      <Hero
        eyebrow={
          <Text variant="secondary" size="sm">
            <Link href="/">Organizations</Link> / {org}
          </Text>
        }
        title={org}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{plural(trees.length, "tree")}</Badge>
          <Link href="#init">Init a tree</Link>
        </div>
      </Hero>
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
      {offered === undefined ? null : (
        <LayerCard id="github">
          <LayerCardSecondary>Add from GitHub</LayerCardSecondary>
          <LayerCardPrimary className="flex flex-col gap-3">
            {offered.connected ? (
              <>
                <Text variant="secondary" size="sm">
                  Your repos where the Ficus GitHub App is installed, private ones too. The tree follows its branch: every push to GitHub becomes its new head.
                </Text>
                {offered.repositories.length === 0 ? (
                  <Text size="sm">No repos yet: install the app on the ones you want.</Text>
                ) : (
                  <InitForm org={org} repositories={offered.repositories} />
                )}
                {offered.installUrl === null ? null : (
                  <Link href={offered.installUrl}>{offered.repositories.length === 0 ? "Install the Ficus GitHub App" : "Install it on more repos"}</Link>
                )}
              </>
            ) : (
              <>
                <Text variant="secondary" size="sm">
                  Connect your GitHub account to add your repos, private ones too, and keep each tree in sync with every push.
                </Text>
                <ConnectGitHub back={`/orgs/${org}#github`} />
              </>
            )}
          </LayerCardPrimary>
        </LayerCard>
      )}
      <LayerCard id="init">
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
