/**
 * The `ficus-agents` Worker: hosts `AgentActor`, a pi agent per attempt. It has
 * no public routes; the Api starts an actor through its `AGENTS` Durable
 * Object binding after an attempt starts or retries (src/api/agents.ts).
 */
export { AgentActor } from "./actor.ts";

export default {
  fetch: () => new Response("ficus agents: started by the Api, not reached directly", { status: 404 }),
} satisfies ExportedHandler;
