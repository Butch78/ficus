import { Text } from "@cloudflare/kumo";
import { headline, taskName } from "../lib/trunk-words.ts";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "./kumo.ts";

/** The whole of a task's prompt, folded away under its name; nothing when the name already says all of it. */
export function FullPrompt({ intent, shown }: { readonly intent: string; readonly shown?: string }) {
  if ((shown ?? headline(intent)) === intent.trim()) {
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

/** A task's prompt as a page shows it: its name (a model's title, or the first sentence), the whole prompt a click away. */
export function TaskPrompt({ intent, title, heading = false }: { readonly intent: string; readonly title: string | undefined; readonly heading?: boolean }) {
  const name = taskName({ intent, title });

  return (
    <div className="flex flex-col gap-1">
      {heading ? (
        <Text variant="heading" as="h3">
          {name}
        </Text>
      ) : (
        <Text variant="secondary" size="sm">
          For: {name}
        </Text>
      )}
      <FullPrompt intent={intent} shown={name} />
    </div>
  );
}
