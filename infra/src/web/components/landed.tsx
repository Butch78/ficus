import { Banner } from "@cloudflare/kumo";
import { ActivityPanel } from "./activity-panel.tsx";
import { OperationOutcome } from "./operation-outcome.tsx";

interface Props {
  readonly org: string;
  readonly name: string;
  /** `initialized` + `trace`: an init just landed; `op`/`trace`/`error`: another change did. */
  readonly initialized: string | undefined;
  readonly trace: string | undefined;
  readonly op: string | undefined;
  readonly error: string | undefined;
}

/** What the change that landed on the tree page did: an init's banner and trace, or another change's outcome. */
export function Landed({ org, name, initialized, trace, op, error }: Props) {
  if (initialized === undefined) {
    return <OperationOutcome org={org} op={op} trace={trace} error={error} />;
  }

  return (
    <>
      <Banner title={`Initialized ${name}`} description={`Its root is the default branch of ${initialized}, at node 0.`} />
      {trace === undefined ? null : <ActivityPanel org={org} operation={trace} title={`Init ${name}`} refused={false} />}
    </>
  );
}
