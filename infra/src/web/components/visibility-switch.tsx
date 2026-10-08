import { Badge } from "@cloudflare/kumo";
import { setVisibility } from "../app/actions.ts";
import { SubmitButton } from "./submit-button.tsx";

interface Props {
  readonly org: string;
  readonly tree: string;
  readonly isPublic: boolean;
}

/** Whether anyone may read the tree, and, for its members, the switch. */
export function VisibilitySwitch({ org, tree, isPublic }: Props) {
  return (
    <>
      <Badge variant={isPublic ? "primary" : "outline"}>{isPublic ? "public" : "private"}</Badge>
      <form action={setVisibility} className="flex items-center gap-2">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="tree" value={tree} />
        <input type="hidden" name="public" value={String(!isPublic)} />
        <SubmitButton pending="Saving…" variant="secondary">
          {isPublic ? "Make private" : "Make public"}
        </SubmitButton>
      </form>
    </>
  );
}
