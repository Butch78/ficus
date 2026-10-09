import { Banner } from "@cloudflare/kumo";
import { ActivityPanel } from "./activity-panel.tsx";

/** What each change the UI can make is called, as the trace's one line. */
const titleOf = (op: string | undefined) => {
  switch (op) {
    case "task":
      return "New task";
    case "visibility":
      return "Visibility";
    case "accept":
      return "Accept";
    case "release":
      return "Release";
    case "retry":
      return "Retry";
    case "abandon":
      return "Abandon";
    case "submit":
      return "Submit for scoring";
    case "agents":
      return "Start agents";
    default:
      return "Change";
  }
};

interface Props {
  readonly org: string;
  /** From the landing URL: which change, its trace, and the Api's refusal if any. */
  readonly op: string | undefined;
  readonly trace: string | undefined;
  readonly error: string | undefined;
}

/** A change's outcome where it lands: the refusal if any, then its trace. */
export function OperationOutcome({ org, op, trace, error }: Props) {
  const title = titleOf(op);

  return (
    <>
      {error === undefined ? null : <Banner variant="error" title={`${title} refused`} description={error} />}
      {trace === undefined ? null : <ActivityPanel org={org} operation={trace} title={title} refused={error !== undefined} />}
    </>
  );
}
