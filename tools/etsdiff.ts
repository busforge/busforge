#!/usr/bin/env bun
// ETS byte-diff GATE: hold Busforge's built parameter image against what ETS actually wrote to a
// real device, and attribute every divergence to the parameter responsible for it.
//
//   bun run tools/etsdiff.ts <project.knxproj> <ets-capture.log> [--device=<index>]
//
// WHY THIS EXISTS. Busforge's own flash CRC-verifies device == our-image. That proves the device
// faithfully holds what we sent; it can NEVER prove our-image == what ETS would have sent. For a
// union-heavy System B app (OpenKNX RaumController: 68k refs, tens of thousands of union members)
// the `<choose>`/`<when>`/Union visibility resolver in buildDeviceConfig can pick a different active
// set than ETS, so our image differs at every configured location while every green test and the
// CRC-verify stay green. The device then boots on a half-resolved config and dead-loops. This tool
// closes exactly that gap: it is the our-image == ETS check the codebase never had.
//
// THE CAPTURE. Run ETS through the Busforge bridge with the logging proxy (scratchpad/knxproxy.ts),
// do a full download, and keep its log. This tool reads that log, extracts every A_MemoryExtended_
// Write (APCI 0x1FB) ETS sent, and treats them as ground truth for the parameter segment. The proxy
// line format consumed here is: `... ETS->BRIDGE ... TUNNELLING_REQ ... | <full-frame-hex>`.
//
// SCOPE. Compares the LSM-4 parameter segment (base 0). The group/association/com-object tables ETS
// writes above the segment are built by a different Busforge path (buildComObjectTable / buildGroup
// Tables) and are reported here only as an address span, not diffed. A live-read-back variant (diff
// against the real device rather than a capture) is tracked in docs/next-steps.md.
import { loadKnxproj, readAppProgram, deviceParamValues } from "../packages/project/src/index.ts";
import { readZip } from "../packages/project/src/zip.ts";
import { parseAppConfig, resolveModuleInstances, buildDeviceConfig, buildRelativeSegmentTarget } from "../packages/product/src/index.ts";
import { toAppModel, byteWidth } from "../packages/product/src/index.ts";

const LSM_PARAM = 4;
const [projPath, capturePath] = process.argv.slice(2);
const devIndex = Number((process.argv.find((a) => a.startsWith("--device=")) ?? "--device=0").split("=")[1]);
if (!projPath || !capturePath) {
  console.error("usage: bun run tools/etsdiff.ts <project.knxproj> <ets-capture.log> [--device=<index>]");
  process.exit(2);
}

// ---- Busforge's intended image for the project's device ----
const bytes = Buffer.from(await Bun.file(projPath).arrayBuffer());
const proj = loadKnxproj(bytes, undefined, "project");
const zip = readZip(bytes);
const xml0 = new TextDecoder().decode(zip.get([...zip.keys()].find((k) => k.endsWith("0.xml"))!)!);
const d = proj.devices[devIndex];
if (!d) { console.error(`no device at index ${devIndex} (project has ${proj.devices.length})`); process.exit(2); }
const cfg = parseAppConfig(readAppProgram(bytes, d.appRef)!);
const { values } = deviceParamValues(xml0, d.id);
const instances = (cfg as { hasModules?: boolean }).hasModules ? resolveModuleInstances(cfg, values) : [];
const target = buildRelativeSegmentTarget(cfg, values, LSM_PARAM, { moduleInstances: instances });
if (!target) { console.error(`device ${d.ia}: no LSM-${LSM_PARAM} relative segment`); process.exit(2); }
const model = toAppModel(cfg, { includeUnions: true, instances });
const active = buildDeviceConfig(cfg, values, undefined, instances).imageValues;

console.log(`device ${d.ia} "${d.name}"  app ${d.appRef}`);
console.log(`  config: ${[...values].map(([k, v]) => k.split("_").slice(-2).join("_") + "=" + v).join(", ") || "(defaults only)"}`);
console.log(`  busforge target: ${target.bytes.length}B, ${target.owned.filter(Boolean).length} owned bytes, hasModules=${(cfg as { hasModules?: boolean }).hasModules} instances=${instances.length}`);

// offset -> the parameter refs whose field covers it (for attributing a divergence)
const refsAt = (off: number) => {
  const out: { ref: string; access: string; union: boolean; mi: boolean; activeVal: string | undefined; def: string | undefined }[] = [];
  for (const ref of model.refs.values()) {
    const p = model.params.get(ref.paramId);
    if (!p || p.offset === undefined) continue;
    if (p.codeSegment && model.segments.find((s) => s.id === p.codeSegment)?.lsm !== LSM_PARAM) continue;
    const t = model.types.get(p.typeId);
    const w = t && Number.isFinite(t.sizeInBit) ? byteWidth(t.sizeInBit, p.bitOffset) : 1;
    if (off >= p.offset && off < p.offset + w) {
      const cp = cfg.params.get(ref.paramId);
      out.push({ ref: ref.id, access: cp?.access ?? "?", union: cp?.union === true, mi: ref.id.includes("_MI-"), activeVal: active.get(ref.id), def: cp?.value });
    }
  }
  return out;
};

// ---- ETS's captured extended-memory writes ----
const text = await Bun.file(capturePath).text();
const writes: { addr: number; data: Buffer }[] = [];
for (const line of text.split("\n")) {
  if (!line.includes("ETS->BRIDGE") || !line.includes("TUNNELLING_REQ")) continue;
  const m = line.match(/\| ([0-9a-f]+)\s*$/);
  if (!m) continue;
  const tpdu = m[1].slice(20).slice(18); // strip KNXnet(6B) + conn-header(4B) = 20 hex, then L_Data head 9B = 18 hex
  if (tpdu.length < 12 || tpdu.slice(2, 4) !== "fb") continue; // octet1 == 0xfb => A_MemoryExtended_Write
  const nbytes = parseInt(tpdu.slice(4, 6), 16);
  const addr = parseInt(tpdu.slice(6, 12), 16);
  const data = Buffer.from(tpdu.slice(12, 12 + nbytes * 2), "hex");
  if (data.length === nbytes) writes.push({ addr, data });
}
if (writes.length === 0) { console.error(`no A_MemoryExtended_Write frames found in ${capturePath}; is it an ETS-through-the-bridge capture?`); process.exit(2); }

const SEG = target.bytes.length;
const paramWrites = writes.filter((w) => w.addr + w.data.length <= SEG);
const tableWrites = writes.filter((w) => w.addr >= SEG);
console.log(`  ETS capture: ${writes.length} extended writes → ${paramWrites.length} in the param segment, ${tableWrites.length} in the tables (0x${SEG.toString(16)}+, not diffed here)`);

// ---- per-byte diff, attributed to parameters ----
type Div = { addr: number; bf: string; ets: string; params: string[] };
const divs: Div[] = [];
for (const w of paramWrites) {
  const bf = target.bytes.subarray(w.addr, w.addr + w.data.length);
  if (bf.equals(w.data)) continue;
  // name the parameters overlapping this run and why Busforge left it (inactive union / value)
  const params = new Set<string>();
  for (let off = w.addr; off < w.addr + w.data.length; off++)
    for (const r of refsAt(off)) {
      const cat = r.mi ? "MI" : r.union ? "union" : "plain";
      const state = r.activeVal !== undefined ? `active=${r.activeVal}` : "INACTIVE";
      params.add(`${r.ref.split("_").slice(-2).join("_")}[${cat},${r.access},${state}${r.def !== undefined ? `,def=${r.def}` : ""}]`);
    }
  divs.push({ addr: w.addr, bf: bf.toString("hex"), ets: w.data.toString("hex"), params: [...params] });
}

console.log(`\n=== ${divs.length} of ${paramWrites.length} param-segment writes DIVERGE (busforge ≠ ETS) ===`);
for (const v of divs) {
  console.log(`  @0x${v.addr.toString(16).padStart(4, "0")}  busforge=${v.bf}  ets=${v.ets}`);
  for (const p of v.params.slice(0, 4)) console.log(`        ${p}`);
}
console.log(`\nsummary: ${divs.length} divergences / ${paramWrites.length} ETS param writes.`);
console.log(divs.length === 0
  ? "PASS — busforge's image matches ETS at every configured byte."
  : "FAIL — busforge's visibility/union resolver disagrees with ETS (see docs/next-steps.md). CRC-verify cannot catch this.");
process.exit(divs.length === 0 ? 0 : 1);
