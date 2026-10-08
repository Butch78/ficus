/**
 * Where a page sends a visitor when the Api refuses. The Api answers an
 * anonymous caller 404 for a tree it may not read (src/core/visibility.ts), so
 * a signed-out 404 could be a private tree of theirs: they sign in. A
 * signed-in 404 is a thing that does not exist for them.
 */
export const landing = (status: number, hasSession: boolean) => {
  if (status === 401 || (status === 404 && !hasSession)) {
    return "sign-in";
  }

  return status === 404 ? "not-found" : "error";
};
