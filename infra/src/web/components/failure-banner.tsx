import { Banner } from "@cloudflare/kumo";

/** The `?error=` a server action came back with, if any. */
export function FailureBanner({ error }: { readonly error: string | undefined }) {
  return error === undefined ? null : <Banner variant="error" title="The Api refused" description={error} />;
}
