/**
 * Who may read a tree. A member of its organization may ask anything. A
 * caller with no session and no API key is anonymous: the Api lets them
 * through only for a read (`anonymousMay`), and the tree Worker answers them
 * only from a public tree. To them a private tree, an unknown tree and an
 * unknown organization are the same 404.
 */
import type { Tree } from "./tree.ts";

/** Set by the Api on a request it forwards for an anonymous caller, after removing any copy the caller sent. */
export const ANONYMOUS_HEADER = "x-ficus-anonymous";

/** The 404 of a tree that does not exist, which an anonymous caller also gets for one they may not read. */
export const NO_SUCH_TREE = "no such tree";

/** What follows `/trees/<t>` in a read anyone may make: the tree, or an attempt's or node's log, tree, file or diff. */
const ANONYMOUS_READ = /^(?:\/(?:attempts|nodes)\/[^/]+\/(?:log|tree|file|diff))?$/;

/** Whether an anonymous caller may make this request of a tree (`rest`: the path after its name), public or not. */
export const anonymousMay = (method: string, rest: string) => method === "GET" && ANONYMOUS_READ.test(rest);

/** Whether an anonymous caller may read `tree`: only a public one. Unknown (`undefined`) and stored before the flag are private. */
export const isPublic = (tree: Tree | undefined) => tree?.public === true;
