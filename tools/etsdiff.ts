#!/usr/bin/env bun
// ETS byte-diff GATE: hold Busforge's built parameter image against what ETS actually wrote to a
// real device, byte for byte.
//
//   bun run tools/etsdiff.ts <project.knxproj> <ets-capture.log> [--device=<index>] [--base=<n>]
//
// WHY THIS EXISTS. Busforge's own flash CRC-verifies device == our-image. That proves the device
// faithfully holds what we sent; it can NEVER prove our-image == what ETS would have sent. For a
// union-heavy System B app (OpenKNX RaumController: 68k refs, almost all union members) the
// visibility/union resolver could in principle pick a different active set than ETS, or a codec
// could mis-size a value, and every green test plus the CRC-verify would stay green while the
// device booted on a wrong image. This tool closes exactly that gap: it is the our-image == ETS
// check the codebase never had.
//
// THE BASE. A System B RelativeSegment is written at the address the DEVICE assigns it during
// LdCtrlRelSegment allocation (Busforge's flash resolves it at run time via PID_TABLE_REFERENCE;
// see loadrunner writeSegment). ETS's A_MemoryExtended_Write addresses are therefore
// segment-base + offset, NOT the 0-based segment offset our image is indexed by. On the
// RaumController the device allocates the parameter segment at 0x54 (an 84-byte system block
// precedes it, then the com-object/association/address tables follow above the segment). This
// tool INFERS that base from the capture (the shift that aligns ETS's multi-byte writes onto our
// image) and diffs at it; pass --base to pin it. Comparing without the base was a real bug in an
// earlier version of this tool: it reported all 30 writes "divergent" when the image was in fact
// byte-identical, and that false signal was briefly written into the docs.
//
// THE CAPTURE. Run ETS through the Busforge bridge with the logging proxy (scratchpad/knxproxy.ts),
// do a full download, and keep its log. This tool reads that log, extracts every A_MemoryExtended_
// Write (APCI 0x1FB) ETS sent, and treats them as ground truth. The proxy line format consumed
// here is: `... ETS->BRIDGE ... TUNNELLING_REQ ... | <full-frame-hex>`.
//
// SCOPE. Diffs the LSM-4 parameter segment only. The group/association/com-object tables ETS
// writes into their own segments (above the parameter segment) are built by a different Busforge
// path (buildComObjectTable / buildGroupTables) and are reported here only as an address span. A
// live-read-back variant (diff against the real device rather than a capture, resolving the base
// from the device itself) is the durable form; see docs/roadmap.md.
import { loadKnxproj, readAppProgram, deviceParamValues } from "../packages/project/src/index.ts";
import { readZip } from "../packages/project/src/zip.ts";
import { parseAppConfig, resolveModuleInstances, buildRelativeSegmentTarget } from "../packages/product/src/index.ts";

const LSM_PARAM = 4;
const args = process.argv.slice(2);
const [projPath, capturePath] = args.filter((a) => !a.startsWith("--"));
const devIndex = Number((args.find((a) => a.startsWith("--device=")) ?? "--device=0").split("=")[1]);
const baseArg = args.find((a) => a.startsWith("--base="));
if (!projPath || !capturePath) {
  console.error("usage: bun run tools/etsdiff.ts <project.knxproj> <ets-capture.log> [--device=<index>] [--base=<n>]");
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

console.log(`device ${d.ia} "${d.name}"  app ${d.appRef}`);
console.log(`  config: ${[...values].map(([k, v]) => k.split("_").slice(-2).join("_") + "=" + v).join(", ") || "(defaults only)"}`);
console.log(`  busforge target: ${target.bytes.length}B, ${target.owned.filter(Boolean).length} owned bytes, hasModules=${(cfg as { hasModules?: boolean }).hasModules} instances=${instances.length}`);

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

// ---- infer the segment base (the device-assigned address the writes are relative to) ----
// A DISTINCTIVE run (several distinct non-zero bytes) occurs at essentially one place in our
// image, and addr - that offset is a candidate base. Zero-heavy runs are useless: they match
// everywhere in a mostly-zero image and would drown the vote (an earlier version inferred a
// bogus base from exactly that). So collect candidates only from distinctive runs, then pick the
// candidate that makes the MOST of ETS's writes match our image exactly. A pinned --base overrides.
const SEG = target.bytes.length;
const distinctive = (b: Buffer) => b.length >= 3 && new Set(b).size >= 3 && b.filter((x) => x !== 0).length >= 3;
let base: number;
if (baseArg) {
  base = Number(baseArg.split("=")[1]);
} else {
  const candidates = new Set<number>();
  for (const w of writes) {
    if (!distinctive(w.data)) continue;
    for (let i = target.bytes.indexOf(w.data); i >= 0; i = target.bytes.indexOf(w.data, i + 1))
      if (w.addr - i >= 0) candidates.add(w.addr - i);
  }
  const score = (b: number) => writes.filter((w) => {
    const off = w.addr - b;
    return off >= 0 && off + w.data.length <= SEG && target.bytes.subarray(off, off + w.data.length).equals(w.data);
  }).length;
  base = [...candidates].sort((a, b) => score(b) - score(a))[0] ?? 0;
}
const rel = writes.map((w) => ({ addr: w.addr - base, data: w.data }));
const paramWrites = rel.filter((w) => w.addr >= 0 && w.addr + w.data.length <= SEG);
const tableWrites = rel.filter((w) => w.addr < 0 || w.addr + w.data.length > SEG);
console.log(`  inferred segment base: 0x${base.toString(16)}${baseArg ? " (pinned)" : ""}`);
console.log(`  ETS capture: ${writes.length} extended writes → ${paramWrites.length} in the param segment, ${tableWrites.length} in other segments (tables, not diffed here)`);

// ---- per-write byte diff at the base ----
type Div = { addr: number; bf: string; ets: string };
const divs: Div[] = [];
for (const w of paramWrites) {
  const bf = target.bytes.subarray(w.addr, w.addr + w.data.length);
  if (!bf.equals(w.data)) divs.push({ addr: w.addr, bf: bf.toString("hex"), ets: w.data.toString("hex") });
}

console.log(`\n=== ${divs.length} of ${paramWrites.length} param-segment writes DIVERGE (busforge ≠ ETS) ===`);
for (const v of divs) console.log(`  @0x${(v.addr + base).toString(16).padStart(4, "0")} (seg 0x${v.addr.toString(16)})  busforge=${v.bf}  ets=${v.ets}`);
console.log(`\nsummary: ${divs.length} divergences / ${paramWrites.length} ETS param writes (base 0x${base.toString(16)}).`);
console.log(divs.length === 0
  ? "PASS — busforge's image matches ETS at every configured byte."
  : "FAIL — busforge's image disagrees with ETS (see docs/verification.md). CRC-verify cannot catch this.");
process.exit(divs.length === 0 ? 0 : 1);
