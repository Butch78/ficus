/**
 * Where GitHub sends someone after they install the Ficus GitHub App (its
 * setup URL): back to their organizations, where each one's page offers the
 * repos they just chose.
 */
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function GitHubInstalled() {
  redirect("/");
}
