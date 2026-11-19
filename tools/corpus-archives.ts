// Opening every project archive of the private corpus (`.knxproj`, `.knxprod`, `.busforge`) with
// Busforge's own readers. tools/corpus-archives.test.ts asserts on it and tools/corpus-status.ts reports on
// it, so the last line of `bun run check` counts the same archives the test opened.
//
// Whether an archive is password-protected is the reader's own answer: it refuses with
// PASSWORD_REQUIRED (BUSFORGE_PASSWORD_REQUIRED). An inner archive or a .busforge that is protected opens
// only with the project's password. The check holds none, so those come from the environment, never from a file:
// one password per line in `KNXPROJ_PASSWORDS`; each protected archive is tried with each.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readXml0 } from "../packages/project/src/knxproj.ts";
import { readZip } from "../packages/project/src/zip.ts";
import { unpackBusforge } from "../apps/server/src/db/busforgeArtifact.ts";
import { corpusRoot, refuseDotenv } from "./corpus.ts";

export const PASSWORDS_ENV = "KNXPROJ_PASSWORDS";
const ARCHIVE = /\.(knxproj|knxprod|busforge)$/;
const NEEDS_PASSWORD = new Set(["PASSWORD_REQUIRED", "BUSFORGE_PASSWORD_REQUIRED"]);
// Refusals that mean this candidate is not the archive's password, so the next one is tried. A zip with a
// bad entry authenticates as DECRYPT_FAILED too, which is why the last refusal is named when none opens it.
const NOT_THIS_PASSWORD = new Set(["WRONG_PASSWORD", "DECRYPT_FAILED", "ZIPCRYPTO_PASSWORD_ENCODING", "BUSFORGE_WRONG_PASSWORD"]);

// Every archive of the corpus, relative to its root, sorted. The corpus's own git directory holds none.
export function corpusArchives(): string[] {
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

export const bytesOf = (file: string) => readFileSync(join(corpusRoot()!, file));
export const extensionOf = (file: string) => file.slice(file.lastIndexOf(".") + 1);
// The passwords, one per line of KNXPROJ_PASSWORDS. A `.env` that sets it is refused as for BUSFORGE_CORPUS,
// since bun would hand it to the status line and not to the tests.
let given: string[] | undefined;
export const passwords = (): string[] => {
  if (given === undefined) {
    refuseDotenv(PASSWORDS_ENV);
    given = (process.env[PASSWORDS_ENV] ?? "").split(/\r?\n/).filter((p) => p !== "");
  }
  return given;
};
const codeOf = (e: unknown) => (e as { code?: string }).code;
export const describeFailure = (e: unknown) => `${codeOf(e) ?? "ERROR"}: ${(e as Error).message ?? String(e)}`;

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

export type ProtectedArchive = { file: string; bytes: Buffer };

// The archives of the corpus by what opening them takes: `failures` fail without a password for another
// reason than needing one, `protectedFiles` need one, `total` is every archive of the corpus.
export async function classify(): Promise<{ total: number; failures: string[]; protectedFiles: ProtectedArchive[] }> {
  const failures: string[] = [];
  const protectedFiles: ProtectedArchive[] = [];
  const archives = corpusArchives();
  for (const file of archives) {
    const bytes = bytesOf(file);
    const attempt = await tryOpen(file, bytes, undefined);
    if (attempt.kind === "protected") protectedFiles.push({ file, bytes });
    else if (attempt.kind === "failed") failures.push(attempt.text);
  }
  return { total: archives.length, failures, protectedFiles };
}

// Opens each protected archive with the passwords of KNXPROJ_PASSWORDS: the files that opened and a line
// for each that did not.
export async function openProtected(protectedFiles: ProtectedArchive[]): Promise<{ opened: string[]; failures: string[] }> {
  const opened: string[] = [];
  const failures: string[] = [];
  for (const { file, bytes } of protectedFiles) {
    let last: Attempt = { kind: "protected" };
    for (const password of passwords()) {
      last = await tryOpen(file, bytes, password);
      // A failure that is not a wrong password ends the search: another password cannot fix it.
      if (last.kind === "opened" || (last.kind === "failed" && !NOT_THIS_PASSWORD.has(last.code ?? ""))) break;
    }
    if (last.kind === "opened") opened.push(file);
    else if (last.kind === "protected") failures.push(`${file}: still asks for a password`);
    else failures.push(NOT_THIS_PASSWORD.has(last.code ?? "") ? `${last.text} (none of the ${passwords().length} password(s) in ${PASSWORDS_ENV} opens it)` : last.text);
  }
  return { opened, failures };
}
