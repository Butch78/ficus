"use client";

/**
 * Release a node, or roll back to an older one, after saying what follows:
 * on a stage that deploys, the released commit's `[deploy]` runs, so the
 * button asks first.
 */
import { Button, Dialog } from "@cloudflare/kumo";
import { useState } from "react";
import { releaseNode } from "../app/actions.ts";
import type { Move } from "../lib/release.ts";
import { SubmitButton } from "./submit-button.tsx";

interface Props {
  readonly org: string;
  readonly tree: string;
  readonly node: number;
  /** The node released now, if any. */
  readonly released: number | null;
  readonly move: Exclude<Move, "released">;
}

export function ReleaseButton({ org, tree, node, released, move }: Props) {
  const rollback = move === "rollback";
  const verb = rollback ? `Roll back to node ${node}` : `Release node ${node}`;
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={(next) => setOpen(next)}>
      <Button variant={rollback ? "secondary-destructive" : "primary"} onClick={() => setOpen(true)}>
        {verb}
      </Button>
      <Dialog size="lg" className="flex flex-col gap-4 p-8">
        <Dialog.Title className="text-lg font-semibold">{verb}?</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">
          The release moves {released === null ? "" : `from node ${released} `}to node {node}. If this tree deploys, the
          released commit&apos;s [deploy] in ficus.toml runs now, and its deploy shows on the tree page.
        </Dialog.Description>
        <form action={releaseNode} className="flex justify-end gap-2">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="tree" value={tree} />
          <input type="hidden" name="node" value={node} />
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton pending={rollback ? "Rolling back…" : "Releasing…"} variant={rollback ? "secondary-destructive" : "primary"}>
            {rollback ? "Roll back" : "Release"}
          </SubmitButton>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
