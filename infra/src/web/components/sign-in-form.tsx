"use client";

/**
 * Email sign-in and sign-up, posted to Better Auth through this origin
 * (app/api/auth), which answers with the session cookie; and, where the stage
 * has a GitHub OAuth app or a Cloudflare OAuth client, signing in with those,
 * which leaves for them and comes back to /api/auth/callback/<provider> on
 * this origin. Where the stage sends mail, a new email address is confirmed
 * first (src/api/mail.ts): sign-up answers without a session and the form
 * says to follow the link.
 */
import { Banner, Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { CloudIcon, GithubLogoIcon } from "@phosphor-icons/react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type FormEvent, useEffect, useState } from "react";

type Mode = "sign-in" | "sign-up";

/** Better Auth's refusal: `{ message, code? }`, e.g. "Invalid email or password". */
const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ message: Schema.String, code: Schema.optional(Schema.String) })));

/** Signing in with an address not yet confirmed: Better Auth has just sent a new link. */
const UNCONFIRMED = "EMAIL_NOT_VERIFIED";

const refusalOf = async (response: Response) =>
  Option.match(decodeRefusal(await response.text()), {
    onNone: () => ({ message: `${response.status} ${response.statusText}`, code: undefined }),
    onSome: (refusal) => refusal,
  });

const failureOf = async (response: Response) => (await refusalOf(response)).message;

/** Better Auth's answer to an email sign-up: no session token while the address waits to be confirmed. */
const decodeSignedUp = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ token: Schema.NullOr(Schema.String) })));

/** Why a Cloudflare or GitHub sign-in came back refused, said for the person (Better Auth's error codes). */
const refusedWhy = (code: string) =>
  code === "account_not_linked"
    ? "You already have a Ficus account with this email, not yet confirmed. Sign in with your email and password, follow the link we send you, then continue with Cloudflare or GitHub."
    : `Signing in failed: ${code}`;

/** Better Auth's answer to a social sign-in: where to send the browser. */
const decodeRedirect = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ url: Schema.String })));

const field = (form: FormData, name: string) => {
  const value = form.get(name);

  return value instanceof File ? "" : (value ?? "");
};

interface Props {
  /** Whether the stage offers GitHub sign-in. */
  readonly github: boolean;
  /** Whether the stage offers signing in with Cloudflare, whose agents then run on an account of yours. */
  readonly cloudflare: boolean;
  /** Why a GitHub or Cloudflare sign-in came back refused, if one did. */
  readonly refused: string | undefined;
}

/** Where each sign-in starts: both are Better Auth social providers (Cloudflare through the generic OAuth plugin, which registers it as one). */
const STARTS = {
  github: { path: "/api/auth/sign-in/social", body: { provider: "github" } },
  cloudflare: { path: "/api/auth/sign-in/social", body: { provider: "cloudflare" } },
} as const;

export function SignInForm({ github, cloudflare, refused }: Props) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [failure, setFailure] = useState<string | undefined>(refused === undefined ? undefined : refusedWhy(refused));
  // Where a confirmation link went, once one is on its way.
  const [sentTo, setSentTo] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Until React has hydrated, a submit would be the browser's own: a GET
  // with the password in the URL. The button waits for `submit` to exist.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    setSentTo(undefined);

    const form = new FormData(event.currentTarget);
    const email = field(form, "email");
    const fields = { email, password: field(form, "password"), name: email.split("@")[0] ?? email };

    const response = await fetch(`/api/auth/${mode}/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Where a confirmation link lands once followed, signed in.
      body: JSON.stringify({ ...fields, callbackURL: "/" }),
    });

    if (response.ok) {
      const signedUp = mode === "sign-up" ? decodeSignedUp(await response.text()) : Option.none();

      if (Option.isSome(signedUp) && signedUp.value.token === null) {
        setSentTo(email);
        setBusy(false);

        return;
      }

      window.location.assign("/");

      return;
    }

    const refusal = await refusalOf(response);

    if (refusal.code === UNCONFIRMED) {
      setSentTo(email);
    } else {
      setFailure(refusal.message);
    }

    setBusy(false);
  };

  const withProvider = async (provider: keyof typeof STARTS) => {
    setBusy(true);
    setFailure(undefined);

    const start = STARTS[provider];

    const response = await fetch(start.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...start.body, callbackURL: "/", errorCallbackURL: "/sign-in" }),
    });

    const redirect = response.ok ? decodeRedirect(await response.text()) : Option.none();

    if (Option.isSome(redirect)) {
      window.location.assign(redirect.value.url);

      return;
    }

    setFailure(response.ok ? "the sign-in did not answer with where to go" : await failureOf(response));
    setBusy(false);
  };

  return (
    <LayerCard className="mx-auto w-full max-w-md">
      <LayerCard.Secondary>{mode === "sign-in" ? "Sign in" : "Create an account"}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        {cloudflare ? (
          <Button type="button" variant="primary" className="w-full justify-center" icon={<CloudIcon />} loading={busy} disabled={!hydrated} onClick={() => void withProvider("cloudflare")}>
            Continue with Cloudflare
          </Button>
        ) : null}
        {github ? (
          <Button type="button" variant="secondary" className="w-full justify-center" icon={<GithubLogoIcon />} loading={busy} disabled={!hydrated} onClick={() => void withProvider("github")}>
            Continue with GitHub
          </Button>
        ) : null}
        {github || cloudflare ? (
          <Text variant="secondary" size="xs">
            or with email
          </Text>
        ) : null}
        <form method="post" onSubmit={submit} className="flex flex-col gap-4">
          <Input name="email" type="email" label="Email" autoComplete="email" required />
          <Input
            name="password"
            type="password"
            label="Password"
            description={mode === "sign-up" ? "At least 8 characters." : undefined}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={8}
            required
          />
          {failure === undefined ? null : <Banner variant="error" size="sm" description={failure} />}
          {sentTo === undefined ? null : (
            <Banner size="sm" title="Check your email" description={`We sent a link to ${sentTo}. Follow it to confirm the address and sign in.`} />
          )}
          <div className="flex items-center justify-between gap-2">
            <Button type="submit" variant="primary" loading={busy} disabled={!hydrated}>
              {mode === "sign-in" ? "Sign in" : "Sign up"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>
              {mode === "sign-in" ? "No account? Sign up" : "Have an account? Sign in"}
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  );
}
