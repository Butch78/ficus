import { Badge, LayerCard, Link, Text } from "@cloudflare/kumo";
import * as Result from "effect/Result";
import type { Lessons } from "../lib/answers.ts";
import * as Api from "../lib/api.ts";
import { run } from "../lib/run.ts";
import { timeAgo } from "../lib/trunk-words.ts";
import { LayerCardPrimary, LayerCardSecondary } from "./kumo.ts";

/** How many of the newest recorded lessons the card shows. */
const SHOWN = 5;

/** What the tree has learned; undefined when it cannot be read (a visitor, or an older stage), which leaves the card out. */
export const treeLessons = async (org: string, name: string) => {
  const lessons = await run(Api.lessons(org, name));

  return Result.isSuccess(lessons) ? lessons.success : undefined;
};

interface Props {
  /** The tree page. */
  readonly base: string;
  readonly lessons: Lessons;
}

/** The lessons agents and judges are given: the head's lessons file, and the newest the tree recorded itself. */
export function LessonsCard({ base, lessons }: Props) {
  const written = lessons.file === null ? 0 : lessons.file.split("\n").filter((line) => line.startsWith("- ")).length;
  const now = Date.now();

  return (
    <LayerCard>
      <LayerCardSecondary>Lessons: what agents and judges are told</LayerCardSecondary>
      <LayerCardPrimary className="flex flex-col gap-2">
        <Text size="sm">
          {lessons.file === null ? (
            `No ${lessons.path} at the head: add one in an attempt to teach agents and judges.`
          ) : (
            <>
              <Link href={`${base}/nodes/${lessons.node}?file=${encodeURIComponent(lessons.path)}`}>{lessons.path}</Link>
              {` at the head: ${written} ${written === 1 ? "lesson" : "lessons"}.`}
            </>
          )}
        </Text>
        {lessons.recorded.slice(0, SHOWN).map((lesson) => (
          <div key={`${lesson.kind}:${lesson.subject}`} className="flex flex-wrap items-baseline gap-2 border-t border-kumo-hairline pt-2">
            <Badge variant="outline">{lesson.kind}</Badge>
            <Text size="sm">{lesson.text}</Text>
            <Text variant="secondary" size="xs">
              {timeAgo(Math.floor(lesson.at / 1000), now)}
            </Text>
          </div>
        ))}
        {lessons.recorded.length === 0 ? (
          <Text variant="secondary" size="xs">
            The tree records a lesson itself when a rebase, a sandbox, a deploy or its canary fails.
          </Text>
        ) : null}
      </LayerCardPrimary>
    </LayerCard>
  );
}
