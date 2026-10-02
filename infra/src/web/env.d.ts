// The bindings web.run.ts gives this Worker, as `import { env } from "cloudflare:workers"` sees them.
declare namespace Cloudflare {
  interface Env {
    /** The Ficus Api (src/api), over a service binding. */
    readonly API: Fetcher;
  }
}
