/**
 * The mail Ficus sends: a link confirming that an email address is yours.
 * Better Auth makes the link (src/api/auth.ts); the Api sends it through the
 * stage's Cloudflare Email Sending binding (worker.ts). A confirmed address is
 * what lets signing in with Cloudflare or GitHub join the account that already
 * has it, rather than refusing ("account not linked").
 */

/** One message, ready for the binding's `send`. */
export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Sends a message; absent where the stage has no way to send. */
export type Mailer = (mail: Mail) => Promise<void>;

const ESCAPES = new Map([["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"]]);

const escape = (text: string) => text.replaceAll(/[&<>"']/gu, (character) => ESCAPES.get(character) ?? character);

/** The message carrying `url`, Better Auth's verification link, to `to`. */
export const verificationMail = (to: string, url: string): Mail => ({
  to,
  subject: "Confirm your email for Ficus",
  text: [
    "Confirm this email address to finish signing up for Ficus:",
    "",
    url,
    "",
    "Once it is confirmed you can also sign in with Cloudflare or GitHub as this address.",
    "If you did not sign up, ignore this message.",
  ].join("\n"),
  html: [
    "<p>Confirm this email address to finish signing up for Ficus:</p>",
    `<p><a href="${escape(url)}">Confirm my email</a></p>`,
    "<p>Once it is confirmed you can also sign in with Cloudflare or GitHub as this address.</p>",
    "<p>If you did not sign up, ignore this message.</p>",
  ].join("\n"),
});
