import { Badge, Banner, Text } from "@cloudflare/kumo";
import * as Result from "effect/Result";
import { notFound } from "next/navigation";
import { DiffView } from "../../../../../../../components/diff-view.tsx";
import { PageHeader } from "../../../../../../../components/page-header.tsx";
import { ReleaseButton } from "../../../../../../../components/release-button.tsx";
import { RepoBrowser } from "../../../../../../../components/repo-browser.tsx";
import * as Api from "../../../../../../../lib/api.ts";
import { move } from "../../../../../../../lib/release.ts";
import { load, run, signedIn } from "../../../../../../../lib/run.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string; node: string }>;
  readonly searchParams: Promise<{ path?: string; file?: string }>;
}

export default async function NodePage({ params, searchParams }: Props) {
  const [{ org, tree, node: raw }, { path, file }] = await Promise.all([params, searchParams]);
  const node = Number(raw);

  if (!Number.isInteger(node) || node < 0) {
    notFound();
  }

  const base = `/orgs/${org}/trees/${tree}`;
  const member = await signedIn();
  // The root started from nothing; every other node is an acceptance, with a change.
  const change = node === 0 ? undefined : await run(Api.diff(org, tree, { kind: "nodes", id: node }));
  const stored = await load(Api.showTree(org, tree));
  const released = stored.released ?? null;
  const nodeMove = move(stored, node);

  return (
    <>
      <PageHeader
        trail={member ? [["Organizations", "/"], [org, `/orgs/${org}`], [tree, base]] : [[tree, base]]}
        title={`node ${node}`}
      >
        {node === stored.head ? <Badge variant="primary">head</Badge> : null}
        {nodeMove === "released" ? <Badge variant="success">released</Badge> : null}
        {member && nodeMove !== "released" && stored.nodes[String(node)] !== undefined ? (
          <ReleaseButton org={org} tree={tree} node={node} released={released} move={nodeMove} />
        ) : null}
      </PageHeader>
      {change === undefined ? null : (
        <section id="change" className="flex flex-col gap-3">
          <Text variant="heading" as="h3">
            What changed
          </Text>
          {Result.isSuccess(change) ? (
            <DiffView diff={change.success} />
          ) : (
            <Banner variant="secondary" description={`The change cannot be shown: ${change.failure.message}`} />
          )}
        </section>
      )}
      <Text variant="heading" as="h3">
        Files
      </Text>
      <RepoBrowser
        org={org}
        tree={tree}
        subject={{ kind: "nodes", id: node }}
        here={`${base}/nodes/${node}`}
        path={path ?? ""}
        file={file}
      />
    </>
  );
}
