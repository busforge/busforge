// The last line of `bun run check`: whether the private corpus (tools/corpus.ts) is there, and so
// whether the corpus tests were enabled or registered as skipped, with the test files they are in.
// A BUSFORGE_CORPUS that is set but incomplete fails here as it fails the tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_ENV, corpusRoot } from "./corpus.ts";

const ROOT = join(import.meta.dir, "..");

function corpusTestFiles(): string[] {
  const files: string[] = [];
  for (const dir of ["packages", "apps", "plugins", "tools"]) {
    for (const f of new Bun.Glob("**/*.test.ts").scanSync({ cwd: join(ROOT, dir) })) {
      if (f.split("/").includes("node_modules")) continue;
      const path = `${dir}/${f}`;
      if (/\bcorpus(Test|Describe)\(/.test(readFileSync(join(ROOT, path), "utf8"))) files.push(path);
    }
  }
  return files.sort();
}

const root = corpusRoot();
const files = corpusTestFiles();
if (root === null) {
  console.log(`private corpus: absent (${CORPUS_ENV} unset); the corpus tests in these ${files.length} test files were skipped, not run:\n  ${files.join("\n  ")}`);
} else {
  console.log(`private corpus: present at ${root}; the corpus tests in all ${files.length} test files that have them were enabled`);
}
