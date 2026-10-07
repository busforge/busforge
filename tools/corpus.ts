// The private test corpus: files the tests need but the repository does not carry, because they
// are third-party catalogue data or were recorded on a real installation (docs/testing.md,
// "The private corpus"). Its root comes from BUSFORGE_CORPUS and nowhere else.
//
//   unset                  -> the corpus is absent: corpusRoot() is null, every read refuses
//   set to a complete dir  -> the corpus is present
//   set to anything else   -> every call refuses, naming what is missing
//
// Nothing here touches the file system at import time.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const CORPUS_ENV = "BUSFORGE_CORPUS";

// Every file the tests and tools read, relative to the corpus root. A corpus may hold more; it
// may not hold less.
export const CORPUS_FILES: readonly string[] = [
  ...[
    "M-0002_A-A001-13-63C2.xml.gz",
    "M-0004_A-7072-21-99A7-O000A.xml.gz",
    "M-0008_A-10D7-11-2783-O000A.xml.gz",
    "M-0048_A-107E-12-5B58.xml.gz",
    "M-0048_A-140C-14-EB70.xml.gz",
    "M-0048_A-493B-21-B471.xml.gz",
    "M-0048_A-9071-20-F258-O00EF.xml.gz",
    "M-0081_A-FE01-11-75D9.xml.gz",
    "M-0081_A-FF31-31-D6FF.xml.gz",
    "M-0083_A-00B4-32-3919.xml.gz",
    "M-0083_A-00B6-32-9642.xml.gz",
    "M-0083_A-0137-20-7EB2.xml.gz",
    "M-0083_A-0138-21-F18E-O0072.xml.gz",
    "M-0085_A-0072-30-69AA.xml.gz",
    "M-008E_A-7079-10-9C41.xml.gz",
    "M-0162_A-0004-11-F245.xml.gz",
  ].map((f) => `catalogue/${f}`),
  ...[
    "abb-usu-4.2-collect-scan.log",
    "abb-usu-4.2-ets-fulldownload-defaults.log",
    "abb-usu-4.2-ets-partial-links.log",
    "auro-m0081-ets-fulldownload.log",
    "auro-m0081-ets-partial-links.log",
    "auro-m0081-ets-partial-params.log",
    "auro-m0081-ets-partial-relink9.log",
    "auro-m0081-ets-partial-revert.log",
    "auro-m0081-ets-partial-unlink9.log",
    "auro-m0081-ets6log-fulldownload.txt",
    "auro-m0081-ets6log-partial-links.txt",
    "auro-m0081-ets6log-partial-params.txt",
    "auro-m0081-ets6log-partial-relink9.txt",
    "auro-m0081-ets6log-partial-revert.txt",
    "auro-m0081-ets6log-partial-unlink9.txt",
    "bench-memory-refused.log",
    "gira-m0008-ets-fulldownload.log",
    "gira-m0008-ets-partial-links.log",
    "gira-m0008-ets-partial-params.log",
    "gira-m0008-ets-partial-revert.log",
    "gvs-amma-ets-fulldownload-defaults.log",
    "gvs-amma-ets-partial-links.log",
    "jung-400021se-ets-fulldownload.log",
    "jung-400021se-ets-partial-links.log",
    "jung-400021se-ets-partial-structure.log",
    "mdt-be02001-collect-scan.log",
    "mdt-be02001-ets-fulldownload-b7.log",
    "mdt-be02001-ets-fulldownload-defaults.log",
    "mdt-be02001-ets-fulldownload-linked.log",
    "mdt-be02001-ets-partial-links.log",
    "mdt-be02001-ets-partial-structure.log",
  ].map((f) => `captures/${f}`),
  "dca-theben-dali-e64/backup-store.dat",
  "dca-theben-dali-e64/backup-store.expected.json",
];

// Bun loads the .env files of the directory a process starts in: `bun run check` those of the
// repository root, each workspace's `bun test` (started from the workspace root) those of its
// workspace, and `bun run --filter` does not hand the root's on. A BUSFORGE_CORPUS set in any of them would reach some processes and not
// others, so the status line could contradict the tests; it is refused, export it instead.
const ROOT = join(import.meta.dir, "..");
const DOTENV_FILES = [".env", ".env.local", ...["development", "production", "test"].flatMap((m) => [`.env.${m}`, `.env.${m}.local`])];

function refuseDotenv(): void {
  const workspaces = [".", "tools", ...["packages", "apps", "plugins"].flatMap((d) =>
    existsSync(join(ROOT, d)) ? readdirSync(join(ROOT, d)).map((w) => `${d}/${w}`) : [])];
  for (const dir of workspaces) {
    for (const f of DOTENV_FILES) {
      const p = join(ROOT, dir, f);
      if (existsSync(p) && new RegExp(`^\\s*(export\\s+)?${CORPUS_ENV}\\s*=`, "m").test(readFileSync(p, "utf8"))) {
        throw new Error(`${p} sets ${CORPUS_ENV}, which bun hands to some test processes and not others; remove it there and export ${CORPUS_ENV} in the shell instead`);
      }
    }
  }
}

let checked: string | null | undefined;

// The corpus root, or null when BUSFORGE_CORPUS is unset. Throws when it is set but is not an
// absolute path to a directory holding every file of CORPUS_FILES.
export function corpusRoot(): string | null {
  if (checked !== undefined) return checked;
  refuseDotenv();
  const root = process.env[CORPUS_ENV];
  if (root === undefined) return (checked = null);
  if (!isAbsolute(root)) throw new Error(`${CORPUS_ENV}=${JSON.stringify(root)} is not an absolute path; set it to the private corpus directory, or unset it to run without the corpus`);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${CORPUS_ENV}=${root} is not a directory`);
  const missing = CORPUS_FILES.filter((f) => !existsSync(join(root, f)));
  if (missing.length) {
    throw new Error(`${CORPUS_ENV}=${root} is missing ${missing.length} of ${CORPUS_FILES.length} corpus files:\n  ${missing.join("\n  ")}`);
  }
  return (checked = root);
}

// The absolute path of a file or directory in the corpus. Refuses when the corpus is absent.
export function corpusPath(relative: string): string {
  const root = corpusRoot();
  if (root === null) throw new Error(`${relative} is read from the private corpus, but ${CORPUS_ENV} is unset (docs/testing.md, "The private corpus")`);
  return join(root, relative);
}

const xmlCache = new Map<string, string>();

// The plaintext ApplicationProgram XML of a catalogue file, e.g. "M-0081_A-FE01-11-75D9.xml.gz".
export function catalogueXml(name: string): string {
  let xml = xmlCache.get(name);
  if (xml === undefined) {
    xml = gunzipSync(readFileSync(corpusPath(`catalogue/${name}`))).toString("utf8");
    xmlCache.set(name, xml);
  }
  return xml;
}

export const catalogueDir = () => corpusPath("catalogue");

// Every catalogue file the corpus holds, sorted.
export const listCatalogue = (): string[] => readdirSync(catalogueDir()).filter((f) => f.endsWith(".xml.gz")).sort();

export const capturePath = (name: string) => corpusPath(`captures/${name}`);
export const captureText = (name: string) => readFileSync(capturePath(name), "utf8");
