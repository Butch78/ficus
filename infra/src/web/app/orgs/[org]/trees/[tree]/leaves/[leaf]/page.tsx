import { notFound } from "next/navigation";
import { LeafStatus } from "../../../../../../../components/leaf-status.tsx";
import { RepoBrowser } from "../../../../../../../components/repo-browser.tsx";
import * as Api from "../../../../../../../lib/api.ts";
import { load } from "../../../../../../../lib/run.ts";

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
      <p>
        <a href="/">Organizations</a> / <a href={`/orgs/${org}`}>{org}</a> / <a href={base}>{tree}</a> / leaf {leaf}
      </p>
      <h2>
        Leaf {leaf}: {detail.leaf.agent}
      </h2>
      <p>
        <LeafStatus state={detail.leaf.state} />
      </p>
      <p className="muted">
        Bud {detail.leaf.bud}, grown from <a href={`${base}/nodes/${detail.leaf.base}`}>node {detail.leaf.base}</a>.
      </p>
      <h2>Scoring report</h2>
      {detail.report === null ? (
        <p className="muted">Not scored yet: the root's checks run once the leaf is submitted.</p>
      ) : (
        <>
          <p>
            Cost <strong>{detail.report.cost}</strong> (lines changed outside the locked paths)
          </p>
          {detail.report.checks.map((check) => (
            <details key={check.name} className="card">
              <summary>
                {check.passed ? "✅" : "❌"} <code>{check.name}</code>{" "}
                <span className="muted">{(check.millis / 1000).toFixed(1)}s</span>
              </summary>
              <pre>{check.tail || "(no output)"}</pre>
            </details>
          ))}
        </>
      )}
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
