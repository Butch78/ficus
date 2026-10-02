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

/** A number field: an id. */
const id = (form: FormData, name: string) => Number(field(form, name));

const treePage = (org: string, tree: string) => `/orgs/${encodeURIComponent(org)}/trees/${encodeURIComponent(tree)}`;

/**
 * Where a change lands: `next` on success, `page` with the Api's reason when
 * refused; either way with the operation, so the page can show its trace.
 */
const landed = (page: string, op: string, operation: string, outcome: Result.Result<unknown, Api.ApiError>, next = page) => {
  const query = new URLSearchParams({ op, trace: operation });

  if (Result.isFailure(outcome)) {
    query.set("error", outcome.failure.message);

    return `${page}?${query.toString()}`;
  }

  return `${next}?${query.toString()}`;
};

export async function createBud(form: FormData) {
  const [org, tree] = [field(form, "org"), field(form, "tree")];
  const operation = crypto.randomUUID();
  const outcome = await attempt(Api.createBud(org, tree, field(form, "intent"), operation));
  const page = treePage(org, tree);

  redirect(landed(page, "bud", operation, outcome, Result.isSuccess(outcome) ? `${page}/buds/${outcome.success.bud}` : page));
}

export async function harvestBud(form: FormData) {
  const [org, tree, bud] = [field(form, "org"), field(form, "tree"), id(form, "bud")];
  const operation = crypto.randomUUID();
  const outcome = await attempt(Api.harvest(org, tree, bud, operation));

  redirect(landed(`${treePage(org, tree)}/buds/${bud}`, "harvest", operation, outcome));
}

export async function regrowLeaf(form: FormData) {
  const [org, tree, leaf] = [field(form, "org"), field(form, "tree"), id(form, "leaf")];
  const operation = crypto.randomUUID();
  const outcome = await attempt(Api.regrow(org, tree, leaf, operation));
  const page = `${treePage(org, tree)}/leaves/${leaf}`;

  redirect(
    landed(page, "regrow", operation, outcome, Result.isSuccess(outcome) ? `${treePage(org, tree)}/leaves/${outcome.success.leaf}` : page),
  );
}

export async function witherLeaf(form: FormData) {
  const [org, tree, leaf] = [field(form, "org"), field(form, "tree"), id(form, "leaf")];
  const operation = crypto.randomUUID();
  const note = field(form, "note") || "withered from the UI";
  const outcome = await attempt(Api.wither(org, tree, leaf, note, operation));

  redirect(landed(`${treePage(org, tree)}/leaves/${leaf}`, "wither", operation, outcome));
}

export async function submitLeaf(form: FormData) {
  const [org, tree, leaf] = [field(form, "org"), field(form, "tree"), id(form, "leaf")];
  const operation = crypto.randomUUID();
  const outcome = await attempt(Api.submit(org, tree, leaf, operation));

  redirect(landed(`${treePage(org, tree)}/leaves/${leaf}`, "submit", operation, outcome));
}
