/**
 * Reading a tree's repos: which repo and commit an attempt or node shows,
 * and the refs and paths a reader may ask for.
 *
 * Every repo a tree owns is a node's (the root, an accepted attempt's repo, a
 * graft) or an attempt's, so a reader names the attempt or node and the tree
 * picks the repo. A reader never names a repo directly: that is what keeps
 * one tree's reads inside its own repos.
 */
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { attempt as findAttempt, node as findNode, Phase, phase, type Tree } from "./tree.ts";
import { type AttemptId, type NodeId, type Oid, type RepoName, TreeError } from "./values.ts";

/** What a reader asks to see. */
export type Subject = Data.TaggedEnum<{
  Attempt: { readonly id: AttemptId };
  Node: { readonly id: NodeId };
}>;

export const Subject = Data.taggedEnum<Subject>();

/** The repo behind a subject and the commit it is pinned to, if any. */
export interface View {
  readonly repo: RepoName;
  /** `undefined` while the attempt is still moving (working, or closed before it was submitted): read its default branch. */
  readonly pinned: Oid | undefined;
}

const unknownNode = (id: NodeId) => Result.fail(new TreeError({ kind: "UnknownNode", message: `no node ${id}` }));

const unknownAttempt = (id: AttemptId) => Result.fail(new TreeError({ kind: "UnknownAttempt", message: `no attempt ${id}` }));

export const view = (tree: Tree, subject: Subject): Result.Result<View, TreeError> =>
  Subject.$match(subject, {
    Node: ({ id }) => {
      const found = findNode(tree, id);

      return found === undefined ? unknownNode(id) : Result.succeed({ repo: found.repo, pinned: found.commit });
    },
    Attempt: ({ id }) => {
      const found = findAttempt(tree, id);

      if (found === undefined) {
        return unknownAttempt(id);
      }

      const pinned = Phase.$match(phase(found.state), {
        Working: () => undefined,
        Closed: () => undefined,
        Checking: ({ commit }) => commit,
        Scored: ({ commit }) => commit,
        Accepted: ({ node: accepted }) => findNode(tree, accepted)?.commit,
      });

      return Result.succeed({ repo: found.repo, pinned });
    },
  });

/** What a subject changed: its repo, the commit it started from, and where it is now (`undefined`: its repo's HEAD). */
export interface Change {
  readonly repo: RepoName;
  /** `undefined` only for the root, which started from nothing. */
  readonly base: Oid | undefined;
  readonly head: Oid | undefined;
}

/** An attempt's change from the node it started from; a node's from its parent. */
export const change = (tree: Tree, subject: Subject) =>
  Result.gen(function* () {
    const seen = yield* view(tree, subject);

    const base = yield* Subject.$match(subject, {
      Attempt: ({ id }) => {
        const found = findAttempt(tree, id);

        return found === undefined ? unknownAttempt(id) : Result.succeed(findNode(tree, found.base)?.commit);
      },
      Node: ({ id }) => {
        const found = findNode(tree, id);

        if (found === undefined) {
          return unknownNode(id);
        }

        return Result.succeed(found.parent === null ? undefined : findNode(tree, found.parent)?.commit);
      },
    });

    return { repo: seen.repo, base, head: seen.pinned } satisfies Change;
  });

export class BrowseError extends Schema.TaggedError<BrowseError>()("Browse.Error", {
  message: Schema.String,
}) {}

const REF_MAX = 255;

const PATH_MAX = 4096;

/** A branch, tag or commit id, as git's `check-ref-format` would accept it (less the rules for creating refs). */
export const parseRef = (text: string): Result.Result<string, BrowseError> => {
  const wellFormed =
    text.length > 0 &&
    text.length <= REF_MAX &&
    !/^[-/]/.test(text) &&
    !/[/.]$/.test(text) &&
    !text.includes("..") &&
    !text.includes("//") &&
    !text.includes("@{") &&
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what a ref may not hold
    !/[\u0000-\u001f\u007f\s~^:?*[\\]/.test(text);

  return wellFormed ? Result.succeed(text) : Result.fail(new BrowseError({ message: `not a ref: ${JSON.stringify(text)}` }));
};

/** A path inside a repo: zero or more names, never `.` or `..`; the empty path is the root. Answers its names. */
export const parsePath = (text: string): Result.Result<ReadonlyArray<string>, BrowseError> => {
  const malformed = Result.fail(new BrowseError({ message: `not a path inside the repo: ${JSON.stringify(text)}` }));

  if (text.length > PATH_MAX) {
    return malformed;
  }

  const trimmed = text.replace(/^\/+|\/+$/g, "");

  if (trimmed === "") {
    return Result.succeed([]);
  }

  const names = trimmed.split("/");

  return names.some((name) => name === "" || name === "." || name === ".." || name.includes("\0")) ? malformed : Result.succeed(names);
};
