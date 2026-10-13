/**
 * Git remotes as Ficus shows and keeps them. A private GitHub repo is
 * imported from a URL carrying a short-lived token
 * (`https://x-access-token:<token>@github.com/...`, src/api/github.ts); the
 * token must never reach a progress line or the tree's history.
 */

/** `url` with any user name and password removed; text that is not a URL is returned as it is. */
export const withoutCredentials = (url: string) => {
  if (!URL.canParse(url)) {
    return url;
  }

  const parsed = new URL(url);

  if (parsed.username === "" && parsed.password === "") {
    return url;
  }

  parsed.username = "";
  parsed.password = "";

  return parsed.toString();
};

/** Whether `url` carries a user name or password: such a remote is copied over git, not imported (Artifacts refuses them). */
export const hasCredentials = (url: string) => withoutCredentials(url) !== url;

/** `text` with the credentials of any URL in it removed: for messages that may quote a remote, like Artifacts' errors. */
export const redactCredentials = (text: string) => text.replaceAll(/(\w+:\/\/)[^/@\s]+@/gu, "$1");
