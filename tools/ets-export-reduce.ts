// ETS's project export reduced to the product data of the devices its project holds, for an ETS sweep row
// (tools/ets-driver.ts stores each row's export through it). ETS keeps every product ever inserted into a project
// and exports all of them, so the export of the n-th row of a sweep project would carry the n-1 products before it.
//
//   bun run tools/ets-export-reduce.ts <export.knxproj> <out.knxproj> [--password-env <VAR>]
//
// Kept, byte for byte as ETS wrote them (local header, data, data descriptor): every entry outside the
// manufacturers' product data (the project P-xxxx with its signature and certificate, knx_master.xml,
// .validation); of each manufacturer of a device of the project its directory, Hardware.xml and Catalog.xml;
// and every application program the devices' Hardware2Program entries name (an application and a PEI program
// alike). Dropped: the other manufacturers' directories and signatures, the other application programs, the
// baggages, and the kept manufacturers' signatures (each signs its whole directory, so it no longer holds). The
// reduced export is the record of the row's project and devices that Busforge reads, not an archive to import
// into ETS again: without the signatures and baggages ETS may refuse it.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appProgramId, hardwarePrograms, loadKnxproj, programEntryName, type Device } from "../packages/project/src/index.ts";
import { EOCD_SIG, FLAG_DATA_DESCRIPTOR, readCentralDirectory, readZip } from "../packages/project/src/zip.ts";

const DESCRIPTOR_SIG = 0x08074b50;
const MANUFACTURER = /^(m-[0-9a-f]{4})(?:[/.]|$)/;

// The export reduced to the product data of `devices` (the devices of its project: their ProductRefId and
// Hardware2ProgramRefId), with the names of what was dropped. Refuses a device whose application program the
// export does not hold.
export function reduceExport(bytes: Buffer, devices: readonly Pick<Device, "ia" | "productRef" | "appRef">[]): { bytes: Buffer; dropped: string[] } {
  if (devices.length === 0) throw new Error("the project holds no device whose product data to keep");
  const { entries, start, comment } = readCentralDirectory(bytes);
  const files = readZip(bytes);
  const manufacturers = new Set(devices.map((d) => d.productRef.split("_")[0].toLowerCase()));
  const hardware = hardwarePrograms(files);
  // The archive paths of the programs the devices run, lower-cased, where the loader reads them (programEntryName).
  const programs = new Set<string>();
  for (const d of devices) {
    if (!d.appRef) continue;
    // Where no Hardware.xml describes the Hardware2Program, the program its id names (as readAppProgram reads it).
    for (const r of hardware.get(d.appRef) ?? [appProgramId(d.appRef)]) {
      const name = programEntryName(files, r);
      if (name === undefined) throw new Error(`the export holds no application program ${r} (the device ${d.ia})`);
      programs.add(name.toLowerCase());
    }
  }
  // A program may lie in another manufacturer's directory than its product's (the loader reads it from there).
  const directories = new Set([...manufacturers, ...[...programs].map((p) => p.split("/")[0])]);
  const kept = (name: string): boolean => {
    const n = name.toLowerCase(), m = MANUFACTURER.exec(n)?.[1];
    if (m === undefined) return true;
    if (programs.has(n) || n === `${m}/` && directories.has(m)) return true;
    return manufacturers.has(m) && (n === `${m}/hardware.xml` || n === `${m}/catalog.xml`);
  };
  // Each entry is its local header, its data and, with bit 3, a data descriptor (12 bytes, 16 with its signature),
  // and the entries lie end to end from the archive's start to the central directory: copied by those spans, an
  // entry that overlapped or left a gap would carry another entry's bytes or lose its own.
  const offsets = [...new Set(entries.map((e) => e.lfhOffset))].sort((a, b) => a - b);
  if (offsets.length !== entries.length) throw new Error("two central directory entries share a local header");
  const next = new Map(offsets.map((o, i) => [o, offsets[i + 1] ?? start]));
  if (entries.length && offsets[0] !== 0) throw new Error(`the first entry begins at ${offsets[0]}, not at the archive's start`);
  for (const e of entries) {
    const data = e.lfhOffset + 30 + bytes.readUInt16LE(e.lfhOffset + 26) + bytes.readUInt16LE(e.lfhOffset + 28) + e.compSize;
    const rest = next.get(e.lfhOffset)! - data;
    const fits = !(e.flags & FLAG_DATA_DESCRIPTOR) ? rest === 0 : rest === 12 || (rest === 16 && bytes.readUInt32LE(data) === DESCRIPTOR_SIG);
    if (!fits) throw new Error(`${e.name} (local header at ${e.lfhOffset}, data to ${data}) does not end where the next entry begins (${next.get(e.lfhOffset)})`);
  }
  const locals: Buffer[] = [], records: Buffer[] = [], dropped: string[] = [];
  let length = 0;
  for (const e of entries) {
    if (!kept(e.name)) { dropped.push(e.name); continue; }
    const local = bytes.subarray(e.lfhOffset, next.get(e.lfhOffset));
    const record = Buffer.from(bytes.subarray(...e.record));
    record.writeUInt32LE(length, 42);
    locals.push(local);
    records.push(record);
    length += local.length;
  }
  const cd = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  const out = Buffer.concat([...locals, cd, eocd, comment]);
  // The reduced archive read back whole: the kept files, each with the export's bytes, every program the devices
  // need among them.
  const read = readZip(out);
  const want = [...files.keys()].filter(kept);
  if ([...read.keys()].join("\n") !== want.join("\n") || want.some((n) => !read.get(n)!.equals(files.get(n)!))) throw new Error("the reduced export does not read back as the kept files of the export");
  return { bytes: out, dropped };
}

// The export of a project reduced to the product data of the devices it holds.
export function reduceProjectExport(bytes: Buffer, password: string | undefined): { bytes: Buffer; dropped: string[] } {
  return reduceExport(bytes, loadKnxproj(bytes, password, "export").devices);
}

if (import.meta.main) {
  const [from, to, flag, env, ...rest] = process.argv.slice(2);
  try {
    if (!from || !to || rest.length || (flag !== undefined && (flag !== "--password-env" || !env))) throw new Error("usage: bun run tools/ets-export-reduce.ts <export.knxproj> <out.knxproj> [--password-env <VAR>]");
    if (resolve(from) === resolve(to)) throw new Error("the reduced export goes to another file than the export");
    if (env !== undefined && process.env[env] === undefined) throw new Error(`--password-env ${env}: the variable is not set`);
    const r = reduceProjectExport(readFileSync(from), env === undefined ? undefined : process.env[env]);
    writeFileSync(to, r.bytes);
    console.log(`${to}: ${r.bytes.length} bytes; dropped ${r.dropped.length} entries`);
  } catch (e) {
    console.error(`ets-export-reduce: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
