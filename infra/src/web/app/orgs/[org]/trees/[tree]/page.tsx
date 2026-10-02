import { LeafStatus } from "../../../../../components/leaf-status.tsx";
import * as Api from "../../../../../lib/api.ts";
import { load } from "../../../../../lib/run.ts";
import { buds, pruneReason, short, trunk } from "../../../../../lib/view.ts";

export const dynamic = "force-dynamic";

export default async function TreePage({ params }: { readonly params: Promise<{ org: string; tree: string }> }) {
  const { org, tree: name } = await params;
  const tree = await load(Api.showTree(org, name));
  const base = `/orgs/${org}/trees/${name}`;

  return (
    <>
      <p>
        <a href="/">Organizations</a> / <a href={`/orgs/${org}`}>{org}</a> / {name}
      </p>
      <h2>Trunk</h2>
      <p className="muted">Accepted history: the root, then one node per harvested bud. The last is the head.</p>
      <ol start={0}>
        {trunk(tree).map((node) => (
          <li key={node.id}>
            <a href={`${base}/nodes/${node.id}`}>
              node {node.id} <code>{short(node.commit)}</code>
            </a>{" "}
            <span className="muted">
              {node.fruit_of === null ? "root" : `fruit of leaf ${node.fruit_of}`}
              {node.id === tree.head ? " · head" : ""}
            </span>
          </li>
        ))}
      </ol>
      <h2>Buds</h2>
      {Object.keys(tree.buds).length === 0 ? <p className="muted">No buds yet.</p> : null}
      {buds(tree).map(({ bud, leaves, fruit }) => (
        <section key={bud.id} className="card">
          <h3>
            bud {bud.id}: {bud.intent}
          </h3>
          <p className="muted">
            {fruit === undefined ? (
              "open: leaves are growing or waiting for harvest"
            ) : (
              <>
                harvested into <a href={`${base}/nodes/${fruit}`}>node {fruit}</a>
              </>
            )}
          </p>
          {leaves.length === 0 ? <p className="muted">No leaves yet.</p> : null}
          <table>
            <tbody>
              {leaves.map((leaf) => (
                <tr key={leaf.id}>
                  <td>
                    <a href={`${base}/leaves/${leaf.id}`}>leaf {leaf.id}</a>
                  </td>
                  <td>{leaf.agent}</td>
                  <td className="muted">from node {leaf.base}</td>
                  <td>
                    <LeafStatus state={leaf.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <h2>Compost</h2>
      {tree.compost.length === 0 ? <p className="muted">Nothing pruned yet.</p> : null}
      <ul>
        {tree.compost.map((entry) => (
          <li key={entry.leaf}>
            <a href={`${base}/leaves/${entry.leaf}`}>leaf {entry.leaf}</a> ({entry.agent}, bud {entry.bud}):{" "}
            {pruneReason(entry.reason)}
            {entry.score === null ? null : (
              <span className="muted">
                {" "}
                · scored {entry.score.checks_passed}/{entry.score.checks_total}, cost {entry.score.cost}
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
