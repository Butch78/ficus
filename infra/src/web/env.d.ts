// The bindings web.run.ts gives this Worker, as `import { env } from "cloudflare:workers"` sees them.
declare namespace Cloudflare {
  interface Env {
    /** The Ficus Api (src/api), over a service binding. */
    readonly API: Fetcher;
    /** Reads Workers Observability for the activity panel; absent where tracing is not configured. */
    readonly FICUS_OBSERVABILITY_TOKEN?: string;
    readonly CLOUDFLARE_ACCOUNT_ID?: string;
  }
}
