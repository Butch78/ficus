import { Text } from "@cloudflare/kumo";
import { CollapsibleRoot, CollapsiblePanel, CollapsibleTrigger } from "./kumo.ts";

/** Ficus's words, said in the ones a person already has. */
const WORDS = [
  ["Tree", "a repository, with its history of accepted changes (the trunk)."],
  ["Bud", "a task: what you want, said as intent, not a diff."],
  ["Leaf", "one attempt at a bud, by an agent (or you), in its own copy of the repo."],
  ["Ripening", "a submitted leaf, frozen while the repo's own checks run in a sandbox."],
  ["Harvest", "accepting a bud: the leaf that passes every check with the smallest change becomes the new head."],
  ["Fruit", "a harvested leaf: a node of the trunk."],
  ["Regrow", "start a leaf again from the new head when it grew from an old one; there are no merges."],
  ["Compost", "attempts that lost, with why: the next attempt starts from them."],
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
