// ETS's download record of every device in the corpus projects (DeviceInstance LoadedImage and
// CheckSums, docs/verification.md "ETS's download record"), with what the offline comparison needs of
// each device, in one file of the private corpus: captures/ets-download-records.json.gz. Most corpus
// projects are password-protected and the check holds no password, so this tool reads them once and
// records, per project, its file's SHA-256 and per device the address, the application, the five load
// flags, whether the application's load procedure names LdCtrlLoadImageProp, and for a device ETS kept a
// record of: both attributes and the configuration the project stores for it (parameter values, module
// instances, links, com-object flags). No key of the project is read into it. An application the corpus
// catalogue does not hold under its id is taken from the project, gzipped, so the comparison can parse it.
//
// Usage (paths relative to the corpus; the password, where a project has one, only from the environment):
//   KNXPROJ_PASSWORD=... bun run tools/ets-records.ts <project.knxproj>...
// It replaces those projects' entries in the file, drops the entry of every project no longer in the
// corpus and keeps the others.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadKnxproj, readAppProgram, appProgramId, type EtsLoaded } from "../packages/project/src/index.ts";
import { parseLoadProcedures } from "../packages/product/src/index.ts";
import { catalogueXml, corpusPath, corpusUnlistedPath, ETS_RECORDS_FILE, listCatalogue } from "./corpus.ts";
import { deviceRows, type DeviceRows } from "./etsdiff.ts";
import { sha256 } from "./evidence.ts";

const FORMAT = "busforge-ets-records/1";

export interface DeviceRecord {
  ia: string;
  appRef: string;                      // "" for a device without an application program
  etsLoaded: EtsLoaded;
  declaresLoadImageProp: boolean | null; // null: the project does not carry the application
  loadedImage?: string;                // DeviceInstance/@LoadedImage as written
  checkSums?: string;                  // DeviceInstance/@CheckSums as written
  config?: DeviceRows;                 // present exactly where loadedImage is
}
export interface ProjectRecords { path: string; sha256: string; devices: DeviceRecord[] }
export interface EtsRecords { format: typeof FORMAT; projects: ProjectRecords[]; apps: Record<string, string> } // apps: id -> base64(gzip(xml))

export function readEtsRecords(): EtsRecords {
  const path = corpusPath(ETS_RECORDS_FILE);
  const r = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as EtsRecords;
  const format: unknown = r.format;
  if (format !== FORMAT) throw new Error(`${ETS_RECORDS_FILE} is of format ${String(format)}, not ${FORMAT}`);
  return r;
}

// The application program of `appId`: the corpus catalogue's, else the one this file carries.
export function recordedAppXml(records: EtsRecords, appId: string): string {
  const name = `${appId}.xml.gz`;
  if (listCatalogue().includes(name)) return catalogueXml(name);
  const carried = records.apps[appId];
  if (!carried) throw new Error(`neither the corpus catalogue nor ${ETS_RECORDS_FILE} holds ${appId}`);
  return gunzipSync(Buffer.from(carried, "base64")).toString("utf8");
}

function recordProject(path: string, password: string | undefined, apps: Record<string, string>): ProjectRecords {
  const bytes = readFileSync(corpusUnlistedPath(path));
  const proj = loadKnxproj(bytes, password, path);
  // The import leaves these devices out, so their records would be missing without anything saying so.
  const left = proj.skippedInstallations + proj.unassignedDevices + proj.malformedDevices;
  if (left) throw new Error(`${path}: the import leaves out devices (${proj.skippedInstallations} further installations, ${proj.unassignedDevices} unassigned and ${proj.malformedDevices} malformed devices), whose download records would go unrecorded`);
  const catalogue = new Set(listCatalogue());
  const declares = new Map<string, boolean | null>();
  const devices = proj.devices.map((d): DeviceRecord => {
    if (d.appRef && !declares.has(d.appRef)) {
      const xml = readAppProgram(bytes, d.appRef);
      declares.set(d.appRef, xml === null ? null : parseLoadProcedures(xml).blocks.some((b) => b.steps.some((s) => s.verb === "LdCtrlLoadImageProp")));
    }
    const rec: DeviceRecord = { ia: d.ia, appRef: d.appRef, etsLoaded: d.etsLoaded, declaresLoadImageProp: d.appRef ? declares.get(d.appRef)! : false };
    if (d.etsLoadedImage === undefined && d.etsCheckSums === undefined) return rec;
    if (d.etsLoadedImage === undefined || d.etsCheckSums === undefined) throw new Error(`${path}: ${d.ia} carries one of LoadedImage and CheckSums without the other`);
    // A record names its device's application by the Hardware2Program id (DeviceRecord.appRef), which
    // names the application on one-program hardware only.
    const id = appProgramId(d.appRef);
    if (d.appProgramId !== id) throw new Error(`${path}: ${d.ia} runs ${d.appProgramId || "no application Busforge can tell"}, which its Hardware2Program id ${d.appRef} does not name; a record keys the application by that id, so it cannot record this device`);
    if (!catalogue.has(`${id}.xml.gz`) && !apps[id]) {
      const xml = readAppProgram(bytes, d.appRef);
      if (xml === null) throw new Error(`${path}: ${d.ia} has a download record, but the project does not carry ${id}`);
      apps[id] = gzipSync(Buffer.from(xml, "utf8")).toString("base64");
    }
    return { ...rec, loadedImage: d.etsLoadedImage, checkSums: d.etsCheckSums, config: deviceRows(proj, d.id) };
  });
  return { path, sha256: sha256(bytes), devices };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (!paths.length || paths.some((p) => !p.endsWith(".knxproj"))) throw new Error("usage: KNXPROJ_PASSWORD=... bun run tools/ets-records.ts <corpus-relative project.knxproj>...");
  const records = readEtsRecords();
  records.projects = records.projects.filter((p) => existsSync(corpusPath(p.path)));
  for (const p of paths) {
    const entry = recordProject(p, process.env.KNXPROJ_PASSWORD, records.apps);
    records.projects = [...records.projects.filter((x) => x.path !== p), entry].sort((a, b) => a.path.localeCompare(b.path));
    console.log(`${p}: ${entry.devices.length} devices, ${entry.devices.filter((d) => d.loadedImage).length} with ETS's download record`);
  }
  const used = new Set(records.projects.flatMap((p) => p.devices.flatMap((d) => (d.loadedImage ? [appProgramId(d.appRef)] : []))));
  records.apps = Object.fromEntries(Object.entries(records.apps).filter(([id]) => used.has(id)));
  writeFileSync(corpusPath(ETS_RECORDS_FILE), gzipSync(Buffer.from(JSON.stringify(records))));
}
