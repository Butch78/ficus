/**
 * The `ficus-sandbox` Worker: hosts `Sandbox` (Durable Object + container)
 * and `Egress` (the containers' only way out). No public routes: the tree
 * reaches sandboxes through its Durable Object binding.
 */
export { Egress } from "./egress.ts";

export { Sandbox } from "./sandbox.ts";

export default {
  fetch: () => new Response("ficus sandbox: reached through the tree, not directly", { status: 404 }),
} satisfies ExportedHandler;
