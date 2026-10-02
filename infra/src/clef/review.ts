/**
 * `bun run clef-review <file>...`: ask Clef the judgement-call anti-slop
 * questions in rules.ts about each file, print what it finds, and exit
 * non-zero if any finding reaches BLOCK_AT.
 *
 * Not part of `bun run lint`: it costs a Workers AI call per file and needs
 * credentials, so it is run on what changed (see `just clef-review`).
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as DecisionModel from "effect/ai/DecisionModel";
import { Clef } from "./clef.ts";
import { type Finding, RULES, type SourceFile, findingsOf } from "./rules.ts";

export class Blocked extends Schema.TaggedError<Blocked>()("ClefReview.Blocked", {
  count: Schema.Number,
}) {}

/** Every finding across `files`, asking about up to four files at once. */
export const review = Effect.fn("ClefReview.review")(function* (files: ReadonlyArray<SourceFile>) {
  const perFile = yield* Effect.forEach(
    files,
    (file) =>
      DecisionModel.decide(RULES, { input: file }).pipe(Effect.map(({ answers }) => findingsOf(file.path, answers))),
    { concurrency: 4 },
  );

  return perFile.flat();
});

const describe = (finding: Finding): string =>
  `${finding.blocking ? "block " : "advise"} ${finding.probability.toFixed(2)} ${finding.path}: ${finding.rule}`;

const Paths = Schema.Array(Schema.NonEmptyString);

const main = Effect.gen(function* () {
  const paths = yield* Schema.decodeUnknownEffect(Paths)(process.argv.slice(2));

  if (paths.length === 0) {
    return yield* Console.error("usage: bun run clef-review <file>...");
  }

  const fs = yield* FileSystem.FileSystem;

  const files = yield* Effect.forEach(paths, (path) =>
    fs.readFileString(path).pipe(Effect.map((source) => ({ path, source }))),
  );

  const findings = yield* review(files);

  for (const finding of findings) {
    yield* Console.log(describe(finding));
  }

  const blocking = findings.filter((finding) => finding.blocking).length;

  yield* Console.log(`${files.length} file(s), ${findings.length} finding(s), ${blocking} blocking`);

  if (blocking > 0) {
    return yield* new Blocked({ count: blocking });
  }
});

if (import.meta.main) {
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the program's entry point
  BunRuntime.runMain(main.pipe(Effect.provide(Layer.mergeAll(Clef.layerRest().pipe(Layer.provide(FetchHttpClient.layer)), BunServices.layer))));
}
