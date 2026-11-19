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
import { isAbsolute, join, posix } from "node:path";
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

// bussard's ETS captures of its synthetic products, MIT-licensed third-party data (its README in the corpus).
// Every variant of its `captures/manifest.json` as `<product without "syn-">/<variant>`, with `+` where the variant
// also holds `base.pcapng`, the download that set the simulator up; each holds `ets.pcapng` and `requests.txt`
// (`base-requests.txt` beside a base). The captures are classic pcap despite the `.pcapng` name.
export const BUSSARD_SYNTHETIC_DIR = "captures/external/bussard-synthetic";
export const BUSSARD_SYNTHETIC_VARIANTS: readonly { product: string; variant: string; base: boolean }[] = [
  "assign/defaults", "assign-rewrite/defaults", "assign-rewrite/params", "bcu2-0021/defaults", "bcu2-0021/reload+",
  "bcu2-0021/unload+", "bcu2-0021/unload-reload+", "choose-never-shown/defaults", "choose-partial-segment/defaults",
  "choose-partial-segment/params", "choose-per-ref/defaults", "choose-per-ref/params", "color-param/defaults",
  "color-param-hsv/defaults", "color-param-hsv2/defaults", "com-objects/defaults", "com-objects/params",
  "dynamic-tests/defaults", "hidden-default/defaults", "ip-address-param/defaults", "ip-enabled-tp/defaults",
  "le-order/defaults", "legacy-patch-always/defaults", "map-error/defaults", "master-reset/defaults",
  "master-reset-code4/defaults", "minimal/apply+", "minimal/apply-params+", "minimal/assign+", "minimal/defaults",
  "minimal/links", "minimal/no-ga", "minimal/other-app+", "minimal/partial+", "minimal/partial-twice+",
  "minimal/reload+", "minimal/unload+", "module-choose/defaults", "module-choose/params", "module-repeat/defaults",
  "module-repeat/params", "object-size-ref/defaults", "param-calculation/calc-input", "param-calculation/defaults",
  "product-07b0/defaults", "property-nopar/defaults", "property-nopar/partial+", "property-param/defaults",
  "property-param/partial+", "property-param/partial-twice+", "relseg-dataless/defaults",
  "relseg-dataless-hidden/defaults", "relseg-fill/apply+", "relseg-fill/defaults", "s7-0701/defaults",
  "s7-0701/other-app+", "s7-0701/reload+", "s7-0705/apply+", "s7-0705/defaults", "s7-0705/other-app+",
  "s7-0705/params", "s7-0705/partial+", "s7-0705/reload+", "s7-0705/unload+", "s7-choose-split/defaults",
  "s7-delay/defaults", "s7-hidden-default/defaults", "s7-hidden-default-ets4/defaults",
  "s7-hidden-default-p11/defaults", "s7-lsm5/defaults", "s7-lsm5-0705/defaults", "s7-master-reset/defaults",
  "s7-no-comobjects/defaults", "s7-pei80/defaults", "s7-pid204/defaults", "s7-static-split/defaults",
  "s7-taskptr/defaults", "secure/apply+", "secure/apply-params+", "secure/defaults", "secure/links",
  "secure/partial+", "secure/reload+", "secure-fill/defaults", "secure-fill/reload+", "secure-fill/unload-reload+",
  "secure-property/defaults", "text-initialvalue/defaults", "text-undeclared/defaults",
  "trailing-writeprop/defaults", "trailing-writeprop/partial+", "union-bitfields/defaults", "union-bitfields/params",
  "union-default-range/defaults", "user-memory/defaults", "user-memory-extmem/defaults", "writerelmem-size/defaults",
  "writerelmem-tail/defaults",
].map((s) => {
  const [product, variant] = s.replace(/\+$/, "").split("/");
  return { product: `syn-${product}`, variant, base: s.endsWith("+") };
});
// The products whose application programs the tests read, with the program's id.
export const BUSSARD_SYNTHETIC_TESTED: readonly (readonly [product: string, application: string])[] = [
  ["syn-minimal", "2700-10"], ["syn-assign", "271F-10"], ["syn-assign-rewrite", "27B3-10"], ["syn-choose-never-shown", "270E-10"],
  ["syn-choose-per-ref", "2719-10"], ["syn-color-param", "2728-10"], ["syn-com-objects", "271B-10"], ["syn-dynamic-tests", "271C-10"],
  ["syn-hidden-default", "270C-10"], ["syn-ip-address-param", "2715-10"], ["syn-ip-enabled-tp", "2A22-10"], ["syn-legacy-patch-always", "2714-10"],
  ["syn-map-error", "2726-10"], ["syn-master-reset", "270A-10"], ["syn-master-reset-code4", "278A-10"], ["syn-module-choose", "27B2-10"],
  ["syn-object-size-ref", "2729-10"], ["syn-param-calculation", "270B-10"], ["syn-product-07b0", "2725-10"], ["syn-property-param", "271E-10"],
  ["syn-union-bitfields", "271D-10"], ["syn-union-default-range", "2705-10"], ["syn-user-memory-extmem", "2796-10"], ["syn-writerelmem-tail", "272A-10"],
  ["syn-s7-0701", "2801-10"], ["syn-s7-no-comobjects", "281A-10"], ["syn-s7-pei80", "2810-10"],
  ["syn-text-undeclared", "2706-10"], ["syn-text-initialvalue", "2718-10"],
  ["syn-relseg-dataless-hidden", "2A26-10"], ["syn-s7-hidden-default", "280D-10"], ["syn-s7-hidden-default-ets4", "288E-10"], ["syn-s7-hidden-default-p11", "288D-10"],
].map(([p, a]) => [p, `M-00FA_A-${a}-0000`] as const);
export const bussardCapture = (product: string, variant: string, file = "ets.pcapng") => `${BUSSARD_SYNTHETIC_DIR}/captures/${product}/${variant}/${file}`;
export const bussardApplication = (product: string, application: string) => `${BUSSARD_SYNTHETIC_DIR}/products/${product}/xml/M-00FA/${application}.xml`;

// Every file the tests and tools read, relative to the corpus root. A corpus may hold more; it
// may not hold less. corpusPath refuses a file that is not listed here, so a test cannot read one
// the check does not know it needs.
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
    "M-00FA_A-A012-55-0000.xml.gz",
    "M-0162_A-0004-11-F245.xml.gz",
  ].map((f) => `catalogue/${f}`),
  ...[
    "abb-usu-4.2-collect-scan.log",
    "abb-usu-4.2-ets-fulldownload-defaults.log",
    "abb-usu-4.2-ets-fulldownload-loaded.log",
    "abb-usu-4.2-ets-partial-links.log",
    "abb-usu-4.2-ets6log-fulldownload-loaded.txt",
    "auro-m0081-ets-fulldownload.log",
    "auro-m0081-ets-partial-heatalarm-off.log",
    "auro-m0081-ets-partial-heatalarm-on.log",
    "auro-m0081-ets-partial-links.log",
    "auro-m0081-ets-partial-params.log",
    "auro-m0081-ets-partial-relink9.log",
    "auro-m0081-ets-partial-revert.log",
    "auro-m0081-ets-partial-unlink9.log",
    "auro-m0081-ets6log-fulldownload.txt",
    "auro-m0081-ets6log-partial-heatalarm-off.txt",
    "auro-m0081-ets6log-partial-heatalarm-on.txt",
    "auro-m0081-ets6log-partial-links.txt",
    "auro-m0081-ets6log-partial-params.txt",
    "auro-m0081-ets6log-partial-relink9.txt",
    "auro-m0081-ets6log-partial-revert.txt",
    "auro-m0081-ets6log-partial-unlink9.txt",
    "bench-ets-project-params-edited-after-download.knxproj",
    "bench-memory-refused.log",
    "dali-ets-fulldownload-real.log",
    "dali-ets-fulldownload.log",
    "dali-ets-partial-links.log",
    "dali-ets-partial-params.log",
    "dali-ets-partial-revert.log",
    "dali-ets6log-fulldownload-real.txt",
    "dali-ets6log-fulldownload.txt",
    "dali-ets6log-partial-links.txt",
    "dali-ets6log-partial-params.txt",
    "dali-ets6log-partial-revert.txt",
    "dali-gateway-unit-fulldownload.json",
    "ets-download-records.json.gz",
    "gira-m0008-ets-fulldownload.log",
    "gira-m0008-ets-partial-links.log",
    "gira-m0008-ets-partial-params.log",
    "gira-m0008-ets-partial-revert.log",
    "gira-m0008-ets-partial-sperre-off.log",
    "gira-m0008-ets-partial-sperre-on.log",
    "gira-m0008-ets6log-fulldownload-restore.txt",
    "gira-m0008-ets6log-fulldownload.txt",
    "gira-m0008-ets6log-partial-links.txt",
    "gira-m0008-ets6log-partial-params.txt",
    "gira-m0008-ets6log-partial-revert.txt",
    "gira-m0008-ets6log-partial-sperre-off.txt",
    "gira-m0008-ets6log-partial-sperre-on.txt",
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
    "jung-400021se-ets6log-partial-colour-123456.txt",
    "jung-400021se-ets6log-partial-colour-a1b2c3.txt",
    "jung-400021se-ets6log-partial-colour-revert.txt",
    "jung-400021se-ets6log-partial-flag-read-off.txt",
    "jung-400021se-ets6log-partial-flag-read-on.txt",
    "jung-400021se-ets6log-q2-nochange.txt",
    "jung-400021se-ets6log-q2-param-link.txt",
    "jung-400021se-ets6log-q2-param.txt",
    "jung-400021se-ets6log-q2-revert.txt",
    "jung-400021se-unit-colour-after.json",
    "jung-400021se-unit-colour-before.json",
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
    "mdt-ip-secure-ets6log-fulldownload.txt",
    "mdt-ip-secure-unit-knxip.json",
    "mdt-ip-secure-unit-memory.json",
    "mdt-router-ets6log-fulldownload.txt",
    "mdt-router-ets6log-partial-ga-link.txt",
    "mdt-router-ets6log-partial-ga-unlink.txt",
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
  `${BUSSARD_SYNTHETIC_DIR}/LICENSE`,
  `${BUSSARD_SYNTHETIC_DIR}/captures/manifest.json`,
  ...BUSSARD_SYNTHETIC_VARIANTS.flatMap(({ product: p, variant: v, base }) => [
    bussardCapture(p, v), bussardCapture(p, v, "requests.txt"), ...(base ? [bussardCapture(p, v, "base.pcapng"), bussardCapture(p, v, "base-requests.txt")] : []),
  ]),
  ...BUSSARD_SYNTHETIC_TESTED.map(([p, a]) => bussardApplication(p, a)),
  // The applications packages/product/test/load-procedure-refusals.test.ts reads besides.
  ...[["syn-s7-lsm5", "280F-11"], ["syn-s7-lsm5-0705", "2820-10"], ["syn-writerelmem-size", "2717-10"], ["syn-s7-static-split", "2889-10"]].map(([p, a]) => bussardApplication(p, `M-00FA_A-${a}-0000`)),
];

// Bun loads the .env files of the directory a process starts in: `bun run check` those of the
// repository root, each workspace's `bun test` (started from the workspace root) those of its
// workspace, and `bun run --filter` does not hand the root's on. A BUSFORGE_CORPUS (or another variable the
// status line and the tests must both see, `name`) set in any of them would reach some processes and not
// others, so the status line could contradict the tests; it is refused, export it instead.
const ROOT = join(import.meta.dir, "..");
const DOTENV_FILES = [".env", ".env.local", ...["development", "production", "test"].flatMap((m) => [`.env.${m}`, `.env.${m}.local`])];

export function refuseDotenv(name: string = CORPUS_ENV): void {
  const workspaces = [".", "tools", ...["packages", "apps", "plugins"].flatMap((d) =>
    existsSync(join(ROOT, d)) ? readdirSync(join(ROOT, d)).map((w) => `${d}/${w}`) : [])];
  for (const dir of workspaces) {
    for (const f of DOTENV_FILES) {
      const p = join(ROOT, dir, f);
      if (existsSync(p) && new RegExp(`^\\s*(export\\s+)?${name}\\s*=`, "m").test(readFileSync(p, "utf8"))) {
        throw new Error(`${p} sets ${name}, which bun hands to some test processes and not others; remove it there and export ${name} in the shell instead`);
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

export const ETS_RECORDS_FILE = "captures/ets-download-records.json.gz";

// Directories whose files the tests walk whole. What they hold grows, so the manifest cannot name
// the files; the directory is open to the tests as a whole.
export const CORPUS_WALKED_DIRS: readonly string[] = ["evidence"];

const listedFiles = new Set(CORPUS_FILES);
const listedDirs = new Set(CORPUS_FILES.flatMap((f) => {
  const parts = f.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}));

let recordedProjects: Set<string> | undefined;

// The corpus projects ETS's download records name (tools/ets-records.ts keeps that file complete,
// tools/ets-records.test.ts holds it to the projects the corpus has). Their file names are not
// listed in CORPUS_FILES, which is public.
function recordedProjectPaths(root: string): ReadonlySet<string> {
  if (recordedProjects === undefined) {
    const records = JSON.parse(gunzipSync(readFileSync(join(root, ETS_RECORDS_FILE))).toString("utf8")) as { projects: { path: string }[] };
    recordedProjects = new Set(records.projects.map((p) => p.path));
  }
  return recordedProjects;
}

// Whether a test may open `relative`: a file of CORPUS_FILES, a directory that holds some, anything
// under a walked directory, or a project the download records name (`recorded` returns those).
export function corpusListed(relative: string, recorded: () => ReadonlySet<string> = () => new Set()): boolean {
  const path = posix.normalize(relative).replace(/\/$/, "");
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) return false;
  return listedFiles.has(path) || listedDirs.has(path)
    || CORPUS_WALKED_DIRS.some((d) => path === d || path.startsWith(`${d}/`))
    || (path.endsWith(".knxproj") && recorded().has(path));
}

// The absolute path of a corpus file no manifest can name yet, such as the project
// tools/ets-records.ts is about to record. Tests open files through corpusPath. Refuses when the corpus is absent.
export function corpusUnlistedPath(relative: string): string {
  return join(presentRoot(relative), relative);
}

function presentRoot(relative: string): string {
  const root = corpusRoot();
  if (root === null) throw new Error(`${relative} is read from the private corpus, but ${CORPUS_ENV} is unset (docs/testing.md, "The private corpus")`);
  return root;
}

// The absolute path of a file or directory in the corpus that CORPUS_FILES lists (see corpusListed),
// so a corpus that lacks it is refused by name before any test runs. Refuses when the corpus is absent.
export function corpusPath(relative: string): string {
  const root = presentRoot(relative);
  if (!corpusListed(relative, () => recordedProjectPaths(root))) {
    throw new Error(relative.endsWith(".knxproj")
      ? `${relative} is read from the private corpus but ETS's download records do not name it; record it with tools/ets-records.ts`
      : `${relative} is read from the private corpus but is not listed in CORPUS_FILES (tools/corpus.ts); list it, so a corpus without it is refused by name`);
  }
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
