// The private test corpus: files the tests need but the repository does not carry, because they
// are third-party catalogue data or were recorded on real devices (docs/testing.md,
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
import { OPENKNX_RELEASES } from "./openknx-releases.ts";

export const CORPUS_ENV = "BUSFORGE_CORPUS";

// One read-only collection per device-in-service spec whose unit the tests emulate, of the unit as its
// ETS project left it, named by the spec id (collections/in-service/README.md in the corpus).
export const IN_SERVICE_COLLECTIONS = [
  "auro-m0081-in-service", "gira-m0008-in-service", "mdt-be06001-in-service", "theben-dali-gateway-in-service",
  "theben-hmg6t-in-service", "theben-jmg4t-in-service", "theben-meteodata-140s-in-service", "theben-rmg8t-in-service",
  "theben-theluxa-p300-in-service", "meanwell-knx40e-in-service",
] as const;
export const inServiceCollection = (specId: string) => `collections/in-service/${specId}.json`;

// The product databases of the manufacturer demo (tools/demo-project.ts): manufacturer data only
// (hardware, application programs, their images), nothing of a project.
export const DEMO_PRODUCT_FILES = ["demo/bench-products.knxprod", "demo/house-products.knxprod"] as const;
// The OpenKNX release archives of the open demo, as OpenKNX publishes them, so its test runs
// without the network.
export const OPENKNX_DEMO_DIR = "demo/openknx";

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
    "abb-usu-4.2-ets-fulldownload-loaded.log",
    "abb-usu-4.2-ets-partial-links.log",
    "abb-usu-4.2-ets6log-fulldownload-loaded.txt",
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
    "bench-ets-project-params-edited-after-download.knxproj",
    "bench-memory-refused.log",
    "dali-ets-fulldownload.log",
    "dali-ets6log-fulldownload.txt",
    "dali-gateway-unit-fulldownload.json",
    "gira-m0008-ets-fulldownload.log",
    "gira-m0008-ets-partial-links.log",
    "gira-m0008-ets-partial-params.log",
    "gira-m0008-ets-partial-revert.log",
    "gvs-amma-ets-fulldownload-defaults.log",
    "gvs-amma-ets-partial-links.log",
    "gvs-amma-ets6log-keytable-add.txt",
    "gvs-amma-ets6log-keytable-plain.txt",
    "gvs-amma-ets6log-keytable-remove.txt",
    "gvs-amma-ets6log-keytable-restore.txt",
    "gvs-amma-ets6log-keytable-swap.txt",
    "gvs-amma-unit-keytable.json",
    "jung-400021se-ets-fulldownload.log",
    "jung-400021se-ets-partial-links.log",
    "jung-400021se-ets-partial-structure.log",
    "jung-400021se-ets6log-partial-flag-read-off.txt",
    "jung-400021se-ets6log-partial-flag-read-on.txt",
    "jung-400021se-ets6log-q2-nochange.txt",
    "jung-400021se-ets6log-q2-param-link.txt",
    "jung-400021se-ets6log-q2-param.txt",
    "jung-400021se-ets6log-q2-revert.txt",
    "jung-400021se-unit-q2.json",
    "knx-master-mv0012.xml",
    "mdt-be02001-collect-scan.log",
    "mdt-be02001-ets-fulldownload-b7.log",
    "mdt-be02001-ets-fulldownload-defaults.log",
    "mdt-be02001-ets-fulldownload-linked.log",
    "mdt-be02001-ets-partial-flag-comm-off.log",
    "mdt-be02001-ets-partial-flag-comm-on.log",
    "mdt-be02001-ets-partial-flag-read-off.log",
    "mdt-be02001-ets-partial-flag-read-on.log",
    "mdt-be02001-ets-partial-flag-update-off.log",
    "mdt-be02001-ets-partial-flag-update-on.log",
    "mdt-be02001-ets-partial-links.log",
    "mdt-be02001-ets-partial-sender-high.log",
    "mdt-be02001-ets-partial-sender-low.log",
    "mdt-be02001-ets-partial-structure.log",
    "mdt-ip-secure-unit-memory.json",
    "mdt-router-ets6log-fulldownload.txt",
    "mdt-router-ets6log-partial-name-revert.txt",
    "mdt-router-ets6log-partial-name.txt",
    "mdt-router-ets6log-partial-nochange.txt",
    "mdt-router-unit-collect-nach-ets-ga-link.json",
    "mdt-router-unit-config.json",
    "mdtui-ets-fulldownload.log",
    "mdtui-ets-partial-links.log",
    "mdtui-ets-partial-params.log",
    "mdtui-ets-partial-revert.log",
    "mdtui-ets6log-fulldownload.txt",
    "mdtui-ets6log-partial-links.txt",
    "mdtui-ets6log-partial-params.txt",
    "mdtui-ets6log-partial-revert.txt",
    "mdtui-unit-config.json",
    "meanwell-ets-fulldownload.log",
    "meanwell-ets-links.log",
    "meanwell-ets-params.log",
    "meanwell-ets-partial-maxtemp-off.log",
    "meanwell-ets-partial-maxtemp-on.log",
    "meanwell-ets-revert.log",
    "meanwell-ets6log-fulldownload.txt",
    "meanwell-ets6log-links.txt",
    "meanwell-ets6log-params.txt",
    "meanwell-ets6log-partial-maxtemp-off.txt",
    "meanwell-ets6log-partial-maxtemp-on.txt",
    "meanwell-ets6log-revert.txt",
    "meanwell-project.json",
    "meanwell-unit-collect-nach-ets-full.json",
    "meanwell-unit-collect-vor.json",
    "meteodata-140s-config.json",
    "meteodata-140s-ets-fulldownload.log",
    "meteodata-140s-ets-partial-c14-off.log",
    "meteodata-140s-ets-partial-c14-on.log",
    "meteodata-140s-ets-partial-links.log",
    "meteodata-140s-ets-partial-params.log",
    "meteodata-140s-ets-partial-revert.log",
    "meteodata-140s-ets6log-fulldownload.txt",
    "meteodata-140s-ets6log-partial-c14-off.txt",
    "meteodata-140s-ets6log-partial-c14-on.txt",
    "meteodata-140s-ets6log-partial-links.txt",
    "meteodata-140s-ets6log-partial-params.txt",
    "meteodata-140s-ets6log-partial-revert.txt",
    "openknx-config.json",
    "openknx-ets-fulldownload.log",
    "openknx-ets-partial-links.log",
    "openknx-ets-partial-params.log",
    "openknx-ets-partial-revert.log",
    "openknx-ets6log-fulldownload.txt",
    "openknx-ets6log-partial-links.txt",
    "openknx-ets6log-partial-params.txt",
    "openknx-ets6log-partial-revert.txt",
    "openknx-raumcontroller-5.5.1-app.xml.gz",
    "mix2-hmg6t-config.json",
    "mix2-hmg6t-ets-fulldownload.log",
    "mix2-hmg6t-ets-partial-diag-off.log",
    "mix2-hmg6t-ets-partial-diag-on.log",
    "mix2-hmg6t-ets-partial-links.log",
    "mix2-hmg6t-ets-partial-params.log",
    "mix2-hmg6t-ets-partial-revert.log",
    "mix2-hmg6t-ets6log-fulldownload.txt",
    "mix2-hmg6t-ets6log-partial-diag-off.txt",
    "mix2-hmg6t-ets6log-partial-diag-on.txt",
    "mix2-hmg6t-ets6log-partial-links.txt",
    "mix2-hmg6t-ets6log-partial-params.txt",
    "mix2-hmg6t-ets6log-partial-revert.txt",
    "mix2-jmg4t-config.json",
    "mix2-jmg4t-ets-fulldownload.log",
    "mix2-jmg4t-ets-partial-links.log",
    "mix2-jmg4t-ets-partial-params.log",
    "mix2-jmg4t-ets-partial-revert.log",
    "mix2-jmg4t-ets6log-fulldownload.txt",
    "mix2-jmg4t-ets6log-partial-links.txt",
    "mix2-jmg4t-ets6log-partial-params.txt",
    "mix2-jmg4t-ets6log-partial-revert.txt",
    "mix2-rmg8t-config.json",
    "mix2-rmg8t-ets-fulldownload.log",
    "mix2-rmg8t-ets-partial-diag-off.log",
    "mix2-rmg8t-ets-partial-diag-on.log",
    "mix2-rmg8t-ets-partial-links.log",
    "mix2-rmg8t-ets-partial-params.log",
    "mix2-rmg8t-ets-partial-revert.log",
    "mix2-rmg8t-ets6log-fulldownload.txt",
    "mix2-rmg8t-ets6log-partial-diag-off.txt",
    "mix2-rmg8t-ets6log-partial-diag-on.txt",
    "mix2-rmg8t-ets6log-partial-links.txt",
    "mix2-rmg8t-ets6log-partial-params.txt",
    "mix2-rmg8t-ets6log-partial-revert.txt",
    "theluxa-p300-ets-fulldownload.log",
    "theluxa-p300-ets-partial-links.log",
    "theluxa-p300-ets-partial-params.log",
    "theluxa-p300-ets-partial-revert.log",
    "theluxa-p300-ets6log-fulldownload.txt",
    "theluxa-p300-ets6log-partial-links.txt",
    "theluxa-p300-ets6log-partial-params.txt",
    "theluxa-p300-ets6log-partial-revert.txt",
  ].map((f) => `captures/${f}`),
  "dca-theben-dali-e64/backup-store.dat",
  "dca-theben-dali-e64/backup-store.expected.json",
  ...IN_SERVICE_COLLECTIONS.map(inServiceCollection),
  ...DEMO_PRODUCT_FILES,
  ...OPENKNX_RELEASES.map((r) => `${OPENKNX_DEMO_DIR}/${r.asset}`),
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
