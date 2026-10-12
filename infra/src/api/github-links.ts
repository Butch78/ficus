/**
 * Which trees follow which GitHub repo and branch (`ficus_github_link`,
 * schema.ts): written when a tree is added from GitHub, read for each push
 * (github.ts). Queries go through Drizzle's Effect driver on the request's
 * `D1Client`, like the directory.
 */
import { and, eq } from "drizzle-orm";
import * as D1Drizzle from "drizzle-orm/effect-d1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ficusGithubLink } from "./schema.ts";

export type GitHubLink = typeof ficusGithubLink.$inferSelect;

export class LinksFailure extends Schema.TaggedError<LinksFailure>()("GitHubLinks.Failure", {
  message: Schema.String,
}) {}

const failure = (step: string) => (cause: { readonly message: string }) => new LinksFailure({ message: `${step}: ${cause.message}` });

const links = D1Drizzle.makeWithDefaults({});

/** The tree now follows `repository`'s `branch`; adding it again replaces what it followed. */
export const link = Effect.fn("GitHubLinks.link")(function* (row: GitHubLink) {
  const db = yield* links;

  yield* db
    .insert(ficusGithubLink)
    .values(row)
    .onConflictDoUpdate({
      target: [ficusGithubLink.organizationId, ficusGithubLink.tree],
      set: { repositoryId: row.repositoryId, fullName: row.fullName, branch: row.branch, createdAt: row.createdAt },
    })
    .pipe(Effect.mapError(failure("could not record the tree's GitHub repo")));
});

/** The trees following `repositoryId`'s `branch`, across organizations. */
export const following = Effect.fn("GitHubLinks.following")(function* (repositoryId: number, branch: string) {
  const db = yield* links;

  return yield* db
    .select()
    .from(ficusGithubLink)
    .where(and(eq(ficusGithubLink.repositoryId, repositoryId), eq(ficusGithubLink.branch, branch)))
    .pipe(Effect.mapError(failure("could not read the trees following a repo")));
});
