import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkImageContext, contextEntries, excluded, leaks, parseDockerignore, parseLeakRule } from "./image-context.ts";
import { tempDir } from "./test-temp.ts";

const ROOT = join(import.meta.dir, "..");
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const DOCKERIGNORE = readFileSync(join(ROOT, ".dockerignore"), "utf8");

// A repository with the real Dockerfile and .dockerignore and the given files.
function repo(files: readonly string[], dockerignore = DOCKERIGNORE): string {
  const dir = tempDir("busforge-image-context-");
  copyFileSync(join(ROOT, "Dockerfile"), join(dir, "Dockerfile"));
  writeFileSync(join(dir, ".dockerignore"), dockerignore);
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

const CLEAN = [
  "LICENSE",
  "package.json",
  "tools/package.json",
  "tools/corpus.ts",
  "docs/status.md",
  "packages/knx/package.json",
  "packages/knx/src/frame.ts",
  "packages/knx/src/frame.test.ts",
  "packages/knx/test/fixtures/a.knxproj",
  "apps/web/src/main.tsx",
  "apps/web/src/test/dom.ts",
  "apps/server/data/busforge.db",
  "node_modules/x/test/a.js",
];

test("the repository's build context passes the Dockerfile's check", () => {
  expect(checkImageContext(ROOT)).toEqual([]);
});

test("a file the allowlist lets through under a forbidden name fails the check, and passes once it is gone", () => {
  expect(checkImageContext(repo(CLEAN))).toEqual([]);
  const leaking = repo([...CLEAN, "apps/web/src/fixtures/frame.json", "packages/knx/src/test/setup.ts", "packages/knx/src/capture.knxproj", "plugins/p/src/run.log"]);
  expect(checkImageContext(leaking)).toEqual([
    "apps/web/src/fixtures",
    "apps/web/src/fixtures/frame.json",
    "packages/knx/src/capture.knxproj",
    "packages/knx/src/test",
    "packages/knx/src/test/setup.ts",
    "plugins/p/src/run.log",
  ]);
});

test("the web tests' DOM setup fails the check when .dockerignore stops leaving it out", () => {
  const unguarded = DOCKERIGNORE.split("\n").filter((l) => l !== "apps/web/src/test").join("\n");
  expect(unguarded).not.toBe(DOCKERIGNORE);
  expect(checkImageContext(repo(CLEAN, unguarded))).toEqual(["apps/web/src/test", "apps/web/src/test/dom.ts"]);
});

test("tools/ may carry only its manifest", () => {
  const dir = repo([...CLEAN, "tools/smoke/runner.ts"], `${DOCKERIGNORE}\n!tools/smoke\n`);
  expect(checkImageContext(dir)).toEqual(["tools/smoke", "tools/smoke/runner.ts"]);
});

test("the command fails with the list of leaked files", () => {
  const dir = repo([...CLEAN, "packages/knx/src/fixtures/a.json"]);
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "image-context.ts"), dir]);
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("build context is not the .dockerignore allowlist");
  expect(run.stderr.toString()).toContain("  packages/knx/src/fixtures/a.json\n");
  expect(Bun.spawnSync([process.execPath, join(import.meta.dir, "image-context.ts"), repo(CLEAN)]).exitCode).toBe(0);
});

test(".dockerignore matches as Docker does: last pattern wins, parents count, ** spans components", () => {
  const p = parseDockerignore("# c\n*\n!a/*/b\n!/c/\n**/*.t\nc/**/d\n!c/e/**/f\n");
  expect(excluded(p, "x")).toBe(true);
  expect(excluded(p, "a/q/b")).toBe(false);
  expect(excluded(p, "a/q/b/inner")).toBe(false);
  expect(excluded(p, "a/q/r/b")).toBe(true);
  expect(excluded(p, "a/q/b/x.t")).toBe(true);
  expect(excluded(p, "x.t")).toBe(true);
  expect(excluded(p, "c/g")).toBe(false);
  expect(excluded(p, "c/d")).toBe(true);
  expect(excluded(p, "c/g/h/d/i")).toBe(true);
  expect(excluded(p, "c/e/f")).toBe(false);
  expect(contextEntries(repo(["a/q/b/x", "a/q/r/b", "c/e/g/f", "c/d/f"], "*\n!a/*/b\n!c/**/f\n"), parseDockerignore("*\n!a/*/b\n!c/**/f\n"))).toEqual([
    "a",
    "a/q",
    "a/q/b",
    "a/q/b/x",
    "c",
    "c/d",
    "c/d/f",
    "c/e",
    "c/e/g",
    "c/e/g/f",
  ]);
});

// The expectations of the next two tests are what BuildKit sent as the context for the same tree.
test(".dockerignore matches as BuildKit walks: a pattern is skipped while it cannot change the outcome", () => {
  const p = parseDockerignore("*\n!packages/*/src\n**/dist\n");
  expect(excluded(p, "packages/dist/src/a.ts")).toBe(false);
  expect(excluded(p, "packages/x/src/dist/d")).toBe(true);
  const dir = repo([...CLEAN, "packages/knx/src/capture.knxproj"], `${DOCKERIGNORE}\npackages\n`);
  expect(checkImageContext(dir)).toEqual(["packages/knx/src/capture.knxproj"]);
});

test("a leading ** with no other wildcard is a suffix", () => {
  const p = parseDockerignore("*\n!**.knxproj\n**foo\n");
  expect(excluded(p, "capture.knxproj")).toBe(false);
  expect(excluded(p, "x/bar.knxproj")).toBe(false);
  expect(excluded(p, "x/barfoo")).toBe(true);
  expect(excluded(p, "y/z")).toBe(true);
});

test("the rule is the Dockerfile's", () => {
  const rule = parseLeakRule(DOCKERFILE);
  expect(rule.names).toContain("test");
  expect(rule.names).toContain("*.knxproj");
  expect(rule.paths).toEqual(["./apps/server/data"]);
  expect([rule.onlyDir, rule.onlyKeep]).toEqual(["tools", "package.json"]);
  expect(leaks(["a", "a/.git", "a/.git/HEAD", "b.dat"], rule)).toEqual(["a/.git", "a/.git/HEAD", "b.dat"]);
});

test("a context check of another shape is refused, not read as a weaker one", () => {
  expect(() => parseLeakRule(DOCKERFILE.replace("-o -name fixtures", "-a -name fixtures"))).toThrow("unexpected find expression");
  expect(() => parseLeakRule(DOCKERFILE.replace("find ./tools -mindepth 1", "find ./tools -mindepth 2"))).toThrow("no longer has the shape");
  expect(() => parseLeakRule(DOCKERFILE.replace(/RUN leaked=/, "RUN found="))).toThrow("found 0");
  expect(() => parseLeakRule(DOCKERFILE.replace("-name '*.gz'", "-name '*.[gz]'"))).toThrow("bracket");
  expect(() => parseLeakRule(DOCKERFILE.replace("-name '*.gz'", '-name "$FORBIDDEN"'))).toThrow("shell expansion");
  expect(() => parseLeakRule(DOCKERFILE.replace("-name '*.gz'", "-name *.gz"))).toThrow("unquoted glob");
});

test("a .dockerignore this check cannot read as Docker does is refused", () => {
  expect(() => parseDockerignore("*\n!\n")).toThrow("lone");
  expect(() => parseDockerignore("*\n!src/[ab]\n")).toThrow("bracket");
  expect(() => checkImageContext(repo([...CLEAN, "Dockerfile.dockerignore"]))).toThrow("Dockerfile.dockerignore");
});
