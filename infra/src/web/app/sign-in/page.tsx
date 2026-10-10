import * as Result from "effect/Result";
import { SignInBackdrop } from "../../components/growth-shader.tsx";
import { SignInForm } from "../../components/sign-in-form.tsx";
import * as Api from "../../lib/api.ts";
import { run } from "../../lib/run.ts";

interface Props {
  /** `error`: GitHub sign-in came back refused (Better Auth's error code). */
  readonly searchParams: Promise<{ error?: string }>;
}

export default async function SignIn({ searchParams }: Props) {
  const [{ error }, providers] = await Promise.all([searchParams, run(Api.providers)]);
  // Offered only once the stage has a GitHub OAuth app; if the Api cannot say, email alone.
  const github = Result.isSuccess(providers) && providers.success.github;

  return (
    <section className="relative isolate flex min-h-[70vh] items-center justify-center overflow-hidden rounded-xl border border-kumo-hairline px-4 py-12">
      <SignInBackdrop className="absolute inset-0 -z-10 h-full w-full" />
      <SignInForm github={github} refused={error} />
    </section>
  );
}
