import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import ficusToml from "../../../ficus.toml" with { type: "text" };
import {
  type CheckOutcome,
  checkTimeoutSecs,
  clipDiff,
  checkRoot,
  decodeRoot,
  DEFAULT_CHECK_TIMEOUT_SECS,
  DEFAULT_DEPLOY_TIMEOUT_SECS,
  deployTimeoutSecs,
  DEFAULT_PASS_AT,
  JUDGE_DIFF_CHARS,
  MAX_FETCH_HOSTS,
  passAt,
  phasesFirst,
  scoreOf,
  ScoreReport,
} from "./scoring.ts";

/** The root's config from `ficus.toml` text, as the scorer reads it. */
const parse = (text: string) =>
  Result.try({ try: () => Bun.TOML.parse(text), catch: () => "toml" }).pipe(
    Result.flatMap((parsed) =>
      decodeRoot(parsed, { onExcessProperty: "error" }).pipe(
        Result.mapError(() => "Unparsable"),
        Result.flatMap((root) => checkRoot(root).pipe(Result.mapError((error) => error.kind))),
      ),
    ),
  );

const refusal = (text: string) => {
  const parsed = parse(text);

  return Result.isFailure(parsed) ? parsed.failure : "parsed";
};

const ok = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result);

const outcome = (name: string, passed: boolean, confidence?: number): CheckOutcome => ({
  name,
  origin: "root",
  passed,
  millis: 1,
  tail: "",
  confidence,
});

describe("a root's ficus.toml", () => {
  test("Ficus's own parses", () => {
    expect((ok(parse(ficusToml)).check ?? []).length).toBeGreaterThan(0);
  });

  test("opens named hosts for its fetch, and nothing wider", () => {
    const root = ok(
      parse(`
        [fetch]
        hosts = ["static.crates.io", "index.crates.io", "registry.npmjs.org"]
        run = "cargo fetch --locked"
        timeout_secs = 1800

        [[check]]
        name = "test"
        run = "cargo test"
      `),
    );

    expect(root.fetch?.hosts).toHaveLength(3);
    expect(root.fetch?.run).toBe("cargo fetch --locked");
    expect(ok(parse('[[check]]\nname = "t"\nrun = "true"\n')).fetch).toBeUndefined();

    for (const host of ["*.crates.io", "crates.io:443", "https://crates.io", "localhost", "Crates.io", "-a.io"]) {
      expect(refusal(`[fetch]\nhosts = [${JSON.stringify(host)}]\n[[check]]\nname = "t"\nrun = "true"\n`)).toBe("FetchHost");
    }

    const many = Array.from({ length: MAX_FETCH_HOSTS + 1 }, (_, n) => `"h${n}.example.com"`).join(", ");

    expect(refusal(`[fetch]\nhosts = [${many}]\n[[check]]\nname = "t"\nrun = "true"\n`)).toBe("TooManyHosts");
    expect(refusal('[fetch]\nrun = " "\n[[check]]\nname = "t"\nrun = "true"\n')).toBe("EmptyFetch");
  });

  test("says how a released node deploys, opening named hosts", () => {
    const root = ok(parse('[deploy]\nrun = "bun run deploy"\nhosts = ["registry.npmjs.org"]\n[[check]]\nname = "t"\nrun = "true"\n'));

    expect(root.deploy).toEqual({ run: "bun run deploy", hosts: ["registry.npmjs.org"] });
    expect(deployTimeoutSecs(root.deploy ?? { run: "" })).toBe(DEFAULT_DEPLOY_TIMEOUT_SECS);
    expect(refusal('[deploy]\nrun = "x"\nhosts = ["*.example.com"]\n[[check]]\nname = "t"\nrun = "true"\n')).toBe("DeployHost");
    expect(refusal('[deploy]\nrun = " "\n[[check]]\nname = "t"\nrun = "true"\n')).toBe("EmptyDeploy");
    expect(refusal('[deploy]\nrun = "x"\ndeployer = ""\n[[check]]\nname = "t"\nrun = "true"\n')).toBe("EmptyDeploy");
    expect(ok(parse('[deploy]\nrun = "x"\ndeployer = "y"\n[[check]]\nname = "t"\nrun = "true"\n')).deploy?.deployer).toBe("y");
    expect(refusal('[deploy]\nhosts = []\n[[check]]\nname = "t"\nrun = "true"\n')).toBe("Unparsable");
  });

  test("checks take the default timeout unless they name one", () => {
    const root = ok(parse('[[check]]\nname = "test"\nrun = "pytest -q"\n\n[[check]]\nname = "lint"\nrun = "ruff check ."\ntimeout_secs = 60\n'));

    expect((root.check ?? []).map((check) => [check.name, checkTimeoutSecs(check)])).toEqual([
      ["test", DEFAULT_CHECK_TIMEOUT_SECS],
      ["lint", 60],
    ]);
  });

  test("a root that could never pass, or is ambiguous, is refused", () => {
    expect(refusal("check = []")).toBe("NoChecks");
    expect(refusal('[[check]]\nname = "a"\nrun = "true"\n[[check]]\nname = "a"\nrun = "true"\n')).toBe("DuplicateName");
    expect(refusal('[[check]]\nname = "a"\nrun = "  "\n')).toBe("EmptyRun");
    expect(refusal('[[check]]\nname = "a"\n')).toBe("Unparsable");
    expect(refusal('[[check]]\nname = "a"\nrun = "x"\nsudo = true\n')).toBe("Unparsable");
  });

  test("judges sit beside checks", () => {
    const root = ok(
      parse(`
        [[check]]
        name = "test"
        run = "pytest -q"

        [[judge]]
        name = "does_the_task"
        ask = "Does \`diff\` do everything \`task\` asks?"
        yes = "The whole task is done."
        no = "Part of the task is missing."
        pass_at = 0.7

        [[judge]]
        name = "no-debug.prints"
        ask = "Is \`diff\` free of leftover debug output?"
      `),
    );

    expect((root.judge ?? []).map((judge) => [judge.name, passAt(judge)])).toEqual([
      ["does_the_task", 0.7],
      ["no-debug.prints", DEFAULT_PASS_AT],
    ]);
    expect(ok(parse('[[judge]]\nname = "a"\nask = "Is it good?"\n')).check ?? []).toEqual([]);
  });

  test("judges Clef could not ask, or pass, are refused", () => {
    const judge = (fields: string) => refusal(`[[judge]]\n${fields}\n`);

    expect(refusal('[[check]]\nname = "a"\nrun = "true"\n[[judge]]\nname = "a"\nask = "?"\n')).toBe("DuplicateName");
    expect(judge('name = "has space"\nask = "?"')).toBe("JudgeName");
    expect(judge('name = "a"\nask = " "')).toBe("EmptyAsk");
    expect(judge('name = "a"\nask = "?"\nyes = "good"')).toBe("HalfCriteria");

    for (const value of ["0", "1.5", "-0.2", "nan"]) {
      expect(judge(`name = "a"\nask = "?"\npass_at = ${value}`)).toBe("PassAt");
    }
  });
});

describe("a report", () => {
  test("scores passed over total at its cost", () => {
    const score = ok(scoreOf({ checks: [outcome("a", true), outcome("b", false), outcome("c", true)], cost: 12, touched: [] }));

    expect([score.checks_passed, score.checks_total, score.cost]).toEqual([2, 3, 12]);
    expect(Result.isFailure(scoreOf({ checks: [], cost: 0, touched: [] }))).toBe(true);
  });

  test("with judges, scores their mean confidence", () => {
    const score = ok(scoreOf({ checks: [outcome("test", true), outcome("a", true, 900), outcome("b", true, 700)], cost: 4, touched: [] }));

    expect([score.checks_total, score.confidence]).toEqual([3, 800]);
  });

  test("says where the time went before the checks, the sandbox's phases first; one stored without still decodes", () => {
    const stored = ok(Schema.decodeUnknownResult(ScoreReport)({ checks: [outcome("a", true)], cost: 1 }));
    const scored = { ...stored, phases: [{ name: "clone", millis: 30 }] };

    expect(stored.phases).toBeUndefined();
    expect(phasesFirst([{ name: "sandbox", millis: 900 }], scored).phases).toEqual([{ name: "sandbox", millis: 900 }, { name: "clone", millis: 30 }]);
    expect(ok(Schema.decodeUnknownResult(ScoreReport)(scored))).toEqual(scored);
  });

  test("a long diff is cut at a line end for the judges", () => {
    expect(clipDiff("+a\n-b\n")).toBe("+a\n-b\n");

    const line = `+${"é".repeat(99)}\n`;
    const diff = line.repeat(JUDGE_DIFF_CHARS / 100 + 10);
    const clipped = clipDiff(diff);
    const cut = clipped.lastIndexOf("\n");
    const [body, marker] = [clipped.slice(0, cut), clipped.slice(cut + 1)];

    expect(marker).toBe(`[diff truncated: ${Array.from(diff).length} characters in all]`);
    expect(Array.from(body).length).toBeLessThanOrEqual(JUDGE_DIFF_CHARS);
    expect(body.split("\n").every((each) => each === line.trimEnd())).toBe(true);
  });
});
