import { Text } from "@cloudflare/kumo";
import { headline } from "../lib/trunk-words.ts";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "./kumo.ts";

/** The whole of a task's prompt, folded away under its first sentence; nothing when that sentence is all of it. */
export function FullPrompt({ intent }: { readonly intent: string }) {
  if (headline(intent) === intent.trim()) {
    return null;
  }

  return (
    <CollapsibleRoot>
      <CollapsibleTrigger className="text-left text-sm font-normal text-kumo-subtle">The task in full</CollapsibleTrigger>
      <CollapsiblePanel>
        <p className="whitespace-pre-line">
          <Text variant="secondary" size="sm" as="span">
            {intent}
          </Text>
        </p>
      </CollapsiblePanel>
    </CollapsibleRoot>
  );
}

/** A task's prompt as a page shows it: the first sentence, the rest a click away. Prompts are often whole paragraphs. */
export function TaskPrompt({ intent, heading = false }: { readonly intent: string; readonly heading?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      {heading ? (
        <Text variant="heading" as="h3">
          {headline(intent)}
        </Text>
      ) : (
        <Text variant="secondary" size="sm">
          For: {headline(intent)}
        </Text>
      )}
      <FullPrompt intent={intent} />
    </div>
  );
}
