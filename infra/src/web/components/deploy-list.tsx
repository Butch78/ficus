import { Badge, Link, Text } from "@cloudflare/kumo";
import type { Deploy } from "../lib/answers.ts";
import { deployStatus, type DeployTone } from "../lib/release.ts";
import { short } from "../lib/view.ts";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "./kumo.ts";

/** Kumo's status badges, by how a deploy went. */
export const DEPLOY_BADGE = {
  running: "warning",
  deployed: "success",
  failed: "error",
  skipped: "secondary",
  unknown: "neutral",
} as const satisfies Record<DeployTone, string>;

export const DEPLOY_WORD = { running: "deploying", deployed: "deployed", failed: "failed", skipped: "skipped", unknown: "unknown" } as const;

interface Props {
  /** The tree page, for links to nodes. */
  readonly base: string;
  readonly deploys: ReadonlyArray<Deploy>;
}

/** Each release's deploy, newest first: how it went and, when it failed, the end of its output. */
export function DeployList({ base, deploys }: Props) {
  return (
    <div className="flex flex-col gap-2">
      {deploys.map((deploy) => {
        const { tone, label, tail } = deployStatus(deploy);

        return (
          <div key={deploy.id} className="flex flex-col gap-1 border-b border-kumo-hairline pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={DEPLOY_BADGE[tone]} appearance="dot">
                {DEPLOY_WORD[tone]}
              </Badge>
              <Link href={`${base}/nodes/${deploy.node}`}>node {deploy.node}</Link>
              <Text variant="mono-secondary">{short(deploy.commit)}</Text>
              <Text variant="secondary" as="span" size="sm">
                {label} · started {new Date(deploy.started_at).toISOString().slice(0, 16).replace("T", " ")} UTC
              </Text>
            </div>
            {tail === undefined ? null : (
              <CollapsibleRoot>
                <CollapsibleTrigger>The end of its output</CollapsibleTrigger>
                <CollapsiblePanel>
                  <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-kumo-recessed p-3 font-mono text-xs text-kumo-default">
                    {tail || "(no output)"}
                  </pre>
                </CollapsiblePanel>
              </CollapsibleRoot>
            )}
          </div>
        );
      })}
    </div>
  );
}
