import { test, expect, describe } from "bun:test";
import { evaluate, matchesApp, manifest } from "../src/match.ts";

// The gate that decides whether the native module is offered (compatible),
// offered at the user's own risk (matched but incompatible version), or hidden
// (no match). Pure logic, so exercise each branch directly.
describe("evaluate (compatibility)", () => {
  const appId = "M-0048_A-9071-20-F258-O00EF"; // a real Theben DALI gateway app id

  test("matched + supported version => compatible", () => {
    expect(evaluate(appId, 32)).toEqual({ matched: true, compatible: true });
  });

  test("matched + unsupported version => offer at own risk", () => {
    expect(evaluate(appId, 99)).toEqual({ matched: true, compatible: false });
  });

  test("foreign application program => no match", () => {
    expect(evaluate("M-0083_A-1234-10-ABCD", 32)).toEqual({ matched: false, compatible: false });
    expect(evaluate(undefined, 32)).toEqual({ matched: false, compatible: false });
  });

  test("manifest declares the verified version, and matchesApp ignores the version", () => {
    expect(manifest.compatibleAppVersions).toContain(32);
    expect(matchesApp(appId)).toBe(true);
    expect(matchesApp("M-0083_A-1234-10-ABCD")).toBe(false);
  });
});
