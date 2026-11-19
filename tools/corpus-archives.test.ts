// Every project archive in the private corpus (`.knxproj`, `.knxprod`, `.busforge`) is opened with
// Busforge's own readers, so a rule the ZIP reader gets stricter, or a decryption it breaks, fails here
// naming the file instead of surfacing in whichever test happens to need that archive next.
//
//   outer archive   readZip of every .knxproj and .knxprod, no password (ETS never protects the outer zip)
//   project         readXml0 of every .knxproj, which unpacks the inner P-*.zip and with it every entry
//   .busforge       unpackBusforge of every .busforge
//
// Whether an archive is password-protected is the reader's own answer: it refuses with
// PASSWORD_REQUIRED (BUSFORGE_PASSWORD_REQUIRED). An inner archive or a .busforge that is protected opens
// only with the project's password. The check holds none, so those come from the environment, never from a file:
//
//   KNXPROJ_PASSWORDS="$(first-password-source)"$'\n'"$(second-password-source)" bun test tools/corpus-archives.test.ts
//
// one password per line; each protected archive is tried with each. Without it the outer-archive test and
// every archive that needs no password still run, and the test that opens the protected ones is registered
// as skipped under a name that says so.
import { expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readXml0 } from "../packages/project/src/knxproj.ts";
import { readZip } from "../packages/project/src/zip.ts";
import { unpackBusforge } from "../apps/server/src/db/busforgeArtifact.ts";
import { corpusRoot } from "./corpus.ts";
import { corpusTest } from "./corpus-test.ts";

// The slowest test takes 1.4 s alone (about 98 MiB of AES-decrypted archives); the floor of docs/testing.md applies.
setDefaultTimeout(60_000);

const PASSWORDS_ENV = "KNXPROJ_PASSWORDS";
const ARCHIVE = /\.(knxproj|knxprod|busforge)$/;
const NEEDS_PASSWORD = new Set(["PASSWORD_REQUIRED", "BUSFORGE_PASSWORD_REQUIRED"]);
// Refusals that mean this candidate is not the archive's password, so the next one is tried. A zip with a
// bad entry authenticates as DECRYPT_FAILED too, which is why the last refusal is named when none opens it.
const NOT_THIS_PASSWORD = new Set(["WRONG_PASSWORD", "DECRYPT_FAILED", "ZIPCRYPTO_PASSWORD_ENCODING", "BUSFORGE_WRONG_PASSWORD"]);

// Every archive of the corpus, relative to its root, sorted. The corpus's own git directory holds none.
function corpusArchives(): string[] {
  const root = corpusRoot()!;
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && ARCHIVE.test(e.name)) found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

const bytesOf = (file: string) => readFileSync(join(corpusRoot()!, file));
const extensionOf = (file: string) => file.slice(file.lastIndexOf(".") + 1);
const passwords = () => (process.env[PASSWORDS_ENV] ?? "").split(/\r?\n/).filter((p) => p !== "");
const codeOf = (e: unknown) => (e as { code?: string }).code;
const describeFailure = (e: unknown) => `${codeOf(e) ?? "ERROR"}: ${(e as Error).message ?? String(e)}`;

// Opens `file` the way Busforge does, with `password` for the one layer that has one. A project's 0.xml
// is the proof that its inner archive unpacked; a .busforge's proof is that its JSON parsed.
async function open(file: string, bytes: Buffer, password: string | undefined): Promise<void> {
  switch (extensionOf(file)) {
    case "knxproj": {
      if (!readXml0(bytes, password).includes("<KNX")) throw new Error("0.xml is not a KNX document");
      return;
    }
    case "knxprod":
      if (readZip(bytes).size === 0) throw new Error("the product database holds no entry");
      return;
    default: {
      const data = await unpackBusforge(bytes, password);
      if (!data || typeof data !== "object") throw new Error("the export is not a JSON object");
    }
  }
}

type Attempt = { kind: "opened" } | { kind: "protected" } | { kind: "failed"; code: string | undefined; text: string };

// One try at opening `file`; the text of a failure names the file.
async function tryOpen(file: string, bytes: Buffer, password: string | undefined): Promise<Attempt> {
  try {
    await open(file, bytes, password);
    return { kind: "opened" };
  } catch (e) {
    return NEEDS_PASSWORD.has(codeOf(e) ?? "") ? { kind: "protected" } : { kind: "failed", code: codeOf(e), text: `${file}: ${describeFailure(e)}` };
  }
}

// The archives of the corpus by what opening them takes: `failures` fail without a password for another
// reason than needing one, `protectedFiles` need one.
async function classify(): Promise<{ failures: string[]; protectedFiles: { file: string; bytes: Buffer }[] }> {
  const failures: string[] = [];
  const protectedFiles: { file: string; bytes: Buffer }[] = [];
  for (const file of corpusArchives()) {
    const bytes = bytesOf(file);
    const attempt = await tryOpen(file, bytes, undefined);
    if (attempt.kind === "protected") protectedFiles.push({ file, bytes });
    else if (attempt.kind === "failed") failures.push(attempt.text);
  }
  return { failures, protectedFiles };
}

corpusTest("the corpus holds project archives of the two kinds it is known to hold", () => {
  expect([...new Set(corpusArchives().map(extensionOf))]).toEqual(expect.arrayContaining(["knxprod", "knxproj"]));
});

corpusTest("the outer archive of every corpus .knxproj and .knxprod opens", () => {
  const failures: string[] = [];
  for (const file of corpusArchives().filter((f) => extensionOf(f) !== "busforge")) {
    try {
      if (readZip(bytesOf(file)).size === 0) failures.push(`${file}: the archive holds no entry`);
    } catch (e) {
      failures.push(`${file}: ${describeFailure(e)}`);
    }
  }
  expect(failures).toEqual([]);
});

corpusTest("every corpus archive that needs no password opens", async () => {
  expect((await classify()).failures).toEqual([]);
});

if (passwords().length === 0) {
  console.log(`[needs ${PASSWORDS_ENV}] not run: every corpus archive that is password-protected opens`);
  test.skip(`[needs ${PASSWORDS_ENV}] every corpus archive that is password-protected opens`, () => {});
} else {
  corpusTest("every corpus archive that is password-protected opens", async () => {
    const failures: string[] = [];
    for (const { file, bytes } of (await classify()).protectedFiles) {
      let last: Attempt = { kind: "protected" };
      for (const password of passwords()) {
        last = await tryOpen(file, bytes, password);
        // A failure that is not a wrong password ends the search: another password cannot fix it.
        if (last.kind === "opened" || (last.kind === "failed" && !NOT_THIS_PASSWORD.has(last.code ?? ""))) break;
      }
      if (last.kind === "protected") failures.push(`${file}: still asks for a password`);
      else if (last.kind === "failed") failures.push(NOT_THIS_PASSWORD.has(last.code ?? "") ? `${last.text} (none of the ${passwords().length} password(s) in ${PASSWORDS_ENV} opens it)` : last.text);
    }
    expect(failures).toEqual([]);
  });
}
