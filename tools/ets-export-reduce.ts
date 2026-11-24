// ETS's project export reduced to one device's product data, for an ETS sweep row (tools/ets-driver.ts stores
// each row's export through it). ETS keeps every product ever inserted into a project and exports all of them,
// so the export of the n-th row of a sweep project would carry the n-1 products before it.
//
//   bun run tools/ets-export-reduce.ts <export.knxproj> <out.knxproj> <application id>...
//
// Kept, byte for byte as ETS wrote them (local header, data, data descriptor): every entry outside the
// manufacturers' product data (the project P-xxxx with its signature and certificate, knx_master.xml,
// .validation), and of the applications' manufacturer its directory, Hardware.xml, Catalog.xml and the named
// application programs. Dropped: every other manufacturer's directory and signature, the manufacturer's other
// application programs, its Baggages and its signature (which signs the whole directory, so it no longer holds).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readZip } from "../packages/project/src/zip.ts";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64 = 0xffffffff;
const APPLICATION_ID = /^(M-[0-9A-F]{4})_A-[0-9A-F]{4}-[0-9A-F]{2}-[0-9A-F]{4}(?:-O[0-9A-F]+)?$/i;

interface Entry { name: string; record: Buffer; lfh: number }

function centralDirectory(buf: Buffer): { entries: Entry[]; start: number; comment: Buffer } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  if (eocd < 0) throw new Error("the export is no zip: no end of central directory record");
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new Error("the export spans several disks");
  const count = buf.readUInt16LE(eocd + 10), size = buf.readUInt32LE(eocd + 12), start = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === ZIP64 || start === ZIP64) throw new Error("the export is a ZIP64 archive");
  if (start + size !== eocd) throw new Error(`the central directory (${size} bytes at ${start}) does not end at the end record (${eocd})`);
  const entries: Entry[] = [];
  let off = start;
  for (let i = 0; i < count; i++) {
    if (off + 46 > eocd || buf.readUInt32LE(off) !== CD_SIG) throw new Error(`central directory entry ${i} of ${count} is malformed`);
    const len = 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    const lfh = buf.readUInt32LE(off + 42);
    if (lfh === ZIP64 || buf.readUInt32LE(off + 20) === ZIP64 || buf.readUInt32LE(off + 24) === ZIP64) throw new Error("the export is a ZIP64 archive");
    if (lfh + 30 > start || buf.readUInt32LE(lfh) !== LFH_SIG) throw new Error(`the local header of central directory entry ${i} is malformed`);
    entries.push({ name: buf.toString("utf8", off + 46, off + 46 + buf.readUInt16LE(off + 28)), record: buf.subarray(off, off + len), lfh });
    off += len;
  }
  if (off !== eocd) throw new Error(`the central directory's ${count} entries end at ${off}, not at the end record (${eocd})`);
  return { entries, start, comment: buf.subarray(eocd + 22) };
}

// Whether the reduced export keeps `name`; `manufacturer` and `programs` lower-cased.
function kept(name: string, manufacturer: string, programs: ReadonlySet<string>): boolean {
  const n = name.toLowerCase();
  if (!/^m-[0-9a-f]{4}(?:[/.]|$)/.test(n)) return true;
  return n === `${manufacturer}/` || n === `${manufacturer}/hardware.xml` || n === `${manufacturer}/catalog.xml`
    || [...programs].some((p) => n === `${manufacturer}/${p}.xml`);
}

// The export reduced to the product data of `applications` (application program ids, of one manufacturer),
// with the names of what was dropped. Refuses an application the export does not hold.
export function reduceExport(bytes: Buffer, applications: readonly string[]): { bytes: Buffer; dropped: string[] } {
  if (applications.length === 0) throw new Error("no application to keep");
  const bad = applications.find((a) => !APPLICATION_ID.test(a));
  if (bad !== undefined) throw new Error(`${bad} is no application program id`);
  const manufacturers = new Set(applications.map((a) => APPLICATION_ID.exec(a)![1].toLowerCase()));
  if (manufacturers.size > 1) throw new Error(`the applications ${applications.join(", ")} are of ${manufacturers.size} manufacturers`);
  const manufacturer = [...manufacturers][0];
  const programs = new Set(applications.map((a) => a.toLowerCase()));
  const { entries, start, comment } = centralDirectory(bytes);
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  const missing = [...programs].filter((p) => !names.has(`${manufacturer}/${p}.xml`));
  if (missing.length) throw new Error(`the export holds no application program ${missing.join(", ")}`);
  // An entry's local header, data and data descriptor run up to the next entry's local header.
  const offsets = [...new Set(entries.map((e) => e.lfh))].sort((a, b) => a - b);
  if (offsets.length !== entries.length) throw new Error("two central directory entries share a local header");
  const end = (lfh: number) => offsets[offsets.indexOf(lfh) + 1] ?? start;
  const locals: Buffer[] = [], records: Buffer[] = [], dropped: string[] = [];
  let at = 0;
  for (const e of entries) {
    if (!kept(e.name, manufacturer, programs)) { dropped.push(e.name); continue; }
    const local = bytes.subarray(e.lfh, end(e.lfh));
    const record = Buffer.from(e.record);
    record.writeUInt32LE(at, 42);
    locals.push(local);
    records.push(record);
    at += local.length;
  }
  const cd = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(at, 16);
  eocd.writeUInt16LE(comment.length, 20);
  const out = Buffer.concat([...locals, cd, eocd, comment]);
  // The reduced archive read back whole, without unpacking the export (whose size the reduction exists to bound).
  const files = entries.filter((e) => !e.name.endsWith("/") && kept(e.name, manufacturer, programs)).map((e) => e.name);
  const read = [...readZip(out).keys()];
  if (read.join("\n") !== files.join("\n")) throw new Error(`the reduced export reads as ${read.length} files, not as the ${files.length} kept`);
  return { bytes: out, dropped };
}

if (import.meta.main) {
  const [from, to, ...applications] = process.argv.slice(2);
  try {
    if (!from || !to || applications.length === 0) throw new Error("usage: bun run tools/ets-export-reduce.ts <export.knxproj> <out.knxproj> <application id>...");
    if (resolve(from) === resolve(to)) throw new Error("the reduced export goes to another file than the export");
    const r = reduceExport(readFileSync(from), applications);
    writeFileSync(to, r.bytes);
    console.log(`${to}: ${r.bytes.length} bytes; dropped ${r.dropped.length} entries`);
  } catch (e) {
    console.error(`ets-export-reduce: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
