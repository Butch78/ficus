import { Text } from "@cloudflare/kumo";
import { CollapsibleRoot, CollapsiblePanel, CollapsibleTrigger } from "./kumo.ts";

/** Ficus's words, and what each does. */
const WORDS = [
  ["Tree", "a repository, with its history of accepted changes (the trunk)."],
  ["Task", "what you want changed, said as intent, optionally with checks of its own."],
  ["Attempt", "one go at a task, by an agent or by you, in its own copy of the repo."],
  ["Submit", "freeze an attempt: the repo's own checks run on it in a sandbox."],
  ["Accept", "the attempt that passes every check with the smallest change becomes the new head."],
  ["Rebase", "replay a behind attempt's commits onto the new head, automatically; there are no merges."],
  ["Retry", "start an attempt again from the new head when its rebase conflicts."],
  ["History", "closed attempts and why they closed: the next attempt starts from them."],
  ["Release", "point what is deployed at a node; releasing an older node rolls back."],
] as const;

export function Glossary() {
  return (
    <CollapsibleRoot>
      <CollapsibleTrigger>How Ficus works</CollapsibleTrigger>
      <CollapsiblePanel>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {WORDS.map(([word, meaning]) => (
            <div key={word} className="contents">
              <dt className="font-medium text-kumo-default">{word}</dt>
              <dd>
                <Text variant="secondary" as="span" size="sm">
                  {meaning}
                </Text>
              </dd>
            </div>
          ))}
        </dl>
      </CollapsiblePanel>
    </CollapsibleRoot>
  );
}
