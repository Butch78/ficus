"use client";

import { Button } from "@cloudflare/kumo";
import { SignOutIcon } from "@phosphor-icons/react";

export function SignOutButton() {
  const signOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    window.location.assign("/sign-in");
  };

  return (
    <Button variant="ghost" size="sm" icon={SignOutIcon} onClick={signOut}>
      Sign out
    </Button>
  );
}
