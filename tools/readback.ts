#!/usr/bin/env bun
// Read-back tooling: dump a real KNX device's commissioned memory over the bus and
// compare it against what Busforge builds. Read-only and safe (no writes). Use it to
// develop and regression-test the flash paths against ground truth.
//
//   bun run tools/readback.ts <project.knxproj> <password> <interface-ip> <out-dir> [--mode=all|params|tables]
//        [--configured-by=ets|busforge|unknown] [--prior-busforge-writes=none|some|unknown] [--via=busforge-bridge|direct]
//
//   bun run tools/readback.ts ~/house.knxproj '<password>' 198.51.100.10 ./out
//   bun run tools/readback.ts ~/house.knxproj '' 198.51.100.10 ./out --mode=tables
//
// WARNING: the OUTPUT is real device memory (parameter images and group-address
// tables, i.e. your installation). Write it to a gitignored location and never
// commit it. The tool drops a DO-NOT-COMMIT marker in the output directory.
//
// Each parameter comparison is also written as an evidence record (evidence.json). Who wrote the
// devices decides what a match proves, and only the operator knows it: without --configured-by and
// --prior-busforge-writes the records claim neither transfer nor reference.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "../packages/project/src/zip.ts";
import { loadKnxproj, readAppProgram, deriveWinzipPassword, appProgramId, deviceParamValues } from "../packages/project/src/index.ts";
import { parseApplication, buildParameterImage } from "../packages/product/src/index.ts";
import { KnxIpTunnel, KnxDevice } from "../packages/knx/src/index.ts";
import type { EvidenceRecord, Firmware } from "../packages/product/src/index.ts";
import { readbackEvidence, readFirmwareRevision, gitRevision, sha256, transportOf, type DeclaredOrigin, type ImageComparison } from "./evidence.ts";

const [projPath, password, ip, outDir] = process.argv.slice(2);
const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=all").split("=")[1];
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const oneOf = <T extends string>(name: string, allowed: readonly T[]): T => {
  const v = flag(name) ?? "unknown";
  if (!allowed.includes(v as T)) { console.error(`--${name} must be one of ${allowed.join(", ")}`); process.exit(2); }
  return v as T;
};
const origin: DeclaredOrigin = {
  configuredBy: oneOf("configured-by", ["ets", "busforge", "unknown"] as const),
  priorBusforgeWrites: oneOf("prior-busforge-writes", ["none", "some", "unknown"] as const),
};
if (origin.configuredBy === "busforge" && origin.priorBusforgeWrites === "none") {
  console.error("--configured-by=busforge contradicts --prior-busforge-writes=none"); process.exit(2);
}
let transport: ReturnType<typeof transportOf>;
try { transport = transportOf("udp", flag("via")); } // KnxIpTunnel below is a UDP tunnel
catch { console.error("--via must be busforge-bridge or direct"); process.exit(2); }
const runnerRevision = gitRevision();
const PER_DEVICE_TIMEOUT_MS = 180_000;
const LSM_PARAM = 4;
if (!projPath || ip === undefined || !outDir) {
  console.error("usage: bun run tools/readback.ts <project.knxproj> <password> <interface-ip> <out-dir> [--mode=all|params|tables]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "DO_NOT_COMMIT_device_memory.txt"), "This directory holds real device memory (incl. group addresses). Keep it out of git.\n");

const bytes = Buffer.from(await Bun.file(projPath).arrayBuffer());
const proj = loadKnxproj(bytes, password || undefined, "project");
// Decrypt 0.xml once for the parameter value source (the proven image-build input).
const outer = readZip(bytes);
const innerName = [...outer.keys()].find((n) => /(^|\/)P-[^/]+\.zip$/.test(n));
const xml0 = innerName
  ? new TextDecoder().decode([...readZip(outer.get(innerName)!, password ? deriveWinzipPassword(password) : undefined)].find(([k]) => k.endsWith("0.xml"))![1])
  : new TextDecoder().decode(outer.get([...outer.keys()].find((k) => k.endsWith("0.xml"))!)!);

const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(`timeout ${PER_DEVICE_TIMEOUT_MS / 1000}s`)), PER_DEVICE_TIMEOUT_MS))]);

// Count-prefixed table read (matches the server's flash-path read): the first two
// bytes are the entry count; read exactly that many entries, no cap, no truncation.
async function readTablesFull(dev: KnxDevice) {
  const counted = async (obj: number, width: number) => {
    const base = await dev.tableAddr(obj);
    if (!base) return null;
    const h = await dev.memRead(base, 2);
    return dev.memRead(base, 2 + (((h[0] << 8) | h[1]) * width));
  };
  const addr = await counted(1, 2); // group-address table (2 bytes/entry)
  const gcount = addr ? (addr[0] << 8) | addr[1] : 0;
  // association table: long (4 bytes) unless an entry's group index is out of range.
  let assoc: Buffer | null = null, long = true;
  const a2 = await dev.tableAddr(2);
  if (a2) {
    const ah = await dev.memRead(a2, 2);
    const acount = (ah[0] << 8) | ah[1];
    assoc = await dev.memRead(a2, 2 + acount * 4);
    for (let k = 0; k < acount; k++) { const gi = (assoc[2 + k * 4] << 8) | assoc[3 + k * 4]; if (gi < 1 || gi > gcount) { long = false; break; } }
    if (!long) assoc = await dev.memRead(a2, 2 + acount * 2);
  }
  const comObj = await counted(3, 2); // com-object table
  const hex = (b: Buffer | null) => (b ? b.toString("hex") : null);
  return { addrTable: hex(addr), assocTable: hex(assoc), assocLong: long, comObjTable: hex(comObj) };
}

const tun = new KnxIpTunnel(ip);
await tun.connect();
console.log(`tunnel ${ip} up; ${proj.devices.length} devices, mode=${mode}`);
const params: any[] = [], tables: any[] = [];
const evidence: EvidenceRecord[] = [];

for (const d of proj.devices) {
  const app = appProgramId(d.appRef);
  const dev = new KnxDevice(tun, d.ia);
  try {
    await withTimeout((async () => {
      await dev.connect();
      const mask = await dev.deviceDescriptor();
      let comparison: (Omit<ImageComparison, "firmware"> & { artifact: string; sha256: string }) | null = null;
      if (mask === "MV-FFFF") { console.log(`${d.ia} ${mask} SECURE (skipped)`); return; }

      if (mode === "params" || mode === "all") {
        const xml = readAppProgram(bytes, d.appRef);
        const model = xml ? parseApplication(xml) : null;
        if (model && model.segments.some((s) => s.lsm === LSM_PARAM)) {
          const { values } = deviceParamValues(xml0, d.id);
          const built = buildParameterImage(model, LSM_PARAM, values);
          const onDevice = await dev.memRead(await dev.tableAddr(LSM_PARAM), built.length, 12);
          const slug = `${d.ia}__${app}`;
          writeFileSync(join(outDir, `${slug}.built.bin`), built);
          writeFileSync(join(outDir, `${slug}.device.bin`), onDevice);
          let diff = 0; for (let i = 0; i < Math.min(built.length, onDevice.length); i++) if (built[i] !== onDevice[i]) diff++;
          comparison = { ia: d.ia, productRef: d.productRef, hardware2Program: d.appRef, mask, match: built.equals(onDevice), diffBytes: diff, length: built.length, artifact: join(outDir, `${slug}.device.bin`), sha256: sha256(onDevice) };
          const unmapped = [...values.keys()].filter((k) => !model.refs.has(k)).length;
          params.push({ ia: d.ia, app, len: built.length, deviceLen: onDevice.length, match: built.equals(onDevice), diffBytes: diff, unmappedRefs: unmapped });
          console.log(`${d.ia} ${mask} param ${built.equals(onDevice) ? "BYTE-MATCH" : `diff ${diff}/${built.length}`}${unmapped ? ` (module +${unmapped})` : ""}`);
        }
      }
      if (mode === "tables" || mode === "all") {
        const t = await readTablesFull(dev);
        tables.push({ ia: d.ia, app, mask, ...t });
        console.log(`${d.ia} ${mask} tables L1/L2/L3 read (full)`);
      }
      // Last on the link: a property the device does not answer times out without advancing the
      // transport sequence, and nothing may follow it on the same connection.
      if (comparison) {
        const { artifact, sha256: hash, ...c } = comparison;
        const firmware = await readFirmwareRevision(dev).catch((e): Firmware => { console.log(`${d.ia} firmware revision not read: ${(e as Error).message}`); return { state: "unknown" }; });
        evidence.push(readbackEvidence({ ...c, firmware }, origin, { recordedAt: new Date().toISOString(), runnerRevision, transport, artifact, sha256: hash }));
      }
    })());
  } catch (e) {
    const err = (e as Error).message;
    if (mode !== "tables") params.push({ ia: d.ia, app, error: err });
    if (mode !== "params") tables.push({ ia: d.ia, app, error: err });
    console.log(`${d.ia} ERROR ${err}`);
  } finally { try { await dev.disconnect(); } catch { /* teardown: the device link may already be gone */ } }
}
await tun.disconnect();

if (params.length) writeFileSync(join(outDir, "params.json"), JSON.stringify(params, null, 2));
if (evidence.length) writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
if (tables.length) writeFileSync(join(outDir, "tables.json"), JSON.stringify({ note: "full count-based read, not truncated", capturedAt: new Date().toISOString().slice(0, 10), devices: tables }, null, 2));
console.log(`done. params: ${params.length}, tables: ${tables.length}. output in ${outDir} (do not commit).`);
process.exit(0);
