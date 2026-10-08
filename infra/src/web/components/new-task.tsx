import { Input } from "@cloudflare/kumo";
import { createTask } from "../app/actions.ts";
import { SubmitButton } from "./submit-button.tsx";

/** Say what should change; agents work attempts at it. */
export function NewTask({ org, tree }: { readonly org: string; readonly tree: string }) {
  return (
    <form action={createTask} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="tree" value={tree} />
      <Input name="intent" label="New task" placeholder="What should change? e.g. slugify should drop punctuation" className="min-w-96" required />
      <SubmitButton pending="Creating…">Create task</SubmitButton>
    </form>
  );
}
