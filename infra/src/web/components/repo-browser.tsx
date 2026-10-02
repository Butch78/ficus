/**
 * A leaf's or node's repo, read through Artifacts by the tree Worker: recent
 * history, one directory, and optionally one file in it, all at the same
 * commit. `?path=` picks the directory, `?file=` a file (and its directory).
 */
import * as Api from "../lib/api.ts";
import { load } from "../lib/run.ts";
import { crumbs, join, short } from "../lib/view.ts";

const HISTORY = 10;

interface Props {
  readonly org: string;
  readonly tree: string;
  readonly subject: Api.Subject;
  /** This page's URL, which the browser's links extend with `?path=` / `?file=`. */
  readonly here: string;
  readonly path: string;
  readonly file: string | undefined;
}

const parentOf = (file: string) => file.split("/").slice(0, -1).join("/");

export async function RepoBrowser({ org, tree, subject, here, path, file }: Props) {
  const directory = file === undefined ? path : parentOf(file);

  const [history, listing] = await Promise.all([
    load(Api.log(org, tree, subject, HISTORY)),
    load(Api.listDirectory(org, tree, subject, directory)),
  ]);

  const content = file === undefined ? undefined : await load(Api.readFile(org, tree, subject, listing.commit.hash, file));
  const at = (query: Record<string, string>) => `${here}?${new URLSearchParams(query).toString()}`;

  return (
    <section>
      <h2>
        Repo <code>{listing.repo}</code> at <code>{short(listing.commit.hash)}</code>
      </h2>
      <p>
        <a href={here}>/</a>
        {crumbs(directory).map(([name, target]) => (
          <span key={target}>
            {" "}
            <a href={at({ path: target })}>{name}</a> /
          </span>
        ))}
        {file === undefined ? null : <strong> {file.split("/").at(-1)}</strong>}
      </p>
      {file === undefined ? (
        <table>
          <tbody>
            {listing.entries.map((entry) => (
              <tr key={entry.name}>
                <td>
                  {entry.type === "tree" ? "📁" : "📄"}{" "}
                  <a href={at(entry.type === "tree" ? { path: join(directory, entry.name) } : { file: join(directory, entry.name) })}>
                    {entry.name}
                  </a>
                </td>
                <td className="muted">
                  <code>{entry.mode}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre>{content ?? "(binary file)"}</pre>
      )}
      <h3>History</h3>
      <table>
        <tbody>
          {history.commits.map((commit) => (
            <tr key={commit.hash}>
              <td>
                <code>{short(commit.hash)}</code>
              </td>
              <td>{commit.message.split("\n")[0]}</td>
              <td className="muted">{commit.author.name}</td>
              <td className="muted">{new Date(commit.committed_at * 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
