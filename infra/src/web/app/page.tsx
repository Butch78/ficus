import { redirect } from "next/navigation";
import { SignOutButton } from "../components/sign-out-button.tsx";
import * as Api from "../lib/api.ts";
import { load } from "../lib/run.ts";
import { createOrganization } from "./actions.ts";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { readonly searchParams: Promise<{ error?: string }> }) {
  const session = await load(Api.session);

  if (session === null) {
    redirect("/sign-in");
  }

  const [organizations, { error }] = await Promise.all([load(Api.organizations), searchParams]);

  return (
    <>
      <p className="muted">
        Signed in as {session.user.email} <SignOutButton />
      </p>
      <h2>Organizations</h2>
      {organizations.length === 0 ? <p className="muted">None yet: create one to plant trees in.</p> : null}
      <ul>
        {organizations.map((organization) => (
          <li key={organization.id}>
            <a href={`/orgs/${organization.slug}`}>{organization.name}</a> <code className="muted">{organization.slug}</code>
          </li>
        ))}
      </ul>
      <form action={createOrganization}>
        <input name="name" placeholder="new organization" required />
        <button type="submit">Create</button>
      </form>
      {error === undefined ? null : <p className="error">{error}</p>}
    </>
  );
}
