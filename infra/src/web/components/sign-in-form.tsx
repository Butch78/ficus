"use client";

/**
 * Email sign-in and sign-up, posted to Better Auth through this origin
 * (app/api/auth), which answers with the session cookie.
 */
import { Banner, Button, Input, LayerCard } from "@cloudflare/kumo";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type FormEvent, useState } from "react";

type Mode = "sign-in" | "sign-up";

/** Better Auth's refusal: `{ message }`, e.g. "Invalid email or password". */
const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ message: Schema.String })));

const failureOf = async (response: Response) =>
  Option.match(decodeRefusal(await response.text()), {
    onNone: () => `${response.status} ${response.statusText}`,
    onSome: (refusal) => refusal.message,
  });

const field = (form: FormData, name: string) => {
  const value = form.get(name);

  return value instanceof File ? "" : (value ?? "");
};

export function SignInForm() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

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

  return (
    <LayerCard className="mx-auto w-full max-w-md">
      <LayerCard.Secondary>{mode === "sign-in" ? "Sign in" : "Create an account"}</LayerCard.Secondary>
      <LayerCard.Primary>
        <form onSubmit={submit} className="flex flex-col gap-4">
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
            <Button type="submit" variant="primary" loading={busy}>
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
