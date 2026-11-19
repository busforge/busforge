// Every project archive in the private corpus (`.knxproj`, `.knxprod`, `.busforge`) is opened with
// Busforge's own readers, so a rule the ZIP reader gets stricter, or a decryption it breaks, fails here
// naming the file instead of surfacing in whichever test happens to need that archive next.
//
//   outer archive   readZip of every .knxproj and .knxprod, no password (ETS never protects the outer zip)
//   project         readXml0 of every .knxproj, which unpacks the inner P-*.zip and with it every entry
//   .busforge       unpackBusforge of every .busforge
//
// An inner archive or a .busforge that is password-protected opens only with the project's password.
// The check holds none, so those passwords come from the environment, never from a file:
//
//   KNXPROJ_PASSWORDS=$'<first>\n<second>' bun test tools/corpus-archives.test.ts
//
// one password per line; each protected archive is tried with each. Without it the outer-archive test
// and every archive that needs no password still run, and the test that opens the protected ones is
// registered as skipped under a name that says so.
import { expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readXml0 } from "../packages/project/src/knxproj.ts";
import { readZip, zipEncryption } from "../packages/project/src/zip.ts";
import { unpackBusforge } from "../apps/server/src/db/busforgeArtifact.ts";
import { corpusRoot } from "./corpus.ts";
import { corpusTest } from "./corpus-test.ts";

// The slowest test takes 1.4 s alone (about 98 MiB of AES-decrypted archives); the floor of docs/testing.md applies.
setDefaultTimeout(60_000);

const PASSWORDS_ENV = "KNXPROJ_PASSWORDS";
const ARCHIVE = /\.(knxproj|knxprod|busforge)$/;
const BUSFORGE_MAGIC = "BF1E";

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
const passwords = () => (process.env[PASSWORDS_ENV] ?? "").split("\n").filter((p) => p !== "");

const failure = (file: string, e: unknown) => {
  const err = e as { code?: string; message?: string };
  return `${file}: ${err.code ?? "ERROR"}: ${err.message ?? String(e)}`;
};

// What opening a file takes: no password, or one of the corpus's.
type Need = "none" | "password";

// A project's inner archive is what carries the password; a project exported without one, as ETS 6
// writes it, keeps 0.xml in the outer archive.
function projectNeed(bytes: Buffer): Need {
  const outer = readZip(bytes);
  const inner = [...outer].find(([name]) => /(^|\/)P-[^/]+\.zip$/.test(name));
  return inner && zipEncryption(inner[1]) !== "none" ? "password" : "none";
}

const needOf = (file: string, bytes: Buffer): Need =>
  extensionOf(file) === "knxproj" ? projectNeed(bytes)
  : extensionOf(file) === "busforge" ? (bytes.subarray(0, BUSFORGE_MAGIC.length).toString("ascii") === BUSFORGE_MAGIC ? "password" : "none")
  : "none";

// Opens `file` the way Busforge does, with `password` for the one layer that has one. A project's 0.xml
// is the proof that its inner archive unpacked; a .busforge's proof is that its JSON parsed.
async function open(file: string, bytes: Buffer, password: string | undefined): Promise<void> {
  switch (extensionOf(file)) {
    case "knxproj": {
      const xml = readXml0(bytes, password);
      if (!xml.includes("<KNX")) throw new Error("0.xml is not a KNX document");
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

// `file` opens with the first of `candidates` that does not fail as a wrong password; any other failure,
// and a file none of them opens, is a failure naming the file.
async function openWithAny(file: string, bytes: Buffer, candidates: (string | undefined)[]): Promise<string | null> {
  for (const password of candidates) {
    try {
      await open(file, bytes, password);
      return null;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "WRONG_PASSWORD" || code === "BUSFORGE_WRONG_PASSWORD" || code === "DECRYPT_FAILED") continue;
      return failure(file, e);
    }
  }
  return `${file}: none of the ${candidates.length} password(s) in ${PASSWORDS_ENV} opens it`;
}

corpusTest("the corpus holds project archives of each kind this test opens", () => {
  const kinds = new Set(corpusArchives().map(extensionOf));
  expect([...kinds].sort()).toEqual(expect.arrayContaining(["knxprod", "knxproj"]));
});

corpusTest("the outer archive of every corpus .knxproj and .knxprod opens", () => {
  const failures: string[] = [];
  for (const file of corpusArchives().filter((f) => extensionOf(f) !== "busforge")) {
    try {
      if (readZip(bytesOf(file)).size === 0) failures.push(`${file}: the archive holds no entry`);
    } catch (e) {
      failures.push(failure(file, e));
    }
  }
  expect(failures).toEqual([]);
});

corpusTest("every corpus archive that needs no password opens", async () => {
  const failures: string[] = [];
  for (const file of corpusArchives()) {
    const bytes = bytesOf(file);
    let need: Need;
    try { need = needOf(file, bytes); } catch (e) { failures.push(failure(file, e)); continue; }
    if (need !== "none") continue;
    const failed = await openWithAny(file, bytes, [undefined]);
    if (failed) failures.push(failed);
  }
  expect(failures).toEqual([]);
});

if (passwords().length === 0) {
  console.log(`[needs ${PASSWORDS_ENV}] not run: every corpus archive that is password-protected opens`);
  test.skip(`[needs ${PASSWORDS_ENV}] every corpus archive that is password-protected opens`, () => {});
} else {
  corpusTest("every corpus archive that is password-protected opens", async () => {
    const failures: string[] = [];
    for (const file of corpusArchives()) {
      const bytes = bytesOf(file);
      let need: Need;
      try { need = needOf(file, bytes); } catch (e) { failures.push(failure(file, e)); continue; }
      if (need !== "password") continue;
      const failed = await openWithAny(file, bytes, passwords());
      if (failed) failures.push(failed);
    }
    expect(failures).toEqual([]);
  });
}
