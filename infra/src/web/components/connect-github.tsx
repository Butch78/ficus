"use client";

/**
 * Connect a GitHub account to the signed-in person (Better Auth's
 * `link-social`, through this origin): GitHub asks them to authorize the
 * Ficus GitHub App, then sends them back to `back`. Once connected, Ficus
 * offers the repos they reach through the app.
 */
import { Banner, Button } from "@cloudflare/kumo";
import { GithubLogoIcon } from "@phosphor-icons/react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";

const decodeRedirect = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ url: Schema.String })));

export function ConnectGitHub({ back }: { readonly back: string }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const connect = async () => {
    setBusy(true);
    setFailure(undefined);

    const response = await fetch("/api/auth/link-social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: back, errorCallbackURL: back }),
    });

    const redirect = response.ok ? decodeRedirect(await response.text()) : Option.none();

    if (Option.isSome(redirect)) {
      window.location.assign(redirect.value.url);

      return;
    }

    setFailure(`could not start connecting GitHub (${response.status})`);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="primary" icon={<GithubLogoIcon />} loading={busy} onClick={() => void connect()} className="self-start">
        Connect GitHub
      </Button>
      {failure === undefined ? null : <Banner variant="error" size="sm" description={failure} />}
    </div>
  );
}
