#!/usr/bin/env bun
// ETS byte-diff GATE: hold what Busforge writes in a FULL DOWNLOAD against what ETS actually wrote
// to a real device in its own full download of the same configuration, segment by segment, byte
// for byte.
//
//   bun run tools/etsdiff.ts <ets-capture.log> --project=<file.knxproj> [--password=<pw>] [--device=<index> | --ia=<a.l.d>]
//   bun run tools/etsdiff.ts <ets-capture.log> --app=<app.xml | app.xml.gz | product.knxprod> --ia=<a.l.d>
//        [--app-id=<M-XXXX_A-...>] [--product=<productRef>] [--param=<ParameterRefId>=<value>]... [--link=<objNum>:<ga>[,<ga>]]...
//   common: [--base=<n>] [--seg-base=<lsm>:<n>]... [--partial] [--evidence=<out.json>]
//
// --project takes the device's configuration from the project (parameters, module instances and
// links, exactly as an import stores them). Without a project, --app names the application program
// and the configuration is stated on the command line: nothing but --param/--link is set, every
// other parameter is at its application default. --evidence writes the result as an evidence
// record pointing at the capture by path and hash; the capture must be kept for the record to stay
// checkable (docs/evidence-contract.md).
//
// --partial takes an ETS partial download instead: ETS writes only the segments that changed, so
// the same comparison runs over what it wrote, and the evidence splits into one record per
// Busforge operation that writes the compared segments (flashParams for the parameter segments,
// flashLinks for the group tables).
//
// WHY THIS EXISTS. Busforge's own flash verifies device == our-image. That proves the device holds
// what we sent; it can NEVER prove our-image == what ETS would have sent. A wrong codec, resolver or
// table layout stays green through every test and every read-back. This tool is the our-image == ETS
// check: the reference axis of docs/evidence-contract.md.
//
// WHAT IS COMPARED. The image is built by the SAME planner the server's full download runs
// (DeviceProfile.planFullDownload, packages/product/src/profiles.ts), so every refusal the server
// would raise is raised here too. ETS's side is every A_Memory_Write (APCI 0x280) and
// A_MemoryExtended_Write (0x1FB) the capture shows ETS sending to the device's individual address,
// replayed in order (a later write wins per byte). Each segment Busforge writes is compared at its
// device address; ETS bytes that fall in no Busforge segment, and Busforge bytes ETS never wrote,
// are listed, never dropped.
//
// THE ADDRESS OF A SYSTEM B SEGMENT is assigned by the DEVICE when ETS allocates it
// (LdCtrlRelSegment), so it is not in the application program. The device reports it in its answer
// to ETS's PID_TABLE_REFERENCE read (object = the LSM, PID 7), which the capture holds; that is the
// base used per segment. --seg-base=<lsm>:<n> pins one (--base=<n> pins LSM 4). Where the capture
// has no such answer, the parameter segment's base is inferred from the alignment of distinctive
// multi-byte writes; comparing without the base makes every write look divergent on a
// byte-identical image. A table segment without a known base is not compared
// and its ETS bytes stay unattributed, which fails the gate. ETS's allocation (PID 5, AdditionalLoad
// Controls 0x03 0x0B) gives the segment size and fill ETS asked for: a byte ETS allocated with a fill
// and never wrote holds that fill, and is compared as such.
//
// THE CAPTURE. Run ETS through the Busforge bridge with the logging proxy (scratchpad/knxproxy.ts)
// and do a full download. Lines consumed: `... ETS->BRIDGE ... TUNNELLING_REQ ... | <frame-hex>`
// (ETS's requests) and `... BRIDGE->ETS ... TUNNELLING_REQ ... | <frame-hex>` (the device's answers).
import { gunzipSync } from "node:zlib";
import { iaToNum, OBJ } from "../packages/knx/src/index.ts";
import { loadKnxproj, readAppProgram, readZip } from "../packages/project/src/index.ts";
import {
  parseAppConfig, classify, parseLoadProcedures, isMemoryMappedLsm, buildDeviceConfig,
  type AppConfig, type ComObjectLink, type FullDownloadSegment, type ModuleInstance,
} from "../packages/product/src/index.ts";
import { fullRef } from "../apps/server/src/refids.ts";
import { etsdiffEvidence, gitRevision, sha256 } from "./evidence.ts";

const PID_LOAD_STATE_CONTROL = 5;
const PID_TABLE_REFERENCE = 7;
// The memory-mapped LSM interface (MV-0700/0701): load controls are memory writes to this register.
const MM_CTRL_ADDR = 0x0104;
const TABLE_SOURCES = new Set<FullDownloadSegment["source"]>(["addrTable", "assocTable", "comObjTable"]);

// ── capture parsing ──────────────────────────────────────────────────────────

export interface MemWrite { addr: number; data: Buffer; service: "A_Memory_Write" | "A_MemoryExtended_Write" }
export interface PropWrite { obj: number; pid: number; data: Buffer }
export interface PropResponse { obj: number; pid: number; data: Buffer }
export interface Capture {
  writes: MemWrite[];           // ETS -> device memory writes, in capture order
  propWrites: PropWrite[];      // ETS -> device property writes, in capture order
  propResponses: PropResponse[]; // device -> ETS property responses, in capture order
  otherDestination: number;     // ETS memory writes addressed to any other device (not compared)
}

interface LData { code: number; src: number; dst: number; group: boolean; tpdu: Buffer }

// One KNXnet/IP TUNNELLING_REQUEST: header (its own length), connection header (its own length),
// then a cEMI L_Data frame. Anything else returns null.
export function parseTunnelFrame(hex: string): LData | null {
  const f = Buffer.from(hex, "hex");
  if (f.length < 8 || f.readUInt16BE(2) !== 0x0420) return null;
  const cemi = f.subarray(f[0] + f[f[0]]);
  if (cemi.length < 2) return null;
  const o = 2 + cemi[1];
  if (cemi.length < o + 7) return null;
  const len = cemi[o + 6];
  const tpdu = cemi.subarray(o + 7, o + 8 + len);
  if (tpdu.length !== len + 1) return null;
  return { code: cemi[0], src: cemi.readUInt16BE(o + 2), dst: cemi.readUInt16BE(o + 4), group: (cemi[o + 1] & 0x80) !== 0, tpdu };
}

const L_DATA_REQ = 0x11, L_DATA_IND = 0x29;

export function parseCapture(text: string, deviceIa: number): Capture {
  const cap: Capture = { writes: [], propWrites: [], propResponses: [], otherDestination: 0 };
  for (const line of text.split("\n")) {
    if (!line.includes("TUNNELLING_REQ")) continue;
    const fromEts = line.includes("ETS->BRIDGE"), toEts = line.includes("BRIDGE->ETS");
    if (!fromEts && !toEts) continue;
    const m = line.match(/\| ([0-9a-fA-F]+)\s*$/);
    if (!m) continue;
    const fr = parseTunnelFrame(m[1]);
    if (!fr || fr.group || fr.tpdu.length < 2) continue;
    const t = fr.tpdu, apci = ((t[0] & 0x03) << 8) | t[1];
    if (fromEts && fr.code === L_DATA_REQ) {
      const mem = memWriteOf(t, apci);
      if (mem) { if (fr.dst === deviceIa) cap.writes.push(mem); else cap.otherDestination++; continue; }
      if (apci === 0x3d7 && fr.dst === deviceIa && t.length >= 6) cap.propWrites.push({ obj: t[2], pid: t[3], data: Buffer.from(t.subarray(6)) });
    } else if (toEts && fr.code === L_DATA_IND && fr.src === deviceIa && apci === 0x3d6 && t.length >= 6) {
      cap.propResponses.push({ obj: t[2], pid: t[3], data: Buffer.from(t.subarray(6)) });
    }
  }
  return cap;
}

function memWriteOf(t: Buffer, apci: number): MemWrite | null {
  if ((apci & 0x3f0) === 0x280) { // A_Memory_Write: count in the APCI's low 4 bits, 16-bit address
    const n = t[1] & 0x0f, data = t.subarray(4, 4 + n);
    return t.length >= 4 && data.length === n ? { addr: t.readUInt16BE(2), data: Buffer.from(data), service: "A_Memory_Write" } : null;
  }
  if (apci === 0x1fb) { // A_MemoryExtended_Write: count byte, 24-bit address
    if (t.length < 6) return null;
    const n = t[2], data = t.subarray(6, 6 + n);
    return data.length === n ? { addr: t.readUIntBE(3, 3), data: Buffer.from(data), service: "A_MemoryExtended_Write" } : null;
  }
  return null;
}

// Replay the writes in order: a later write to a byte replaces an earlier one.
export function memoryImage(writes: MemWrite[]): Map<number, number> {
  const mem = new Map<number, number>();
  for (const w of writes) for (let i = 0; i < w.data.length; i++) mem.set(w.addr + i, w.data[i]);
  return mem;
}

// What ETS's relative-segment allocation asked for, per LSM: the last AdditionalLoadControls
// "allocate" (0x03 0x0B size:4 fillFlag fillByte) written to the LSM's PID 5.
export function etsAllocations(cap: Capture): Map<number, { size: number; fill: number | null }> {
  const out = new Map<number, { size: number; fill: number | null }>();
  for (const p of cap.propWrites) {
    if (p.pid !== PID_LOAD_STATE_CONTROL || p.data.length < 8 || p.data[0] !== 0x03 || p.data[1] !== 0x0b) continue;
    out.set(p.obj, { size: p.data.readUInt32BE(2), fill: p.data[6] === 1 ? p.data[7] : null });
  }
  return out;
}

// The segment address the device reported for each LSM (its last PID_TABLE_REFERENCE answer).
export function reportedTableReferences(cap: Capture): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of cap.propResponses) if (r.pid === PID_TABLE_REFERENCE && r.data.length === 4) out.set(r.obj, r.data.readUInt32BE(0));
  return out;
}

// ── the comparison ───────────────────────────────────────────────────────────

export interface ComparedSegment { seg: FullDownloadSegment; address: number | null; baseSource: string }
export interface Divergence { offset: number; address: number; busforge: number; ets: number; etsSource: "written" | "fill" }
export interface SegmentResult {
  id: string; lsm: number; address: number | null; baseSource: string;
  busforgeBytes: number; etsWrote: number; etsFill: number; compared: number;
  divergences: Divergence[];
  busforgeOnly: number[]; // offsets Busforge writes that ETS neither wrote nor filled
  etsOnly: number[];      // offsets ETS wrote or allocated past the end of Busforge's image
  etsAllocSize: number | null;
}
export interface Exclusion { rule: string; addresses: number[] }
export interface DiffResult {
  segments: SegmentResult[];
  unattributed: number[]; // ETS-written addresses no Busforge segment covers and no rule excludes
  exclusions: Exclusion[];
}

export function compareSegments(
  segments: ComparedSegment[], mem: Map<number, number>,
  alloc: Map<number, { size: number; fill: number | null }>, exclusionRules: { rule: string; covers: (addr: number) => boolean }[],
): DiffResult {
  const claimed = new Set<number>();
  const results: SegmentResult[] = [];
  for (const { seg, address, baseSource } of segments) {
    const a = seg.address === null ? alloc.get(seg.lsm) : undefined;
    const r: SegmentResult = {
      id: seg.id, lsm: seg.lsm, address, baseSource, busforgeBytes: seg.image.length, etsWrote: 0, etsFill: 0, compared: 0,
      divergences: [], busforgeOnly: [], etsOnly: [], etsAllocSize: a?.size ?? null,
    };
    results.push(r);
    if (address === null) continue;
    const span = Math.max(seg.image.length, a?.size ?? 0);
    for (let i = 0; i < span; i++) {
      const at = address + i;
      const written = mem.get(at);
      if (written !== undefined) claimed.add(at);
      const ets = written ?? (a && a.fill !== null && i < a.size ? a.fill : undefined);
      if (written !== undefined) r.etsWrote++; else if (ets !== undefined) r.etsFill++;
      const bf = i < seg.image.length ? seg.image[i] : undefined;
      if (bf === undefined) { if (ets !== undefined || (a && i < a.size)) r.etsOnly.push(i); continue; }
      if (ets === undefined) { r.busforgeOnly.push(i); continue; }
      r.compared++;
      if (bf !== ets) r.divergences.push({ offset: i, address: at, busforge: bf, ets, etsSource: written !== undefined ? "written" : "fill" });
    }
  }
  const exclusions = exclusionRules.map((e) => ({ rule: e.rule, addresses: [] as number[] }));
  const unattributed: number[] = [];
  for (const at of [...mem.keys()].sort((x, y) => x - y)) {
    if (claimed.has(at)) continue;
    const k = exclusionRules.findIndex((e) => e.covers(at));
    if (k >= 0) exclusions[k].addresses.push(at); else unattributed.push(at);
  }
  return { segments: results, unattributed, exclusions: exclusions.filter((e) => e.addresses.length > 0) };
}

// Infer a relative segment's base from where ETS's distinctive multi-byte writes land in our image.
// Zero-heavy runs match everywhere in a mostly-zero image and would drown the vote, so candidates
// come only from runs with several distinct non-zero bytes; the candidate that makes the most writes
// match wins.
export function inferBase(image: Buffer, writes: MemWrite[]): number | null {
  const distinctive = (b: Buffer) => b.length >= 3 && new Set(b).size >= 3 && b.filter((x) => x !== 0).length >= 3;
  const candidates = new Set<number>();
  for (const w of writes) {
    if (!distinctive(w.data)) continue;
    for (let i = image.indexOf(w.data); i >= 0; i = image.indexOf(w.data, i + 1)) if (w.addr - i >= 0) candidates.add(w.addr - i);
  }
  const score = (b: number) => writes.filter((w) => {
    const off = w.addr - b;
    return off >= 0 && off + w.data.length <= image.length && image.subarray(off, off + w.data.length).equals(w.data);
  }).length;
  return [...candidates].sort((x, y) => score(y) - score(x))[0] ?? null;
}

// Parameters an application declares at a byte of a segment, to name what a divergent byte is.
function declaredAt(cfg: AppConfig, segId: string, offset: number): string[] {
  return [...cfg.params.values()].filter((p) => p.codeSegment === segId && p.offset === offset && !p.moduleDefId)
    .map((p) => `${p.id.split("_").pop()} "${p.text.trim()}"${p.value !== undefined ? ` default ${p.value}` : ""}${p.access ? ` Access=${p.access}` : ""}${p.patchAlways ? " LegacyPatchAlways" : ""}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const hex = (n: number, w = 4) => `0x${n.toString(16).padStart(w, "0")}`;
const hexByte = (n: number) => n.toString(16).padStart(2, "0");

// A group address as the project writes it: "a/b/c" (3-level), "a/b" (2-level) or a raw number.
export function parseGa(s: string): number {
  const p = s.split("/").map(Number);
  if (p.some((x) => !Number.isInteger(x) || x < 0)) throw new Error(`not a group address: ${s}`);
  if (p.length === 3 && p[0] < 32 && p[1] < 8 && p[2] < 256) return (p[0] << 11) | (p[1] << 8) | p[2];
  if (p.length === 2 && p[0] < 32 && p[1] < 2048) return (p[0] << 11) | p[1];
  if (p.length === 1 && p[0] < 65536) return p[0];
  throw new Error(`not a group address: ${s}`);
}

function readAppXml(path: string, bytes: Buffer, appId: string | undefined): string {
  if (path.endsWith(".gz")) return gunzipSync(bytes).toString("utf8");
  if (!path.endsWith(".knxprod")) return bytes.toString("utf8");
  const zip = readZip(bytes);
  const apps = [...zip.keys()].filter((k) => /\/M-[0-9A-F]{4}_A-[^/]*\.xml$/i.test(k) && (appId === undefined || k.endsWith(`/${appId}.xml`)));
  if (apps.length !== 1) throw new Error(`${path} holds ${apps.length} application program(s)${appId ? ` named ${appId}` : ""}; name one with --app-id (${[...zip.keys()].filter((k) => /_A-/.test(k)).join(", ")})`);
  return new TextDecoder().decode(zip.get(apps[0])!);
}

interface Subject { ia: string; name: string; productRef: string | null; appRef: string; appXml: string; params: Map<string, string>; instances: ModuleInstance[]; links: ComObjectLink[]; configuration: string }

async function loadSubject(opt: (k: string) => string | undefined, many: (k: string) => string[]): Promise<Subject> {
  const projPath = opt("project"), appPath = opt("app");
  if (!!projPath === !!appPath) throw new Error("name exactly one of --project=<file.knxproj> or --app=<application program>");
  if (projPath) {
    if (many("param").length || many("link").length) throw new Error("--param/--link state a configuration without a project; with --project the project's configuration is used");
    const bytes = Buffer.from(await Bun.file(projPath).arrayBuffer());
    const proj = loadKnxproj(bytes, opt("password"), "project");
    const ia = opt("ia");
    const d = ia ? proj.devices.find((x) => x.ia === ia) : proj.devices[Number(opt("device") ?? "0")];
    if (!d) throw new Error(ia ? `no device ${ia} in the project` : `no device at index ${opt("device") ?? 0} (project has ${proj.devices.length})`);
    const appXml = readAppProgram(bytes, d.appRef);
    if (!appXml) throw new Error(`the project does not carry ${d.appRef}`);
    const params = new Map((proj.deviceParams.find((p) => p.deviceId === d.id)?.values ?? []).map((v) => [v.refId, v.value] as [string, string]));
    const instances = proj.deviceModules.find((m) => m.deviceId === d.id)?.instances ?? [];
    // Links resolve to com-object numbers through the configured view, as the server's download does
    // (deviceservice resolveDeviceLinks).
    const cfg = parseAppConfig(appXml);
    const view = buildDeviceConfig(cfg, params, undefined, instances);
    const numByRef = new Map<string, number>();
    for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") numByRef.set(it.comObject.refId, it.comObject.number);
    const stored = new Map((proj.deviceLinks.find((l) => l.deviceId === d.id)?.links ?? []).map((l) => [l.comObjRefId, l.gaRaws] as [string, number[]]));
    // deviceservice.selectFlashLinks; the server module is not imported because it drags the server's
    // DOM-less type environment into this workspace.
    const links: ComObjectLink[] = [];
    for (const [refId, gaRaws] of stored) { const num = numByRef.get(fullRef(cfg.id, refId)); if (num !== undefined) links.push({ comObjNum: num, gaRaws }); }
    // A link on a com-object this configuration hides is kept in the project but not downloaded, by
    // the server as by ETS; say how many.
    const hidden = stored.size - links.length;
    return { ia: d.ia, name: d.name, productRef: d.productRef, appRef: d.appRef, appXml, params, instances, links, configuration: `the project's configuration of ${d.ia} (${params.size} parameter values, ${instances.length} module instances, ${links.length} linked objects${hidden ? `, ${hidden} links on hidden objects not downloaded` : ""})` };
  }
  const ia = opt("ia");
  if (!ia) throw new Error("--app needs --ia=<a.l.d>: the address table holds it, and only writes to it are compared");
  const appXml = readAppXml(appPath!, Buffer.from(await Bun.file(appPath!).arrayBuffer()), opt("app-id"));
  const params = new Map<string, string>();
  for (const p of many("param")) {
    const k = p.lastIndexOf("=");
    if (k <= 0) throw new Error(`--param needs <ParameterRefId>=<value>, not ${p}`);
    params.set(p.slice(0, k), p.slice(k + 1));
  }
  const links = many("link").map((l): ComObjectLink => {
    const [num, gas] = l.split(":");
    if (!/^\d+$/.test(num) || !gas) throw new Error(`--link needs <objNum>:<ga>[,<ga>], not ${l}`);
    return { comObjNum: Number(num), gaRaws: gas.split(",").map(parseGa) };
  });
  const cfg = parseAppConfig(appXml);
  const configuration = `application defaults${params.size ? ` with ${[...params].map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}, ${links.length ? `links ${links.map((l) => `#${l.comObjNum}->${l.gaRaws.map((g) => hex(g)).join("+")}`).join(", ")}` : "no links"}`;
  return { ia, name: "(no project)", productRef: opt("product") ?? null, appRef: cfg.id, appXml, params, instances: [], links, configuration };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const many = (k: string) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
  const [capturePath, ...extra] = args.filter((a) => !a.startsWith("--"));
  if (!capturePath || extra.length) {
    console.error("usage: bun run tools/etsdiff.ts <ets-capture.log> (--project=<file.knxproj> [--password=<pw>] [--device=<i>|--ia=<a.l.d>] | --app=<xml|xml.gz|knxprod> --ia=<a.l.d> [--app-id=..] [--product=..] [--param=<ref>=<v>].. [--link=<obj>:<ga>[,<ga>]]..) [--base=<n>] [--seg-base=<lsm>:<n>].. [--partial] [--evidence=<out.json>]");
    return 2;
  }
  const subject = await loadSubject(opt, many);
  const cfg = parseAppConfig(subject.appXml);
  const profile = classify(cfg);
  // The planner the server's full download runs; it refuses what the server would refuse.
  const build = profile.planFullDownload(cfg.mask, {
    ia: subject.ia, params: subject.params, links: subject.links, moduleInstances: subject.instances, proc: parseLoadProcedures(subject.appXml),
  });

  const captureBytes = new Uint8Array(await Bun.file(capturePath).arrayBuffer());
  const cap = parseCapture(new TextDecoder().decode(captureBytes), iaToNum(subject.ia));
  if (cap.writes.length === 0) throw new Error(`no memory write to ${subject.ia} in ${capturePath}; is it an ETS download of that device through the logging proxy?`);
  const mem = memoryImage(cap.writes);
  const alloc = etsAllocations(cap);
  const reported = reportedTableReferences(cap);

  // Where each segment sits on the device.
  const pinned = new Map<number, number>();
  if (opt("base") !== undefined) pinned.set(OBJ.APP_PROGRAM, Number(opt("base")));
  for (const s of many("seg-base")) { const [l, b] = s.split(":").map(Number); pinned.set(l, b); }
  const placed: ComparedSegment[] = build.segments.map((seg) => {
    if (seg.address !== null) return { seg, address: seg.address, baseSource: "declared in the application program" };
    const p = pinned.get(seg.lsm);
    if (p !== undefined) return { seg, address: p, baseSource: "pinned" };
    const r = reported.get(seg.lsm);
    if (r !== undefined) return { seg, address: r, baseSource: `the device's PID_TABLE_REFERENCE answer for LSM ${seg.lsm}` };
    if (seg.lsm === OBJ.APP_PROGRAM) {
      const b = inferBase(seg.image, cap.writes);
      if (b !== null) return { seg, address: b, baseSource: "inferred from the alignment of distinctive writes" };
    }
    return { seg, address: null, baseSource: "unknown: the capture holds no PID_TABLE_REFERENCE answer for it (pin it with --seg-base)" };
  });
  const rules = isMemoryMappedLsm(cfg.mask)
    ? [{ rule: `${hex(MM_CTRL_ADDR)} is the memory-mapped load-control register of mask ${cfg.mask} (LdCtrl* events, not memory contents)`, covers: (at: number) => at >= MM_CTRL_ADDR && at < MM_CTRL_ADDR + 11 }]
    : [];
  const diff = compareSegments(placed, mem, alloc, rules);

  // ── report ──
  console.log(`device ${subject.ia} "${subject.name}"  app ${subject.appRef}  mask ${cfg.mask} (${profile.memoryModel})`);
  console.log(`  configuration: ${subject.configuration}`);
  console.log(`  ETS capture: ${cap.writes.length} memory writes to ${subject.ia} (${mem.size} distinct bytes), ${cap.propWrites.length} property writes${cap.otherDestination ? `, ${cap.otherDestination} memory writes to other devices ignored` : ""}`);
  const declaredUnwritten = cfg.absoluteSegments.filter((s) => !build.segments.some((b) => b.address === s.address));
  if (declaredUnwritten.length) console.log(`  declared segments Busforge writes nothing to: ${declaredUnwritten.map((s) => `${s.id.split("_").pop()} @${hex(s.address)} (${s.size}B)`).join(", ")}`);
  let divergent = 0, compared = 0, busforgeOnly = 0, etsOnly = 0;
  for (const r of diff.segments) {
    divergent += r.divergences.length; compared += r.compared; busforgeOnly += r.busforgeOnly.length; etsOnly += r.etsOnly.length;
    const at = r.address === null ? "@?" : `@${hex(r.address)}`;
    console.log(`\n[${r.id}] LSM ${r.lsm} ${at}  base: ${r.baseSource}`);
    if (r.address === null) { console.log(`  NOT COMPARED: ${r.busforgeBytes} Busforge bytes, address unknown`); continue; }
    console.log(`  Busforge ${r.busforgeBytes}B | ETS wrote ${r.etsWrote}B${r.etsFill ? ` + ${r.etsFill}B left at its allocation fill` : ""}${r.etsAllocSize !== null ? ` (ETS allocated ${r.etsAllocSize}B)` : ""} | compared ${r.compared}B | divergent ${r.divergences.length}`);
    const segId = cfg.absoluteSegments.find((s) => s.address === r.address)?.id ?? (r.address !== null && build.segments.find((b) => b.id === r.id)?.address === null ? cfg.segments.find((s) => s.lsm === r.lsm)?.id : undefined);
    for (const v of r.divergences.slice(0, 40)) {
      const who = segId ? declaredAt(cfg, segId, v.offset) : [];
      console.log(`  DIVERGE @${hex(v.address)} (+${v.offset})  busforge=${hexByte(v.busforge)}  ets=${hexByte(v.ets)}${v.etsSource === "fill" ? " (ETS allocation fill)" : ""}${who.length ? `  declared here: ${who.join("; ")}` : ""}`);
    }
    if (r.divergences.length > 40) console.log(`  ... ${r.divergences.length - 40} more`);
    if (r.busforgeOnly.length) console.log(`  Busforge writes ${r.busforgeOnly.length}B ETS does not (not proven by this capture): offsets ${ranges(r.busforgeOnly)}`);
    if (r.etsOnly.length) console.log(`  ETS covers ${r.etsOnly.length}B past Busforge's ${r.busforgeBytes}B image: offsets ${ranges(r.etsOnly)}`);
  }
  for (const e of diff.exclusions) console.log(`\nEXCLUDED ${e.addresses.length} ETS-written bytes (${ranges(e.addresses, true)}): ${e.rule}`);
  if (diff.unattributed.length) console.log(`\nUNATTRIBUTED: ETS wrote ${diff.unattributed.length} bytes no Busforge segment covers: ${ranges(diff.unattributed, true)}`);
  const propSummary = new Map<string, number>();
  for (const p of cap.propWrites) propSummary.set(`obj ${p.obj} PID ${p.pid}`, (propSummary.get(`obj ${p.obj} PID ${p.pid}`) ?? 0) + 1);
  if (propSummary.size) console.log(`\nnot compared, ETS property writes: ${[...propSummary].map(([k, n]) => `${k} x${n}`).join(", ")}`);

  const partial = args.includes("--partial");
  // A segment without a device address is never compared. In a full download that is a gap. In a
  // partial download it is acceptable only for a segment ETS did not touch at all: a byte ETS wrote
  // there would be unattributed and fail anyway, but an allocation with a fill and no write would
  // not, so a segment whose load state machine ETS drove counts as not compared.
  const touchedLsm = new Set([...alloc.keys(), ...cap.propWrites.map((p) => p.obj)]);
  const gap = (i: number) => diff.segments[i].address === null && (!partial || touchedLsm.has(placed[i].seg.lsm));
  const uncompared = placed.filter((_, i) => gap(i)).length;
  const pass = compared > 0 && divergent === 0 && etsOnly === 0 && diff.unattributed.length === 0 && uncompared === 0;
  const withBytes = diff.segments.filter((r) => r.compared > 0).length;
  console.log(`\nsummary: ${compared} bytes compared across ${withBytes} segments, ${divergent} divergent, ${etsOnly + diff.unattributed.length} ETS bytes outside Busforge's image, ${busforgeOnly} Busforge bytes ETS does not write, ${uncompared} segments not compared.`);

  const evidencePath = opt("evidence");
  if (evidencePath) {
    const recordedAt = new Date().toISOString();
    const run = { recordedAt, runnerRevision: gitRevision(), artifact: capturePath, sha256: sha256(captureBytes) };
    // A full download is one operation. A partial download is split by the Busforge operation that
    // writes each segment; a static segment is written by the full download alone and joins neither,
    // so a failure there has no record to carry it and the evidence is refused.
    if (partial) {
      const lost = placed.flatMap((p, i) => p.seg.source === "static" && (diff.segments[i].divergences.length || diff.segments[i].etsOnly.length || gap(i)) ? [p.seg.id] : []);
      if (lost.length) throw new Error(`static segment(s) ${lost.join(", ")} disagree with ETS or could not be compared; no flash operation writes them, so no partial record can carry that. Compare a full download instead.`);
    }
    const groups: { operation: "fullDownload" | "flashParams" | "flashLinks"; idx: number[] }[] = partial
      ? (["flashParams", "flashLinks"] as const).map((operation) => ({
        operation,
        idx: placed.flatMap((p, i) => (operation === "flashParams" ? p.seg.source === "params" : TABLE_SOURCES.has(p.seg.source)) ? [i] : []),
      }))
      : [{ operation: "fullDownload", idx: placed.map((_, i) => i) }];
    const segmentState = (i: number) => {
      const r = diff.segments[i];
      if (r.address !== null) return `${r.divergences.length}/${r.compared}`;
      return gap(i) ? "not compared, address unknown" : "not written by this partial download";
    };
    const records = groups.flatMap(({ operation, idx }) => {
      const rs = idx.map((i) => diff.segments[i]);
      const n = rs.reduce((k, r) => k + r.compared, 0);
      if (partial && n === 0 && !idx.some(gap)) return [];
      return [etsdiffEvidence(
        {
          ia: subject.ia, productRef: subject.productRef, hardware2Program: subject.appRef, mask: cfg.mask, configuration: subject.configuration,
          compared: n, divergent: rs.reduce((k, r) => k + r.divergences.length, 0),
          etsOutside: rs.reduce((k, r) => k + r.etsOnly.length, 0) + diff.unattributed.length,
          busforgeOnly: rs.reduce((k, r) => k + r.busforgeOnly.length, 0),
          uncomparedSegments: idx.filter(gap).length,
          segments: idx.map((i) => `${diff.segments[i].id} ${segmentState(i)}`),
          // Exclusions cover ETS bytes outside every segment, so they belong to the capture, not to one operation.
          exclusions: diff.exclusions.map((e) => `${e.addresses.length} bytes${partial ? " of the capture" : ""}: ${e.rule}`),
          declaredUnwritten: partial ? undefined : declaredUnwritten.map((s) => `${s.id.split("_").pop()} (${s.size}B)`),
          operation,
        },
        run,
      )];
    });
    if (records.length === 0) throw new Error(`no ETS write to ${subject.ia} fell inside a segment a Busforge flash writes; nothing to record`);
    await Bun.write(evidencePath, JSON.stringify(records, null, 2) + "\n");
    console.log(`evidence: ${evidencePath} (${records.map((r) => `${r.scope.operation} ${r.results.reference.state}`).join(", ")})`);
  }
  const what = partial ? "ETS's partial download wrote matches Busforge's image for the same configuration" : "ETS wrote matches Busforge's full-download image";
  console.log(pass
    ? `PASS: every byte ${what}.`
    : `FAIL: Busforge's ${partial ? "image" : "full download"} disagrees with ETS or could not be compared completely (see docs/verification.md). A read-back cannot catch this.`);
  return pass ? 0 : 1;
}

function ranges(xs: number[], absolute = false): string {
  const out: string[] = [];
  const f = (n: number) => (absolute ? hex(n) : String(n));
  for (let i = 0; i < xs.length;) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? f(xs[i]) : `${f(xs[i])}-${f(xs[j])}`);
    i = j + 1;
  }
  return out.join(", ");
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (e) { console.error(`etsdiff: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
}
