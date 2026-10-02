/**
 * A tree operation's streamed progress (crates/ficus-core/src/progress.rs),
 * passing through the Api: one JSON object per line, the last one the
 * outcome. The Api adds its own steps after the tree's, before the stream
 * closes.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const CONTENT_TYPE = "application/x-ndjson";

const Outcome = Schema.Struct({ kind: Schema.Literal("outcome"), status: Schema.Number });

const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(Outcome));

/** Whether `line` is an outcome the caller would have got as a 2xx. */
export const succeeded = (line: string) =>
  Option.match(decodeOutcome(line), { onNone: () => false, onSome: ({ status }) => status >= 200 && status < 300 });

/** A step line in the tree's format, for the Api's own steps. */
export const stepLine = (step: string, state: "active" | "complete" | "error") =>
  `${JSON.stringify({ kind: "step", step, state })}\n`;

/**
 * `body`, passed through as it arrives; when it ends with a successful
 * outcome, `after` runs and whatever line it answers is appended.
 */
export const afterSuccess = (body: ReadableStream<Uint8Array>, after: () => Promise<string>) => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let success = false;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        pending += decoder.decode(chunk, { stream: true });

        const lines = pending.split("\n");

        pending = lines.pop() ?? "";
        success ||= lines.some(succeeded);
      },
      async flush(controller) {
        success ||= succeeded(pending + decoder.decode());

        if (success) {
          controller.enqueue(encoder.encode(await after()));
        }
      },
    }),
  );
};
