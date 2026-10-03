/**
 * What an agent has been doing, from pi's transcript: each tool call it made
 * (summarised: the command it ran, the file it read or changed), whether it
 * finished, and the last thing it said. The tree serves this to the UI, which
 * shows it like an agent's tool calls. Pure, so it tests without a model.
 */
import type { ToolCall } from "@earendil-works/pi-ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** pi's messages, as far as an activity reads them (pi-ai `Message` fits). */
export type Said =
  | {
      readonly role: "assistant";
      readonly content: ReadonlyArray<
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: ToolCall["arguments"] }
        | { readonly type: "thinking" | "image" }
      >;
    }
  | { readonly role: "toolResult"; readonly toolCallId: string; readonly isError: boolean }
  | { readonly role: "user" | "system" };

export interface Call {
  readonly id: string;
  readonly tool: string;
  /** What the call was about: a command, a path. */
  readonly summary: string;
  readonly state: "running" | "ok" | "error";
}

export interface Activity {
  readonly calls: ReadonlyArray<Call>;
  /** The agent's last words: the final text it wrote, if any. */
  readonly lastWords: string | undefined;
}

/** The most recent calls a status carries. */
const RECENT = 40;

const SUMMARY_LENGTH = 160;

const commandOf = Schema.decodeUnknownOption(Schema.Struct({ command: Schema.String }));

const pathOf = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));

/** What a call was about, in the tool's own terms. */
const about = (tool: string, args: ToolCall["arguments"]) => {
  switch (tool) {
    case "bash":
      return commandOf(args).pipe(Option.map(({ command }) => command));
    case "submit_attempt":
      return Option.some("submit the attempt for scoring");
    default:
      return pathOf(args).pipe(Option.map(({ path }) => path));
  }
};

/** A tool call in a line: what a person needs to follow along. */
export const summarise = (tool: string, args: ToolCall["arguments"]) => {
  const line = Option.getOrElse(about(tool, args), () => JSON.stringify(args))
    .replaceAll(/\s+/g, " ")
    .trim();

  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
};

export const activity = (messages: ReadonlyArray<Said>): Activity => {
  const results = new Map<string, boolean>();
  const calls: Array<Call> = [];
  let lastWords: string | undefined;

  for (const message of messages) {
    if (message.role === "toolResult") {
      results.set(message.toolCallId, message.isError);
    }
  }

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "toolCall") {
        const failed = results.get(part.id);

        calls.push({
          id: part.id,
          tool: part.name,
          summary: summarise(part.name, part.arguments),
          state: failed === undefined ? "running" : failed ? "error" : "ok",
        });
      } else if (part.type === "text" && part.text.trim() !== "") {
        lastWords = part.text.trim();
      }
    }
  }

  return { calls: calls.slice(-RECENT), lastWords };
};
