/** The repo a git remote names, as `Egress` matches it: its host and path. */
export const repoOf = (remote: string) => {
  const url = new URL(remote);

  return { host: url.host, repoPath: url.pathname.replace(/\/$/, "") };
};

/** Whether `pathname` is a request for `repoPath` (git asks for `<repo>.git/info/refs`, ...). */
export const isRepoRequest = (pathname: string, repoPath: string) =>
  pathname === repoPath || pathname.startsWith(`${repoPath}/`);
