"use client";

/**
 * Email sign-in and sign-up, posted to Better Auth through this origin
 * (app/api/auth), which answers with the session cookie; and, where the stage
 * has a GitHub OAuth app, GitHub sign-in, which leaves for GitHub and comes
 * back to /api/auth/callback/github on this origin.
 */
import { Banner, Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { GithubLogoIcon } from "@phosphor-icons/react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type FormEvent, useEffect, useState } from "react";

type Mode = "sign-in" | "sign-up";

/** Better Auth's refusal: `{ message }`, e.g. "Invalid email or password". */
const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ message: Schema.String })));

const failureOf = async (response: Response) =>
  Option.match(decodeRefusal(await response.text()), {
    onNone: () => `${response.status} ${response.statusText}`,
    onSome: (refusal) => refusal.message,
  });

/** Better Auth's answer to a social sign-in: where to send the browser. */
const decodeRedirect = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ url: Schema.String })));

const field = (form: FormData, name: string) => {
  const value = form.get(name);

  return value instanceof File ? "" : (value ?? "");
};

interface Props {
  /** Whether the stage offers GitHub sign-in. */
  readonly github: boolean;
  /** Why a GitHub sign-in came back refused, if one did. */
  readonly refused: string | undefined;
}

export function SignInForm({ github, refused }: Props) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [failure, setFailure] = useState<string | undefined>(refused === undefined ? undefined : `GitHub sign-in failed: ${refused}`);
  const [busy, setBusy] = useState(false);
  // Until React has hydrated, a submit would be the browser's own: a GET
  // with the password in the URL. The button waits for `submit` to exist.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);

    const form = new FormData(event.currentTarget);
    const email = field(form, "email");
    const fields = { email, password: field(form, "password"), name: email.split("@")[0] ?? email };

    const response = await fetch(`/api/auth/${mode}/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });

    if (response.ok) {
      window.location.assign("/");

      return;
    }

    setFailure(await failureOf(response));
    setBusy(false);
  };

  const withGitHub = async () => {
    setBusy(true);
    setFailure(undefined);

    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: "/", errorCallbackURL: "/sign-in" }),
    });

    const redirect = response.ok ? decodeRedirect(await response.text()) : Option.none();

    if (Option.isSome(redirect)) {
      window.location.assign(redirect.value.url);

      return;
    }

    setFailure(response.ok ? "GitHub sign-in did not answer with where to go" : await failureOf(response));
    setBusy(false);
  };

  return (
    <LayerCard className="mx-auto w-full max-w-md">
      <LayerCard.Secondary>{mode === "sign-in" ? "Sign in" : "Create an account"}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        {github ? (
          <>
            <Button type="button" variant="secondary" className="w-full justify-center" icon={<GithubLogoIcon />} loading={busy} disabled={!hydrated} onClick={() => void withGitHub()}>
              Continue with GitHub
            </Button>
            <Text variant="secondary" size="xs">
              or with email
            </Text>
          </>
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
