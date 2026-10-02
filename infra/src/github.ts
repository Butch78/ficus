/**
 * The repository Ficus's pipeline lives in, and the writes the bootstrap
 * makes into it. One `owner/repository` so no secret can land anywhere else.
 * GitHub encrypts a secret with the repository's public key on the way in; a
 * variable is plain text readable by anyone with read access, so only
 * configuration goes that way.
 */
import * as GitHub from "alchemy/GitHub";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

export const OWNER = "Butch78";

export const REPO = "ficus";

export const REPOSITORY = `${OWNER}/${REPO}`;

/** A repository Actions secret. The value never leaves the encrypted channel. */
export const secret = (
  id: string,
  name: string,
  value: Redacted.Redacted<string> | Output.Output<Redacted.Redacted<string>>,
) => Effect.gen(function* () {
  return yield* GitHub.Secret(id, { owner: OWNER, repository: REPO, name, value });
});

/** A repository Actions variable: configuration, not a credential. */
export const variable = (id: string, name: string, value: string) =>
  Effect.gen(function* () {
    return yield* GitHub.Variable(id, { owner: OWNER, repository: REPO, name, value });
  });
