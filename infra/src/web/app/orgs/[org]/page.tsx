import * as Api from "../../../lib/api.ts";
import { load } from "../../../lib/run.ts";
import { plantTree } from "../../actions.ts";

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
      <p>
        <a href="/">Organizations</a> / {org}
      </p>
      <h2>Trees</h2>
      {trees.length === 0 ? <p className="muted">No trees yet.</p> : null}
      <ul>
        {trees.map((tree) => (
          <li key={tree.name}>
            <a href={`/orgs/${org}/trees/${tree.name}`}>{tree.name}</a>{" "}
            <span className="muted">planted {new Date(tree.plantedAt).toISOString().slice(0, 10)}</span>
          </li>
        ))}
      </ul>
      <h3>Plant a tree</h3>
      <p className="muted">
        From a public HTTPS git remote; its default branch becomes the root. Buds and leaves come from agents, through
        the Api.
      </p>
      <form action={plantTree}>
        <input type="hidden" name="org" value={org} />
        <input name="tree" placeholder="name" pattern="[A-Za-z0-9._\-]{1,40}" required />
        <input name="source" type="url" placeholder="https://github.com/owner/repo" size={40} required />
        <button type="submit">Plant</button>
      </form>
      {error === undefined ? null : <p className="error">{error}</p>}
    </>
  );
}
