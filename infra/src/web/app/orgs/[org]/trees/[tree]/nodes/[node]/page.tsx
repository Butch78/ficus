import { notFound } from "next/navigation";
import { RepoBrowser } from "../../../../../../../components/repo-browser.tsx";

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

  return (
    <>
      <p>
        <a href="/">Organizations</a> / <a href={`/orgs/${org}`}>{org}</a> / <a href={base}>{tree}</a> / node {node}
      </p>
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
