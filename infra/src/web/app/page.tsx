import { Empty, Input, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import { redirect } from "next/navigation";
import { FailureBanner } from "../components/failure-banner.tsx";
import { SignOutButton } from "../components/sign-out-button.tsx";
import { SubmitButton } from "../components/submit-button.tsx";
import * as Api from "../lib/api.ts";
import { load } from "../lib/run.ts";
import { createOrganization } from "./actions.ts";
import { LayerCardPrimary, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/kumo.ts";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { readonly searchParams: Promise<{ error?: string }> }) {
  const session = await load(Api.session);

  if (session === null) {
    redirect("/sign-in");
  }

  const [organizations, { error }] = await Promise.all([load(Api.organizations), searchParams]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text variant="heading" as="h2" size="lg">
          Organizations
        </Text>
        <span className="flex items-center gap-3">
          <Text variant="secondary" as="span" size="sm">
            {session.user.email}
          </Text>
          <SignOutButton />
        </span>
      </div>
      <FailureBanner error={error} />
      {organizations.length === 0 ? (
        <Empty title="No organizations yet" description="Create one to init trees in." />
      ) : (
        <LayerCard>
          <LayerCardPrimary className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.map((organization) => (
                  <TableRow key={organization.id}>
                    <TableCell>
                      <Link href={`/orgs/${organization.slug}`}>{organization.name}</Link>
                    </TableCell>
                    <TableCell>
                      <Text variant="mono-secondary">
                        {organization.slug}
                      </Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </LayerCardPrimary>
        </LayerCard>
      )}
      <form action={createOrganization} className="flex flex-wrap items-end gap-2">
        <Input name="name" label="New organization" placeholder="acme" required />
        <SubmitButton pending="Creating…">Create</SubmitButton>
      </form>
    </>
  );
}
