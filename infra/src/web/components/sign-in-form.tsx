"use client";

/**
 * Email sign-in and sign-up, posted to Better Auth through this origin
 * (app/api/auth), which answers with the session cookie.
 */
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
    <div className="card">
      <h2>{mode === "sign-in" ? "Sign in" : "Create an account"}</h2>
      <form onSubmit={submit}>
        <input name="email" type="email" placeholder="email" autoComplete="email" required />
        <input
          name="password"
          type="password"
          placeholder="password (8+ characters)"
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          minLength={8}
          required
        />
        <button type="submit" disabled={busy}>
          {mode === "sign-in" ? "Sign in" : "Sign up"}
        </button>
      </form>
      {failure === undefined ? null : <p className="error">{failure}</p>}
      <button type="button" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>
        {mode === "sign-in" ? "No account? Sign up" : "Have an account? Sign in"}
      </button>
    </div>
  );
}
