import { describe, expect, test } from "bun:test";
import { advertisedRefs, pktLine, pushAccepted, wantedCommit } from "./git-copy.ts";

const A = "a".repeat(40);

const B = "b".repeat(40);

/** An upload-pack advertisement as GitHub sends it: the service line, a flush, the refs with HEAD's capabilities, a flush. */
const advertisement = [
  pktLine("# service=git-upload-pack\n"),
  "0000",
  pktLine(`${A} HEAD\0multi_ack thin-pack side-band symref=HEAD:refs/heads/main agent=git/github\n`),
  pktLine(`${A} refs/heads/main\n`),
  pktLine(`${B} refs/heads/feature\n`),
  "0000",
].join("");

describe("pktLine", () => {
  test("prefixes the length, counting its own four digits", () => {
    expect(pktLine("done\n")).toBe("0009done\n");
    expect(pktLine("# service=git-upload-pack\n")).toBe("001e# service=git-upload-pack\n");
  });
});

describe("advertisedRefs", () => {
  test("reads every ref and where HEAD points", () => {
    const advertised = advertisedRefs(advertisement);

    expect(advertised.head).toBe("refs/heads/main");
    expect(advertised.refs.get("refs/heads/feature")).toBe(B);
    expect(advertised.refs.get("HEAD")).toBe(A);
  });
});

describe("wantedCommit", () => {
  test("is the asked branch's commit, else the default branch's", () => {
    const advertised = advertisedRefs(advertisement);

    expect(wantedCommit(advertised, "feature")).toBe(B);
    expect(wantedCommit(advertised, undefined)).toBe(A);
    expect(wantedCommit(advertised, "missing")).toBeUndefined();
  });
});

describe("pushAccepted", () => {
  test("needs the pack unpacked and the ref written", () => {
    expect(pushAccepted(`${pktLine("unpack ok\n")}${pktLine("ok refs/heads/main\n")}0000`, "refs/heads/main")).toBe(true);
    expect(pushAccepted(`${pktLine("unpack ok\n")}${pktLine("ng refs/heads/main non-fast-forward\n")}0000`, "refs/heads/main")).toBe(false);
  });
});
