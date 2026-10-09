import { LayerCard, Link, Text } from "@cloudflare/kumo";
import * as Result from "effect/Result";
import type { Deploy, Tree } from "../lib/answers.ts";
import * as Api from "../lib/api.ts";
import { move } from "../lib/release.ts";
import { run } from "../lib/run.ts";
import { DeployList } from "./deploy-list.tsx";
import { LayerCardPrimary, LayerCardSecondary } from "./kumo.ts";
import { ReleaseButton } from "./release-button.tsx";

/** How many of the newest deploys the tree page shows. */
const SHOWN = 5;

/** Every deploy, newest first; undefined where the stage does not deploy or they cannot be read, which leaves the page without them. */
export const treeDeploys = async (org: string, name: string) => {
  const deploys = await run(Api.deploys(org, name));

  return Result.isSuccess(deploys) && deploys.success.enabled ? deploys.success.deploys : undefined;
};

interface Props {
  readonly org: string;
  readonly name: string;
  /** The tree page. */
  readonly base: string;
  readonly tree: Tree;
  /** Whether the visitor may release: a member of the organization. */
  readonly member: boolean;
  /** Every deploy, newest first: the card shows the newest few. */
  readonly deploys: ReadonlyArray<Deploy> | undefined;
}

/** The release pointer, the button that moves it to the head, and the deploys that followed it. */
export function ReleaseCard({ org, name, base, tree, member, deploys }: Props) {
  const released = tree.released ?? null;
  const headMove = move(tree, tree.head);

  return (
    <LayerCard>
      <LayerCardSecondary>Released: what is deployed</LayerCardSecondary>
      <LayerCardPrimary className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Text size="sm">
            {released === null ? (
              "Nothing released yet."
            ) : (
              <>
                <Link href={`${base}/nodes/${released}`}>Node {released}</Link>
                {released === tree.head ? ", the head." : `, behind the head (node ${tree.head}).`}
              </>
            )}
          </Text>
          {member && headMove !== "released" ? (
            <ReleaseButton org={org} tree={name} node={tree.head} released={released} move={headMove} />
          ) : null}
        </div>
        {member ? (
          <Text variant="secondary" size="xs">
            A release is a pointer at a node: to roll back, open an older node and release it.
          </Text>
        ) : null}
        {deploys === undefined ? null : deploys.length === 0 ? (
          <Text variant="secondary" size="sm">
            No deploys yet.
          </Text>
        ) : (
          <DeployList base={base} deploys={deploys.slice(0, SHOWN)} />
        )}
      </LayerCardPrimary>
    </LayerCard>
  );
}
