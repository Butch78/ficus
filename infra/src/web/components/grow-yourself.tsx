"use client";

/**
 * Grow a leaf by hand: start one, then push to it with git, as an agent
 * would. Its write token is shown here once; submitting freezes the leaf.
 */
import { Banner, Button, Code, Input, Link, Text } from "@cloudflare/kumo";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type FormEvent, useState } from "react";
import { Growing } from "../lib/answers.ts";

const Answer = Schema.Union([Growing, Schema.Struct({ error: Schema.String })]);

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

type Started = { readonly kind: "started"; readonly leaf: typeof Growing.Type } | { readonly kind: "refused"; readonly why: string };

const commands = (leaf: typeof Growing.Type) =>
  [
    `git -c http.extraHeader="Authorization: Bearer ${leaf.token}" clone ${leaf.remote} leaf-${leaf.leaf}`,
    `cd leaf-${leaf.leaf}`,
    `git config http.extraHeader "Authorization: Bearer ${leaf.token}"`,
    "# make the change, then:",
    `git commit -am "${leaf.agent}: ..." && git push origin HEAD:main`,
  ].join("\n");

export function GrowYourself({ org, tree, bud }: { readonly org: string; readonly tree: string; readonly bud: number }) {
  const [started, setStarted] = useState<Started | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);

    const agent = new FormData(event.currentTarget).get("agent");

    const response = await fetch("/api/sprout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org, tree, bud, agent: agent instanceof File || agent === null ? "you" : agent.trim() || "you" }),
    });

    setStarted(
      Option.match(decode(await response.text()), {
        onNone: () => ({ kind: "refused", why: `HTTP ${response.status}` }),
        onSome: (answer) => ("error" in answer ? { kind: "refused", why: answer.error } : { kind: "started", leaf: answer }),
      }),
    );
    setBusy(false);
  };

  if (started?.kind === "started") {
    const { leaf } = started;

    return (
      <div className="flex flex-col gap-2">
        <Text size="sm">
          Leaf {leaf.leaf} is yours, starting at {leaf.base_commit.slice(0, 8)}. Clone it, change it, push; then submit it from{" "}
          <Link href={`/orgs/${org}/trees/${tree}/leaves/${leaf.leaf}`}>its page</Link>. The token below is shown once.
        </Text>
        <Code lang="bash" code={commands(leaf)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={start} className="flex flex-wrap items-end gap-2">
        <Input name="agent" label="Grow a leaf yourself, as" placeholder="your name" />
        <Button type="submit" loading={busy} disabled={busy}>
          Start a leaf
        </Button>
      </form>
      {started?.kind === "refused" ? <Banner variant="error" size="sm" description={started.why} /> : null}
    </div>
  );
}
