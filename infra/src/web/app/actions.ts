"use server";

/**
 * The UI's writes, as server actions: each calls the Api with the caller's
 * session and lands back on the page it came from, with `?error=` when the
 * Api refused.
 */
import * as Result from "effect/Result";
import { redirect } from "next/navigation";
import * as Api from "../lib/api.ts";
import { attempt } from "../lib/run.ts";

/** A text field; an uploaded file in its place reads as empty. */
const field = (form: FormData, name: string) => {
  const value = form.get(name);

  return value instanceof File ? "" : (value ?? "").trim();
};

const back = (page: string, outcome: Result.Result<unknown, Api.ApiError>, next: string) =>
  Result.isSuccess(outcome) ? next : `${page}?error=${encodeURIComponent(outcome.failure.message)}`;

/** Slugs name organizations in URLs: lowercase letters, digits and hyphens. */
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

export async function createOrganization(form: FormData) {
  const name = field(form, "name");
  const slug = slugOf(name);
  const outcome = await attempt(Api.createOrganization(name, slug));

  redirect(back("/", outcome, `/orgs/${slug}`));
}

export async function plantTree(form: FormData) {
  const org = field(form, "org");
  const tree = field(form, "tree");
  const source = field(form, "source");
  // Marks this plant's trace, so either page it lands on can show what happened.
  const operation = crypto.randomUUID();
  const outcome = await attempt(Api.plant(org, tree, source, operation));
  const page = `/orgs/${encodeURIComponent(org)}`;

  // The tree page confirms the plant; a refusal names the tree it was for.
  redirect(
    Result.isSuccess(outcome)
      ? `${page}/trees/${encodeURIComponent(tree)}?planted=${encodeURIComponent(source)}&trace=${operation}`
      : `${page}?error=${encodeURIComponent(`Could not plant ${tree}: ${outcome.failure.message}`)}&trace=${operation}`,
  );
}
