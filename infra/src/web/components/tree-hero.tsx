import { Badge, Link, Text } from "@cloudflare/kumo";
import type { Deploy, Tree } from "../lib/answers.ts";
import { deploying } from "../lib/release.ts";
import { treeFacts, nodeTitle, short } from "../lib/view.ts";
import { plural } from "../lib/trunk-words.ts";
import { AutoRefresh } from "./auto-refresh.tsx";
import { Hero } from "./hero.tsx";
import { VisibilitySwitch } from "./visibility-switch.tsx";

interface Props {
  readonly org: string;
  readonly name: string;
  readonly member: boolean;
  readonly tree: Tree;
  /** How long ago the head landed, if known. */
  readonly ago: string | undefined;
  /** The tree's deploys, for members; a running one keeps the page refreshing. */
  readonly deploys: ReadonlyArray<Deploy> | undefined;
}

/** A tree's heading: where it lives, its name, the change at its head, and the tree at a glance. */
export function TreeHero({ org, name, member, tree, ago, deploys }: Props) {
  const base = `/orgs/${org}/trees/${name}`;
  const head = tree.nodes[String(tree.head)];
  const facts = treeFacts(tree);

  return (
    <Hero
      eyebrow={
        <Text variant="secondary" size="sm">
          {member ? <Link href="/">Organizations</Link> : "Organization"} / {member ? <Link href={`/orgs/${org}`}>{org}</Link> : org}
        </Text>
      }
      title={name}
      aside={
        <>
          {member ? <VisibilitySwitch org={org} tree={name} isPublic={tree.public === true} /> : <Link href="/sign-in">Sign in to work on it</Link>}
          {/* Attempts and agents stay live by themselves (components/live-growing.tsx); a deploy refreshes the page. */}
          <AutoRefresh active={deploying(deploys)} what="a release is deploying" />
        </>
      }
    >
      {head === undefined ? null : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Text variant="secondary" size="sm">
            Latest:
          </Text>
          <Link href={`${base}/nodes/${head.id}#change`}>{nodeTitle(tree, head.id) ?? "the root, as initialized"}</Link>
          <Text variant="mono-secondary">{short(head.commit)}</Text>
          {ago === undefined ? null : (
            <Text variant="secondary" size="xs" as="span">
              {ago}
            </Text>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{plural(facts.accepted, "change")} accepted</Badge>
        <Badge variant="outline">{plural(facts.open, "open task")}</Badge>
        <Badge variant="outline">{plural(facts.contributors, "contributor")}</Badge>
        {tree.released === undefined || tree.released === null ? null : <Badge variant="purple">released: node {tree.released}</Badge>}
        {head === undefined ? null : <Link href={`${base}/nodes/${head.id}`}>Browse the files</Link>}
      </div>
    </Hero>
  );
}
