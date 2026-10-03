/**
 * Kumo's styling rules, held for the UI's own sources: colors come from
 * Kumo's semantic tokens (bg-kumo-base, text-kumo-subtle, border-kumo-line,
 * ...), never Tailwind's palette or literal colors, and there is no `dark:`
 * variant, since Kumo's tokens switch with the mode themselves.
 * https://kumo-ui.com, and @cloudflare/kumo/ai/USAGE.md.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

const RULES = [
  ["a Tailwind palette color", new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow|decoration|accent|caret)-(?:${PALETTE})-\\d{2,3}\\b`)],
  ["a `dark:` variant", /(?:^|[\s"'`])dark:/],
  ["a literal color", /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl|oklch)a?\(/],
] as const;

const sources = Array.from(new Glob("{app,components,lib}/**/*.{ts,tsx,css}").scanSync(import.meta.dir));

describe("Kumo styling", () => {
  test("finds the UI's sources", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  test.each(sources)("%s uses Kumo's semantic tokens only", async (source) => {
    const text = await Bun.file(`${import.meta.dir}/${source}`).text();

    const broken = RULES.flatMap(([rule, pattern]) =>
      text.split("\n").flatMap((line, index) => (pattern.test(line) ? [`line ${index + 1}: ${rule}: ${line.trim()}`] : [])),
    );

    expect(broken).toEqual([]);
  });
});
