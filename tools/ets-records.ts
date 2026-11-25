// ETS's download record of every device in the corpus projects (DeviceInstance LoadedImage and
// CheckSums, docs/verification.md "ETS's download record"), with what the offline comparison needs of
// each device, in one file of the private corpus: captures/ets-download-records.json.gz. Most corpus
// projects are password-protected and the check holds no password, so this tool reads them once and
// records, per project, its file's SHA-256 and per device the address, its Hardware2Program and the application
// it runs (as the project's product data name it: on hardware with a PEI program the Hardware2Program's id carries
// both programs' numbers and names neither), the five load
// flags, whether the application's load procedure names LdCtrlLoadImageProp, and for a device ETS kept a
// record of: both attributes and the configuration the project stores for it (parameter values, module
// instances, links, com-object flags). No key of the project is read into it. An application the corpus
// catalogue does not hold under its id is taken from the project, gzipped, so the comparison can parse it.
//
// Usage (paths relative to the corpus; the passwords, where projects have them, only from the environment:
// KNXPROJ_PASSWORD, and KNXPROJ_PASSWORDS with one per line, every protected project is tried with each):
//   bun run tools/ets-records.ts <project.knxproj>...
//   bun run tools/ets-records.ts --missing [<corpus directory>...]
//   bun run tools/ets-records.ts <project.knxproj>... --dry-run
//   bun run tools/ets-records.ts --missing [<corpus directory>...] --dry-run
// The first replaces those projects' entries in the file. `--missing` records every project of the corpus
// (or of the named directories) the file lacks and leaves the entries it holds as they are. Either drops the
// entry of every project no longer in the corpus and keeps the others. When a project cannot be recorded
// the run names every one that cannot and writes nothing. `--dry-run` names the projects it would record and
// the entries it would drop, opens nothing and writes nothing. A file of an earlier format is written again only by
// `--missing` over the whole corpus, which records every project anew.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadKnxproj, readAppProgram, extractAppPrograms, decodeLoadedImage, type Device, type EtsLoaded } from "../packages/project/src/index.ts";
import {
  classify, parseLoadProcedures, ProductError,
  type AppConfig, type ComObjectLink, type ComObjInstanceOverride, type LoadProcedures, type ModuleInstance,
} from "../packages/product/src/index.ts";
import { catalogueXml, corpusPath, corpusUnlistedPath, ETS_RECORDS_FILE, listCatalogue } from "./corpus.ts";
import { codeOf, corpusArchives, describeFailure, NOT_THIS_PASSWORD, passwords } from "./corpus-archives.ts";
import { deviceRows, type DeviceRows } from "./etsdiff.ts";
import { sha256 } from "./evidence.ts";

const FORMAT = "busforge-ets-records/2";

export interface DeviceRecord {
  ia: string;
  appRef: string;                      // the Hardware2Program; "" for a device without an application program
  // The application the device runs, as the project's product data name it (Device.appProgramId); "" where they name
  // none Busforge can tell apart from a PEI program, or the device has no application program. The records key
  // applications by it (EtsRecords.apps, recordedAppXml).
  application: string;
  etsLoaded: EtsLoaded;
  declaresLoadImageProp: boolean | null; // null: the project does not carry the application
  loadedImage?: string;                // DeviceInstance/@LoadedImage as written
  checkSums?: string;                  // DeviceInstance/@CheckSums as written
  config?: DeviceRows;                 // present exactly where loadedImage is
}
export interface ProjectRecords { path: string; sha256: string; devices: DeviceRecord[] }
export interface EtsRecords { format: typeof FORMAT; projects: ProjectRecords[]; apps: Record<string, string> } // apps: application id -> base64(gzip(xml))

export function readEtsRecords(): EtsRecords {
  const path = corpusPath(ETS_RECORDS_FILE);
  const r = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as EtsRecords;
  const format: unknown = r.format;
  if (format !== FORMAT) throw new Error(`${ETS_RECORDS_FILE} is of format ${String(format)}, not ${FORMAT}`);
  return r;
}

// Every project of the corpus, relative to its root, sorted: the set the records must hold.
export const corpusProjects = (): string[] => corpusArchives().filter((f) => f.endsWith(".knxproj"));

// The projects a run records. Without `missing`, `targets` are projects of the corpus. With it, they are
// directories (none: the whole corpus) and the projects under them that `recorded` lacks. A target that is
// not what the mode takes, or that names nothing the corpus holds, is refused: a typo records nothing. A
// directory is a path relative to the corpus root ("." is the root itself), matched by whole components.
export function projectsToRecord(onDisk: readonly string[], recorded: ReadonlySet<string>, targets: readonly string[], missing: boolean): string[] {
  if (!missing) {
    const unknown = targets.filter((t) => !onDisk.includes(t));
    if (unknown.length) throw new Error(`not a project of the corpus: ${unknown.join(", ")}`);
    return [...new Set(targets)];
  }
  const found = new Set<string>();
  for (const target of targets.length ? targets : ["."]) {
    if (target.endsWith(".knxproj")) throw new Error(`--missing takes corpus directories, not the project ${target}; name the project without --missing to record it again`);
    const dir = posix.normalize(target).replace(/\/+$/, "");
    if (isAbsolute(target) || dir === ".." || dir.startsWith("../")) throw new Error(`${target} is not a directory relative to the corpus root`);
    const under = onDisk.filter((p) => dir === "." || p.startsWith(`${dir}/`));
    if (!under.length) throw new Error(`the corpus holds no project under ${target}`);
    for (const p of under) if (!recorded.has(p)) found.add(p);
  }
  return [...found].sort();
}

// One pinned count that moved: what it counts, what a run found, the count a test pins, and each corpus
// project's share of the found count.
export interface PinnedCount { what: string; found: number; pinned: number; byProject: ReadonlyMap<string, number> }

// Counts of `paths` by project, for a PinnedCount's byProject.
export function tally(paths: readonly string[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const p of paths) n.set(p, (n.get(p) ?? 0) + 1);
  return n;
}

// One line per project with a share, sorted by path.
const sharesOf = (byProject: ReadonlyMap<string, number>): string[] =>
  [...byProject].filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)).map(([p, n]) => `  ${p}: ${n}`);

// Where a pinned count differs from the found one, a message that names the projects whose devices make
// the found count up, each with its share; none where they agree.
export function countMismatches(counts: readonly PinnedCount[]): string[] {
  return counts.filter((c) => c.found !== c.pinned).map((c) => {
    const delta = c.found - c.pinned;
    const shares = sharesOf(c.byProject);
    return `${c.what}: found ${c.found}, pinned ${c.pinned} (${delta > 0 ? "+" : ""}${delta}). The corpus projects behind the found count, with their share:\n${shares.join("\n") || "  none"}`;
  });
}

// Each named entry's occurrences, counted, as "<what> (<n> project[s])", sorted: the form a test pins.
export function counted(entries: readonly string[]): string[] {
  return [...tally(entries)].map(([e, k]) => `${e} (${k} project${k === 1 ? "" : "s"})`).sort();
}

const COUNTED = /^(.*) \((\d+) projects?\)$/;

// The named entries of a pinned list (`counted`'s form) held against the entries a run found: for each that
// differs, the projects whose entries make the found count, each with its number of entries.
export function countedMismatches(found: readonly { what: string; project: string }[], pinned: readonly string[]): string[] {
  const foundBy = new Map<string, string[]>();
  for (const f of found) foundBy.set(f.what, [...(foundBy.get(f.what) ?? []), f.project]);
  const pinnedN = new Map<string, number>();
  for (const line of pinned) {
    const m = COUNTED.exec(line);
    if (!m) throw new Error(`a pinned entry is not "<what> (<n> project[s])": ${line}`);
    pinnedN.set(m[1], Number(m[2]));
  }
  const out: string[] = [];
  for (const what of [...new Set([...foundBy.keys(), ...pinnedN.keys()])].sort()) {
    const projects = foundBy.get(what) ?? [];
    const was = pinnedN.get(what);
    if (projects.length === was) continue;
    const shares = sharesOf(tally(projects));
    out.push(`${what}: found ${projects.length}, pinned ${was ?? "no such entry"}.${shares.length ? ` The corpus projects behind the found entries, with their number:\n${shares.join("\n")}` : " No project shows it any more."}`);
  }
  return out;
}

// The application program of `appId`: the corpus catalogue's, else the one this file carries.
export function recordedAppXml(records: EtsRecords, appId: string): string {
  const name = `${appId}.xml.gz`;
  if (listCatalogue().includes(name)) return catalogueXml(name);
  const carried = records.apps[appId];
  if (!carried) throw new Error(`neither the corpus catalogue nor ${ETS_RECORDS_FILE} holds ${appId}`);
  return gunzipSync(Buffer.from(carried, "base64")).toString("utf8");
}

// Busforge's full-download images for a configuration held against ETS's record of its download
// (DeviceInstance/@LoadedImage): every byte the record marks as ETS's own, compared with the byte Busforge
// builds there. `refused` where Busforge's planner refuses the device's full download.
export function loadedImageComparison(
  cfg: AppConfig, proc: LoadProcedures, ia: string,
  conf: { params: Map<string, string>; instances: ModuleInstance[]; links: ComObjectLink[]; comObjectOverrides: Map<number, ComObjInstanceOverride> },
  loadedImage: string,
  // Whether the unit held the application when ETS downloaded it. Unset: as in a project, where ETS downloaded
  // the device and it holds the application; on System 7, ETS's download of such a unit leaves the
  // application loaded and writes the bytes the parameters cover (docs/load-procedures.md, "Which bytes ETS
  // writes"); on System B the partial form needs the unit's memory, and the full form's images hold the
  // same bytes.
  unitHoldsApplication?: boolean,
): { refused: string } | { bytes: number; mismatches: string[] } {
  const profile = classify(cfg);
  let segments;
  try {
    segments = profile.planFullDownload(cfg.mask, {
      ia, params: conf.params, links: conf.links, moduleInstances: conf.instances, proc, comObjectOverrides: conf.comObjectOverrides,
      unitHoldsApplication: unitHoldsApplication ?? (proc.preferPartialIfLoaded && profile.family === "system-7"),
    }).segments;
  } catch (e) {
    if (e instanceof ProductError) return { refused: e.code };
    throw e;
  }
  const absolute = new Map<number, number>();
  for (const s of segments) if (s.address !== null) s.image.forEach((b, i) => absolute.set(s.address! + i, b));
  const hex = (n: number | undefined) => n === undefined ? "--" : n.toString(16).padStart(2, "0");
  const mismatches: string[] = [];
  let bytes = 0;
  for (const r of decodeLoadedImage(loadedImage)) {
    const image = r.location === "relative" ? segments.find((s) => s.address === null && s.lsm === r.object)?.image : undefined;
    r.data.forEach((ets, i) => {
      if (r.mask[i] !== 0xff) return;
      bytes++;
      const at = r.start + i;
      const ours = r.location === "absolute" ? absolute.get(at) : image?.[at];
      if (ours !== ets) mismatches.push(`object ${r.object} at ${at}: Busforge ${hex(ours)}, ETS ${hex(ets)}`);
    });
  }
  return { bytes, mismatches };
}

// A project opened with the first of `candidates` that opens it (a project without a password opens with
// any). A refusal that is not a wrong password ends the search: another password cannot fix it.
function openProject(bytes: Buffer, path: string, candidates: readonly string[]): ReturnType<typeof loadKnxproj> {
  let last: unknown;
  for (const password of candidates.length ? candidates : [undefined]) {
    try {
      return loadKnxproj(bytes, password, path);
    } catch (e) {
      if (!NOT_THIS_PASSWORD.has(codeOf(e) ?? "")) throw e;
      last = e;
    }
  }
  throw new Error(`none of the ${candidates.length} password(s) opens ${path} (${describeFailure(last)})`);
}

// One device's record. A device with ETS's download record must run an application its project's product data name
// (Device.appProgramId), which the record keys its application by; one whose product data name none is refused: what
// the record compares against would be guessed. An application the corpus catalogue does not hold is taken from the
// project into `apps`.
export function recordDevice(
  d: Pick<Device, "id" | "ia" | "appRef" | "appProgramId" | "etsLoaded" | "etsLoadedImage" | "etsCheckSums">,
  ctx: { path: string; bytes: Buffer; catalogue: ReadonlySet<string>; declares: Map<string, boolean | null>; apps: Record<string, string>; rows: (id: string) => DeviceRows },
): DeviceRecord {
  const { path, bytes, catalogue, declares, apps } = ctx;
  if (d.appRef && !declares.has(d.appRef)) {
    const xml = readAppProgram(bytes, d.appRef);
    declares.set(d.appRef, xml === null ? null : parseLoadProcedures(xml).blocks.some((b) => b.steps.some((s) => s.verb === "LdCtrlLoadImageProp")));
  }
  const rec: DeviceRecord = { ia: d.ia, appRef: d.appRef, application: d.appProgramId, etsLoaded: d.etsLoaded, declaresLoadImageProp: d.appRef ? declares.get(d.appRef)! : false };
  if (d.etsLoadedImage === undefined && d.etsCheckSums === undefined) return rec;
  if (d.etsLoadedImage === undefined || d.etsCheckSums === undefined) throw new Error(`${path}: ${d.ia} carries one of LoadedImage and CheckSums without the other`);
  const id = d.appProgramId;
  if (!id) throw new Error(`${path}: ${d.ia} has a download record, but its product data name no application of ${d.appRef} Busforge can tell apart from a PEI program`);
  if (!catalogue.has(`${id}.xml.gz`) && !apps[id]) {
    const xml = extractAppPrograms(bytes, [id]).get(id);
    if (xml === undefined) throw new Error(`${path}: ${d.ia} has a download record, but the project does not carry ${id}`);
    apps[id] = gzipSync(Buffer.from(xml, "utf8")).toString("base64");
  }
  return { ...rec, loadedImage: d.etsLoadedImage, checkSums: d.etsCheckSums, config: ctx.rows(d.id) };
}

function recordProject(path: string, candidates: readonly string[], apps: Record<string, string>): ProjectRecords {
  const bytes = readFileSync(corpusUnlistedPath(path));
  const proj = openProject(bytes, path, candidates);
  // The import leaves these devices out, so their records would be missing without anything saying so.
  const left = proj.skippedInstallations + proj.unassignedDevices + proj.malformedDevices;
  if (left) throw new Error(`${path}: the import leaves out devices (${proj.skippedInstallations} further installations, ${proj.unassignedDevices} unassigned and ${proj.malformedDevices} malformed devices), whose download records would go unrecorded`);
  const catalogue = new Set(listCatalogue());
  const declares = new Map<string, boolean | null>();
  const devices = proj.devices.map((d) => recordDevice(d, { path, bytes, catalogue, declares, apps, rows: (id) => deviceRows(proj, id) }));
  return { path, sha256: sha256(bytes), devices };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--missing" && a !== "--dry-run");
  const targets = args.filter((a) => !a.startsWith("--"));
  const missing = args.includes("--missing"), dryRun = args.includes("--dry-run");
  const usage = "usage: bun run tools/ets-records.ts <corpus-relative project.knxproj>... | --missing [<corpus directory>...] [--dry-run]";
  if (unknown.length) throw new Error(`unknown option ${unknown.join(", ")}; ${usage}`);
  if (!missing && !targets.length) throw new Error(usage);
  if (!missing && targets.some((p) => !p.endsWith(".knxproj"))) throw new Error(usage);
  // A file of an earlier format holds no entry this format takes: the run starts empty, and only a run that records
  // every project (--missing over the whole corpus) writes it.
  const stored = JSON.parse(gunzipSync(readFileSync(corpusPath(ETS_RECORDS_FILE))).toString("utf8")) as { format?: unknown };
  const fresh = stored.format !== FORMAT;
  if (fresh && !(missing && targets.length === 0)) throw new Error(`${ETS_RECORDS_FILE} is of format ${String(stored.format)}, not ${FORMAT}: record the whole corpus again with --missing`);
  const records: EtsRecords = fresh ? { format: FORMAT, projects: [], apps: {} } : readEtsRecords();
  const onDisk = corpusProjects();
  const dropped = records.projects.filter((p) => !existsSync(corpusPath(p.path))).map((p) => p.path);
  records.projects = records.projects.filter((p) => !dropped.includes(p.path));
  const paths = projectsToRecord(onDisk, new Set(records.projects.map((p) => p.path)), targets, missing);
  if (dryRun) {
    console.log(`would record ${paths.length} project(s):`);
    for (const p of paths) console.log(`  ${p}`);
    for (const p of dropped) console.log(`would drop the entry of ${p}, which is no longer in the corpus`);
    process.exit(0);
  }
  const candidates = [...new Set([...(process.env.KNXPROJ_PASSWORD ? [process.env.KNXPROJ_PASSWORD] : []), ...passwords()])];
  const failures: string[] = [];
  for (const p of paths) {
    try {
      const entry = recordProject(p, candidates, records.apps);
      records.projects = [...records.projects.filter((x) => x.path !== p), entry].sort((a, b) => a.path.localeCompare(b.path));
      console.log(`${p}: ${entry.devices.length} devices, ${entry.devices.filter((d) => d.loadedImage).length} with ETS's download record`);
    } catch (e) {
      failures.push(`${p}: ${describeFailure(e)}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} of ${paths.length} project(s) cannot be recorded, so nothing was written:\n${failures.join("\n")}`);
  const used = new Set(records.projects.flatMap((p) => p.devices.flatMap((d) => (d.loadedImage ? [d.application] : []))));
  records.apps = Object.fromEntries(Object.entries(records.apps).filter(([id]) => used.has(id)));
  writeFileSync(corpusPath(ETS_RECORDS_FILE), gzipSync(Buffer.from(JSON.stringify(records))));
  console.log(`recorded ${paths.length} project(s)${dropped.length ? `, dropped ${dropped.length} no longer in the corpus` : ""}`);
}
