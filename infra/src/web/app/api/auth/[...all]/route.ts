/**
 * Better Auth, through the UI's own origin: the browser signs in here, so
 * its session cookie belongs to this origin and rides along on every page
 * load. The request goes to the Api unchanged (same URL, same Origin), which
 * builds Better Auth for this origin (src/api/auth.ts).
 */
import { env } from "cloudflare:workers";

const forward = async (request: Request) => {
  const answer = await env.API.fetch(new Request(request.url, request));

  // A fetched Response's headers are immutable; the framework appends to them.
  return new Response(answer.body, answer);
};

export const GET = forward;

export const POST = forward;
