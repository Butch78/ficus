"use client";

/**
 * Work an attempt by hand: start one, then push to it with git, as an agent
 * would. Its write token is shown here once; submitting freezes the attempt.
 */
import { Banner, Button, Code, Input, Link, Text } from "@cloudflare/kumo";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type FormEvent, useState } from "react";
import { Started } from "../lib/answers.ts";

/** A person's attempt always comes with its write token. */
const Yours = Schema.Struct({ ...Started.fields, token: Schema.String });

const Answer = Schema.Union([Yours, Schema.Struct({ error: Schema.String })]);

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

type Outcome = { readonly kind: "started"; readonly attempt: typeof Yours.Type } | { readonly kind: "refused"; readonly why: string };

const commands = (attempt: typeof Yours.Type) =>
  [
    `git -c http.extraHeader="Authorization: Bearer ${attempt.token}" clone ${attempt.remote} attempt-${attempt.attempt}`,
    `cd attempt-${attempt.attempt}`,
    `git config http.extraHeader "Authorization: Bearer ${attempt.token}"`,
    "# make the change, then:",
    `git commit -am "${attempt.agent}: ..." && git push origin HEAD`,
  ].join("\n");

export function WorkYourself({ org, tree, task }: { readonly org: string; readonly tree: string; readonly task: number }) {
  const [started, setStarted] = useState<Outcome | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);

    const agent = new FormData(event.currentTarget).get("agent");

    const response = await fetch("/api/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org, tree, task, agent: agent instanceof File || agent === null ? "you" : agent.trim() || "you" }),
    });

    setStarted(
      Option.match(decode(await response.text()), {
        onNone: () => ({ kind: "refused", why: `HTTP ${response.status}` }),
        onSome: (answer) => ("error" in answer ? { kind: "refused", why: answer.error } : { kind: "started", attempt: answer }),
      }),
    );
    setBusy(false);
  };

  if (started?.kind === "started") {
    const { attempt } = started;

    return (
      <div className="flex flex-col gap-2">
        <Text size="sm">
          Attempt {attempt.attempt} is yours, starting at {attempt.base_commit.slice(0, 8)}. Clone it, change it, push; then submit it from{" "}
          <Link href={`/orgs/${org}/trees/${tree}/attempts/${attempt.attempt}`}>its page</Link>. The token below is shown once.
        </Text>
        <Code lang="bash" code={commands(attempt)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={start} className="flex flex-wrap items-end gap-2">
        <Input name="agent" label="Work an attempt yourself, as" placeholder="your name" />
        <Button type="submit" loading={busy} disabled={busy}>
          Start an attempt
        </Button>
      </form>
      {started?.kind === "refused" ? <Banner variant="error" size="sm" description={started.why} /> : null}
    </div>
  );
}
