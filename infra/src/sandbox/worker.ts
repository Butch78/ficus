/**
 * The `ficus-sandbox` Worker: hosts `Sandbox` (Durable Object + container)
 * and `Egress` (the containers' only way out). No public routes: the tree
 * reaches sandboxes through its Durable Object binding.
 */
export { Egress } from "./egress.ts";

import { Sandbox } from "./sandbox.ts";

export { Sandbox };

/** The sandbox on a Durable Object-managed container (stack.ts): its own class, since a container cannot switch scheduling policy in place. */
export class DurableSandbox extends Sandbox {}

export default {
  fetch: () => new Response("ficus sandbox: reached through the tree, not directly", { status: 404 }),
} satisfies ExportedHandler;
