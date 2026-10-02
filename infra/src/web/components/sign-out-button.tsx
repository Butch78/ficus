"use client";

export function SignOutButton() {
  const signOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    window.location.assign("/sign-in");
  };

  return (
    <button type="button" onClick={signOut}>
      Sign out
    </button>
  );
}
