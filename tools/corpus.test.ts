import { describe, expect, test } from "bun:test";
import { CORPUS_FILES, CORPUS_WALKED_DIRS, corpusListed, corpusPath } from "./corpus.ts";
import { corpusTest } from "./corpus-test.ts";

describe("which corpus paths a test may open", () => {
  test("every file of the manifest", () => {
    for (const f of CORPUS_FILES) expect([f, corpusListed(f)]).toEqual([f, true]);
  });

  test("the directories that hold listed files, with or without a trailing slash", () => {
    for (const d of ["catalogue", "captures", "demo/openknx", "collections/in-service", "catalogue/"]) expect([d, corpusListed(d)]).toEqual([d, true]);
  });

  test("a file the manifest does not list is refused, whatever its neighbours", () => {
    for (const f of ["captures/not-listed.log", "catalogue/M-0000_A-0000-00-0000.xml.gz", "captures/auro-m0081-ets-fulldownload.log.bak", "unlisted.json"]) {
      expect([f, corpusListed(f)]).toEqual([f, false]);
    }
  });

  test("a path that leaves the corpus, or only reaches a listed file by way of a detour, is judged by where it lands", () => {
    expect(corpusListed("../captures/auro-m0081-ets-fulldownload.log")).toBe(false);
    expect(corpusListed("/captures/auro-m0081-ets-fulldownload.log")).toBe(false);
    expect(corpusListed("captures/../captures/auro-m0081-ets-fulldownload.log")).toBe(true);
    expect(corpusListed("captures/../captures/not-listed.log")).toBe(false);
  });

  test("everything under a walked directory", () => {
    for (const d of CORPUS_WALKED_DIRS) {
      expect(corpusListed(d)).toBe(true);
      expect(corpusListed(`${d}/runs/x.evidence.json`)).toBe(true);
    }
  });

  test("a project only when the download records name it", () => {
    const recorded = () => new Set(["collections/some-run/recorded.knxproj"]);
    expect(corpusListed("collections/some-run/recorded.knxproj", recorded)).toBe(true);
    expect(corpusListed("collections/some-run/other.knxproj", recorded)).toBe(false);
    expect(corpusListed("collections/some-run/recorded.knxproj")).toBe(false);
    expect(corpusListed("collections/some-run/recorded.json", () => new Set(["collections/some-run/recorded.json"]))).toBe(false);
  });
});

describe("corpusPath", () => {
  corpusTest("refuses a file that is not listed, naming it and CORPUS_FILES", () => {
    expect(() => corpusPath("captures/not-listed.log")).toThrow(/captures\/not-listed\.log is read from the private corpus but is not listed in CORPUS_FILES/);
  });

  corpusTest("hands out a listed file", () => {
    expect(corpusPath("captures/auro-m0081-ets-fulldownload.log")).toEndWith("/captures/auro-m0081-ets-fulldownload.log");
  });
});
