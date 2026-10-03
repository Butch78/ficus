/**
 * An attempt's or node's repo, read through Artifacts by the tree Worker: recent
 * history, one directory, and optionally one file in it, all at the same
 * commit. `?path=` picks the directory, `?file=` a file (and its directory).
 */
import { Breadcrumbs, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import { FileIcon, FolderIcon } from "@phosphor-icons/react/ssr";
import { Fragment } from "react";
import * as Api from "../lib/api.ts";
import { load } from "../lib/run.ts";
import { crumbs, join, short } from "../lib/view.ts";
import { BreadcrumbsCurrent, BreadcrumbsLink, BreadcrumbsSeparator, LayerCardPrimary, LayerCardSecondary, TableBody, TableCell, TableRow } from "./kumo.ts";

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

  const content =
    file === undefined ? undefined : await load(Api.readFile(org, tree, subject, listing.commit.hash, file));

  const at = (query: Record<string, string>) => `${here}?${new URLSearchParams(query).toString()}`;

  return (
    <>
      <LayerCard>
        <LayerCardSecondary className="flex flex-wrap items-center gap-2">
          <Text variant="mono">
            {listing.repo}
          </Text>
          <Text variant="secondary" as="span" size="sm">
            at
          </Text>
          <Text variant="mono">
            {short(listing.commit.hash)}
          </Text>
        </LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-3">
          <Breadcrumbs size="sm">
            <BreadcrumbsLink href={here}>{listing.repo}</BreadcrumbsLink>
            {crumbs(directory).map(([name, target]) => (
              <Fragment key={target}>
                <BreadcrumbsSeparator />
                <BreadcrumbsLink href={at({ path: target })}>{name}</BreadcrumbsLink>
              </Fragment>
            ))}
            {file === undefined ? null : (
              <>
                <BreadcrumbsSeparator />
                <BreadcrumbsCurrent>{file.split("/").at(-1)}</BreadcrumbsCurrent>
              </>
            )}
          </Breadcrumbs>
          {file === undefined ? (
            <Table>
              <TableBody>
                {listing.entries.map((entry) => {
                  const isDirectory = entry.type === "tree";
                  const target = join(directory, entry.name);

                  return (
                    <TableRow key={entry.name}>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          {isDirectory ? <FolderIcon size={16} /> : <FileIcon size={16} />}
                          <Link href={at(isDirectory ? { path: target } : { file: target })}>{entry.name}</Link>
                        </span>
                      </TableCell>
                      <TableCell>
                        <Text variant="mono-secondary">
                          {entry.mode}
                        </Text>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-kumo-recessed p-3 font-mono text-sm text-kumo-default">
              {content ?? "(binary file)"}
            </pre>
          )}
        </LayerCardPrimary>
      </LayerCard>
      <LayerCard>
        <LayerCardSecondary>History</LayerCardSecondary>
        <LayerCardPrimary className="p-0">
          <Table>
            <TableBody>
              {history.commits.map((commit) => (
                <TableRow key={commit.hash}>
                  <TableCell>
                    <Text variant="mono-secondary">
                      {short(commit.hash)}
                    </Text>
                  </TableCell>
                  <TableCell>{commit.message.split("\n")[0]}</TableCell>
                  <TableCell>
                    <Text variant="secondary" as="span" size="sm">
                      {commit.author.name}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text variant="secondary" as="span" size="sm">
                      {new Date(commit.committed_at * 1000).toISOString().slice(0, 16).replace("T", " ")}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </LayerCardPrimary>
      </LayerCard>
    </>
  );
}
