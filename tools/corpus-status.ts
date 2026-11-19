// The last line of `bun run check`: whether the private corpus (tools/corpus.ts) is there, and so
// whether the corpus tests were enabled or registered as skipped, with the test files they are in.
// A BUSFORGE_CORPUS that is set but incomplete fails here as it fails the tests. With the corpus the line also
// says whether KNXPROJ_PASSWORDS was set and how many password-protected archives were opened.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_ENV, corpusRoot } from "./corpus.ts";
import { classify, openProtected, PASSWORDS_ENV, passwords } from "./corpus-archives.ts";

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

// Opens the corpus archives itself, as tools/corpus-archives.test.ts does (about a second and a half), so
// the line counts what this run could open and not what a test reported. Returns the line and whether
// every archive opened.
async function protectedArchivesLine(): Promise<{ line: string; ok: boolean }> {
  const { total, failures, protectedFiles } = await classify();
  const given = passwords().length;
  let line: string;
  let notOpened: string[] = [];
  if (given === 0) {
    line = `protected archives: not opened, ${PASSWORDS_ENV} absent (${protectedFiles.length} of ${total} corpus archives need a password)`;
  } else {
    const result = await openProtected(protectedFiles);
    notOpened = result.failures;
    line = `protected archives: ${PASSWORDS_ENV} set (${given} password${given === 1 ? "" : "s"}), ${result.opened.length} of ${protectedFiles.length} opened`;
  }
  if (notOpened.length > 0) line += `; not opened:\n  ${notOpened.join("\n  ")}`;
  if (failures.length > 0) line += `\narchives that need no password and do not open:\n  ${failures.join("\n  ")}`;
  return { line, ok: notOpened.length === 0 && failures.length === 0 };
}

const root = corpusRoot();
const files = corpusTestFiles();
if (root === null) {
  console.log(`private corpus: absent (${CORPUS_ENV} unset); the corpus tests in these ${files.length} test files were skipped, not run:\n  ${files.join("\n  ")}`);
} else {
  const { line, ok } = await protectedArchivesLine();
  console.log(`private corpus: present at ${root}; the corpus tests in all ${files.length} test files that have them were enabled; ${line}`);
  if (!ok) process.exit(1);
}
