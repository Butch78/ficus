"use server";

/**
 * The UI's writes, as server actions: each calls the Api with the caller's
 * session and lands back on the page it came from, with `?error=` when the
 * Api refused.
 */
import * as Result from "effect/Result";
import { redirect } from "next/navigation";
import * as Api from "../lib/api.ts";
import { run } from "../lib/run.ts";

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
  const outcome = await run(Api.createOrganization(name, slug));

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

export async function createTask(form: FormData) {
  const [org, tree] = [field(form, "org"), field(form, "tree")];
  const operation = crypto.randomUUID();
  const outcome = await run(Api.createTask(org, tree, field(form, "intent"), operation));
  const page = treePage(org, tree);

  redirect(landed(page, "task", operation, outcome, Result.isSuccess(outcome) ? `${page}/tasks/${outcome.success.task}` : page));
}

export async function setVisibility(form: FormData) {
  const [org, tree] = [field(form, "org"), field(form, "tree")];
  const operation = crypto.randomUUID();
  const outcome = await run(Api.setVisibility(org, tree, field(form, "public") === "true", operation));

  redirect(landed(treePage(org, tree), "visibility", operation, outcome));
}

export async function acceptTask(form: FormData) {
  const [org, tree, task] = [field(form, "org"), field(form, "tree"), id(form, "task")];
  const operation = crypto.randomUUID();
  const outcome = await run(Api.accept(org, tree, task, operation));

  redirect(landed(`${treePage(org, tree)}/tasks/${task}`, "accept", operation, outcome));
}

export async function retryAttempt(form: FormData) {
  const [org, tree, attempt] = [field(form, "org"), field(form, "tree"), id(form, "attempt")];
  const operation = crypto.randomUUID();
  const outcome = await run(Api.retry(org, tree, attempt, operation));
  const page = `${treePage(org, tree)}/attempts/${attempt}`;

  redirect(
    landed(page, "retry", operation, outcome, Result.isSuccess(outcome) ? `${treePage(org, tree)}/attempts/${outcome.success.attempt}` : page),
  );
}

export async function abandonAttempt(form: FormData) {
  const [org, tree, attempt] = [field(form, "org"), field(form, "tree"), id(form, "attempt")];
  const operation = crypto.randomUUID();
  const note = field(form, "note") || "abandoned from the UI";
  const outcome = await run(Api.abandon(org, tree, attempt, note, operation));

  redirect(landed(`${treePage(org, tree)}/attempts/${attempt}`, "abandon", operation, outcome));
}

export async function submitAttempt(form: FormData) {
  const [org, tree, attempt] = [field(form, "org"), field(form, "tree"), id(form, "attempt")];
  const operation = crypto.randomUUID();
  const outcome = await run(Api.submit(org, tree, attempt, operation));

  redirect(landed(`${treePage(org, tree)}/attempts/${attempt}`, "submit", operation, outcome));
}

/** The model agents run unless the person picks another (src/agents/actor.ts `DEFAULT_MODEL`). */
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";

export async function startAgents(form: FormData) {
  const [org, tree, task] = [field(form, "org"), field(form, "tree"), id(form, "task")];
  const operation = crypto.randomUUID();

  const outcome = await run(
    Api.startAgents(org, tree, task, id(form, "agents") || 3, field(form, "model") || DEFAULT_MODEL, operation),
  );

  redirect(landed(`${treePage(org, tree)}/tasks/${task}`, "agents", operation, outcome));
}
