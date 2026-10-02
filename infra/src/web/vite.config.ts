// The web UI: vinext (Next.js's App Router on Vite) on Workers. Deployed by
// web.run.ts through Cloudflare.Website.Vinext, which injects alchemy's own
// Cloudflare Vite plugin: do not register @cloudflare/vite-plugin here.
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [vinext()] });
