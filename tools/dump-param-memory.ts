#!/usr/bin/env bun
// Dump every reachable device's parameter memory from the bus into a gitignored
// ground-truth corpus, so the image build can be byte-verified against real
// hardware (not just the self-referential golden snapshot). Read-only, no writes.
//
//   bun run tools/dump-param-memory.ts <interface-ip> [out-dir]
//
// DB-sourced (no .knxproj password needed). For each device it locates the
// parameter segments two ways and reads them at their real address:
//   - RelativeSegment (LSM4): address from the device allocator (tableAddr(4)).
//   - AbsoluteSegment: fixed Address from the app XML (the MV-0705 model).
// Output: one <ia>__<seg>.device.bin per segment + manifest.json. The directory
// holds real device memory (incl. nothing personal here, but treat as private)
// and lives under apps/server/data/ which is gitignored.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig, toAppModel } from "../packages/product/src/index.ts";
import { appProgramId } from "../packages/project/src/index.ts";
import { KnxIpTunnel, KnxDevice } from "../packages/knx/src/index.ts";

const ip = process.argv[2];
const outDir = process.argv[3] ?? "apps/server/data/readback/parammem";
if (!ip) { console.error("usage: bun run tools/dump-param-memory.ts <interface-ip> [out-dir]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const PER_DEVICE_TIMEOUT_MS = 120_000;
const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(`timeout ${PER_DEVICE_TIMEOUT_MS / 1000}s`)), PER_DEVICE_TIMEOUT_MS))]);

const db = new Database("apps/server/data/busforge.db", { readonly: true });
const projectId = (db.query("SELECT id FROM projects LIMIT 1").get() as any).id;
const devices = db.query("SELECT ia, app_ref FROM devices WHERE project_id=? ORDER BY ia").all(projectId) as any[];

const tun = new KnxIpTunnel(ip);
await tun.connect();
console.log(`tunnel ${ip} up; ${devices.length} devices`);
const manifest: any[] = [];

for (const d of devices) {
  const appId = appProgramId(d.app_ref);
  const row = db.query("SELECT xml FROM app_programs WHERE id=?").get(appId) as any;
  if (!row) { console.log(`${d.ia} no app xml (${appId})`); continue; }
  const app = parseAppConfig(row.xml);
  const model = toAppModel(app);
  const dev = new KnxDevice(tun, d.ia);
  try {
    await withTimeout((async () => {
      await dev.connect();
      const mask = await dev.deviceDescriptor();
      if (mask === "MV-FFFF") { console.log(`${d.ia} ${mask} SECURE (skip)`); manifest.push({ ia: d.ia, app: appId, mask, skipped: "secure" }); return; }

      // Param segments: which segments do <Memory> params target?
      const targeted = new Set<string>();
      for (const p of model.params.values()) if (p.codeSegment) targeted.add(p.codeSegment);

      const segDumps: any[] = [];
      // Absolute-segment devices (MV-0705): read each targeted segment at its fixed address.
      const abs = app.absoluteSegments.filter((s) => targeted.has(s.id) && s.size > 0);
      for (const s of abs) {
        const bytes = await dev.memRead(s.address, s.size, 12);
        const slug = `${d.ia}__${s.id.split("_").pop()}`;
        writeFileSync(join(outDir, `${slug}.device.bin`), bytes);
        segDumps.push({ kind: "absolute", segId: s.id, address: s.address, size: s.size, file: `${slug}.device.bin` });
      }
      // Relative-segment devices (LSM4): allocator address, size from the segment.
      const rel = model.segments.filter((s) => s.lsm === 4 && s.size > 0);
      if (rel.length) {
        const base = await dev.tableAddr(4);
        for (const s of rel) {
          const bytes = await dev.memRead(base, s.size, 12);
          const slug = `${d.ia}__LSM4`;
          writeFileSync(join(outDir, `${slug}.device.bin`), bytes);
          segDumps.push({ kind: "relative", segId: s.id, address: base, size: s.size, file: `${slug}.device.bin` });
        }
      }
      manifest.push({ ia: d.ia, app: appId, mask, segments: segDumps });
      console.log(`${d.ia} ${mask} ${appId}  ${segDumps.length} segment(s) [${segDumps.map((s) => `${s.kind}@${s.address}:${s.size}`).join(" ")}]`);
    })());
  } catch (e) {
    const err = (e as Error).message;
    console.log(`${d.ia} ERROR ${err}`);
    manifest.push({ ia: d.ia, app: appId, error: err });
  } finally { try { await dev.disconnect(); } catch {} }
}
await tun.disconnect();
writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ note: "real device parameter memory; ground truth for image-build byte-verification", interface: ip, devices: manifest }, null, 2));
const ok = manifest.filter((m) => m.segments?.length).length;
console.log(`\ndone. ${ok}/${devices.length} devices dumped. output in ${outDir} (gitignored).`);
process.exit(0);
