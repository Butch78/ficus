/**
 * The `ficus-agents` Worker: hosts `AgentActor`. It has no public routes;
 * `TreeObject` reaches actors through its `AGENTS` Durable Object binding.
 */
export { AgentActor } from "./actor.ts";

export default {
  fetch: () => new Response("ficus agents: reached through the tree, not directly", { status: 404 }),
} satisfies ExportedHandler;
