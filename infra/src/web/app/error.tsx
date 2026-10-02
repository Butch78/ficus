"use client";

import { Banner, Link } from "@cloudflare/kumo";

export default function Failed({ error }: { readonly error: Error }) {
  return (
    <Banner
      variant="error"
      title="Something went wrong"
      description={error.message}
      action={<Link href="/">Back to your organizations</Link>}
    />
  );
}
