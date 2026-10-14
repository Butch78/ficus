/**
 * What a tree has learned, so its agents and judges do not repeat a known
 * mistake.
 *
 * Two sources. The root repo's `LESSONS.md` (or the file `[lessons] path`
 * in `ficus.toml` names), written by people (newest first) and changed only
 * by an accepted attempt; it is read at an attempt's base commit, like
 * `ficus.toml`, and the scorer restores it from the base like the locked
 * files, so an attempt cannot rewrite the lessons its own judges read. And the lessons the tree records itself where it
 * already has the facts: an attempt abandoned after a failed rebase or
 * sandbox failures, a failed deploy, a failed canary. Those are kept in the
 * tree's storage, bounded, newest first, one per kind and subject (`learn`).
 *
 * `lessonsContext` merges both into the capped text the built-in agents get
 * beside their task and the root's judges beside the diff.
 */
import * as Schema from "effect/Schema";
import type { DeploySeen } from "./deploy.ts";

/** The lessons file, at the root of the tree's repo, unless `ficus.toml` names another (`[lessons] path`). */
export const LESSONS_PATH = "LESSONS.md";

/** Whether `path` may name the lessons file: relative, inside the repo, with no `.` or `..` part. */
export const isLessonsPath = (path: string) => path !== "" && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");

/**
 * The lessons file `ficus.toml` names (`[lessons] path = "..."`), else
 * `LESSONS_PATH`. A narrow reader, for the tree Worker, which has no TOML
 * parser: a `path` line under a `[lessons]` table, as a basic or literal
 * string; the scorer parses the whole file strictly and refuses a bad one.
 */
export const lessonsPath = (toml: string | undefined): string => {
  let inLessons = false;

  for (const line of (toml ?? "").split("\n").map((each) => each.trim())) {
    const table = /^\[([^\]]*)\]/.exec(line);

    if (table !== null) {
      inLessons = table[1]?.trim() === "lessons";
    } else if (inLessons) {
      const named = /^path\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
      const path = named?.[1] ?? named?.[2];

      if (path !== undefined) {
        return isLessonsPath(path) ? path : LESSONS_PATH;
      }
    }
  }

  return LESSONS_PATH;
};

/** The most recorded lessons a tree keeps. */
export const MAX_LESSONS = 30;

/** The most characters of lessons an agent or a judge is given. */
export const LESSONS_CHARS = 8000;

/** The most recorded lessons in that context: the newest. */
export const RECORDED_IN_CONTEXT = 10;

/** The most characters one recorded lesson says. */
const LESSON_CHARS = 400;

export const LessonKind = Schema.Literals(["rebase", "sandbox", "deploy", "canary"]);

export type LessonKind = typeof LessonKind.Type;

/** A lesson the tree recorded itself. */
export const Lesson = Schema.Struct({
  kind: LessonKind,
  /** What it is about (`task 12`, `node 40`): a newer lesson of the same kind and subject replaces an older one. */
  subject: Schema.String,
  text: Schema.String,
  /** When it happened, epoch ms. */
  at: Schema.Number,
});

export type Lesson = typeof Lesson.Type;

export const Lessons = Schema.Array(Lesson);

const keyOf = (lesson: Lesson) => `${lesson.kind}:${lesson.subject}`;

/** `text` on one line, at most `chars` long. */
const oneLine = (text: string, chars = LESSON_CHARS) => {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length <= chars ? line : `${line.slice(0, chars - 1)}…`;
};

/** The end of a command's output on one line: where its error usually is. */
const tailOf = (text: string, chars: number) => {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length <= chars ? line : `…${line.slice(-(chars - 1))}`;
};

/**
 * `known` with `learned` added: one lesson per kind and subject (the newer
 * wins, the one learned on a tie), newest first, at most `MAX_LESSONS`.
 * Learning what is already known changes nothing.
 */
export const learn = (known: ReadonlyArray<Lesson>, learned: ReadonlyArray<Lesson>): ReadonlyArray<Lesson> => {
  const byKey = new Map<string, Lesson>();

  for (const lesson of [...learned, ...known]) {
    const kept = byKey.get(keyOf(lesson));

    if (kept === undefined || lesson.at > kept.at) {
      byKey.set(keyOf(lesson), lesson);
    }
  }

  return [...byKey.values()].toSorted((one, other) => other.at - one.at).slice(0, MAX_LESSONS);
};

/** An attempt the tree abandoned for a failed rebase or for its sandbox: the task it was at, by name, and why. */
export const abandonedLesson = (kind: "rebase" | "sandbox", task: { readonly id: number; readonly intent: string; readonly title?: string }, attempt: number, note: string, at: number): Lesson =>
  Lesson.make({
    kind,
    subject: `task ${task.id}`,
    text: oneLine(`Attempt ${attempt} at task ${task.id} (${oneLine(task.title ?? task.intent, 80)}) was abandoned: ${note}`),
    at,
  });

/** A deploy as the tree lists it (src/tree/deploys.ts): its record and how it went. */
export interface DeployFacts extends DeploySeen {
  readonly id: string;
  readonly started_at: number;
  readonly error?: string | undefined;
}

/**
 * What a deploy that ended badly teaches: an errored Workflow or a failed
 * command (`deploy`), or a failed canary and the rollback it caused
 * (`canary`). Nothing for one still going or that went well. Dated by when
 * it started, so reading the same deploy again learns the same lesson.
 */
export const deployLesson = (deploy: DeployFacts): Lesson | undefined => {
  const subject = `node ${deploy.node}`;
  const what = `Deploy ${deploy.id} of node ${deploy.node}`;
  const report = deploy.report;
  const lesson = (kind: LessonKind, text: string) => Lesson.make({ kind, subject, text: oneLine(text), at: deploy.started_at });

  if (deploy.status === "errored") {
    return lesson("deploy", `${what} errored: ${tailOf(deploy.error ?? report?.tail ?? "no reason given", 300)}`);
  }

  if (deploy.status !== "complete" || report === undefined) {
    return undefined;
  }

  if (!report.passed) {
    return lesson("deploy", `${what} failed in \`run\`: ${tailOf(report.tail, 300)}`);
  }

  if (report.deployer !== undefined && !report.deployer.passed) {
    return lesson("deploy", `${what} failed in \`deployer\`: ${tailOf(report.deployer.tail, 300)}`);
  }

  const canary = report.canary;

  if (canary === undefined || canary.passed) {
    return undefined;
  }

  const rolledBack = deploy.rolled_back === undefined ? "" : `; the release rolled back to node ${deploy.rolled_back.node}`;

  return lesson("canary", `The canary after ${what} failed: ${tailOf(canary.reason ?? "no reason given", 300)}${rolledBack}`);
};

/** `text` cut at a line boundary to fit `chars`, saying so when it was cut. */
const clipLines = (text: string, chars: number) => {
  if (text.length <= chars) {
    return text;
  }

  const marker = "\n… (the rest is cut)";
  const room = chars - marker.length;
  const cut = text.lastIndexOf("\n", room);

  return room <= 0 ? "" : `${text.slice(0, cut > 0 ? cut : room)}${marker}`;
};

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * The lessons an agent or a judge is given: the file's (newest first, as it
 * is written), then the newest recorded ones, at most `chars` in all; the
 * recorded ones are kept whole and the file is cut to fit. Empty when there
 * are none.
 */
export const lessonsContext = (file: string | undefined, recorded: ReadonlyArray<Lesson>, chars = LESSONS_CHARS, path = LESSONS_PATH): string => {
  const lines = recorded.slice(0, RECORDED_IN_CONTEXT).map((lesson) => `- ${day(lesson.at)} ${lesson.kind}, ${lesson.subject}: ${lesson.text}`);
  const tree = lines.length === 0 ? "" : clipLines(["Recorded by the tree, newest first:", ...lines].join("\n"), chars);
  const header = `From ${path}:\n`;
  const written = (file ?? "").trim();
  const room = chars - tree.length - header.length - 2;
  const fromFile = written === "" || room <= 0 ? "" : clipLines(written, room);

  return [fromFile === "" ? "" : `${header}${fromFile}`, tree].filter((part) => part !== "").join("\n\n");
};
