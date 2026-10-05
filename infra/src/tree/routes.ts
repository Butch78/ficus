/** The tree Durable Object's routes, as patterns it switches on. */

/** A route under `/trees/<t>/`: up to three segments. */
export interface Route {
  readonly kind: string;
  readonly id: string;
  readonly action: string;
}

/** The ways a repo can be read (`#read`). */
const READS: ReadonlySet<string> = new Set(["log", "tree", "file", "diff"]);

/** A route as a pattern: its fixed words, with `:id` for the id and `:read` for a read. */
export const pattern = ({ kind, id, action }: Route) => {
  const reading = action !== "agent" && (kind === "attempts" || kind === "nodes") && READS.has(action) ? ":read" : action;

  return [kind, id === "" ? "" : ":id", reading].filter((part) => part !== "").join("/");
};

