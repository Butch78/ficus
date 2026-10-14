/**
 * Glob patterns over repository paths, as a check's `paths` in `ficus.toml`
 * names them: `*` is any run of characters within one path segment, `?` one
 * such character, `**` any number of whole segments (none included). A
 * pattern also matches everything under a directory it matches, so `docs`,
 * `docs/` and `docs/**` all match `docs/guide.md`. A leading `./` or `/` is
 * dropped: patterns are relative to the repo root. Pure.
 */

/** The pattern as it is matched: trimmed, without a leading `./` or `/` or a trailing `/`. Empty means it names nothing. */
export const normalizePattern = (pattern: string) =>
  pattern
    .trim()
    .replace(/^(?:\.\/|\/)+/, "")
    .replace(/\/+$/, "");

const globSource = (pattern: string) => {
  let source = "";

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? "";

    if (character === "*" && pattern[index + 1] === "*") {
      // `**/` is any leading directories, none included; `**` elsewhere is anything.
      const directories = pattern[index + 2] === "/";

      index += directories ? 2 : 1;
      source += directories ? "(?:.*/)?" : ".*";
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return source;
};

/** A matcher for `pattern`: true for a path it matches, or one under a directory it matches. */
export const globMatcher = (pattern: string) => {
  const normal = normalizePattern(pattern);
  const glob = new RegExp(`^${globSource(normal)}$`);

  return (path: string) => {
    if (normal === "") {
      return false;
    }

    const segments = path.split("/");

    return segments.some((_, index) => glob.test(segments.slice(0, index + 1).join("/")));
  };
};

/** Whether `path` matches `pattern`. */
export const globMatches = (pattern: string, path: string) => globMatcher(pattern)(path);

/** Whether any of `paths` matches any of `patterns`. */
export const anyMatches = (patterns: ReadonlyArray<string>, paths: ReadonlyArray<string>) => {
  const matchers = patterns.map(globMatcher);

  return paths.some((path) => matchers.some((matches) => matches(path)));
};
