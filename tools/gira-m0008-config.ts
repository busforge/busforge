// The configuration of the Gira Tastsensor 3 Komfort (M-0008_A-10D7-11-2783-O000A, MV-0705) that ETS downloads
// in the corpus's captures, read from what ETS wrote in its revert (captures/gira-m0008-ets-partial-revert.log):
// the links from its tables, the parameter values decoded by Busforge from its application image. The project is
// not in the corpus.
import { decodeAbsoluteImage, decodeGroupTablesMv0705, toAppModel, buildDeviceConfig, type AppConfig } from "../packages/product/src/index.ts";
import { captureText } from "./corpus.ts";
import { captureDevice, memoryImage, parseCapture } from "./etsdiff.ts";

const GIRA_M0008_REVERT = "gira-m0008-ets-partial-revert.log";

// `revert`: the bytes the revert wrote, by address.
export function giraM0008Configuration(cfg: AppConfig): { ia: number; revert: Map<number, number>; links: { comObjNum: number; gaRaws: number[] }[]; params: Map<string, string>; addr: Buffer; assoc: Buffer } {
  const ia = captureDevice(captureText(GIRA_M0008_REVERT));
  const revert = memoryImage(parseCapture(captureText(GIRA_M0008_REVERT), ia).writes);
  const at = (a: number) => revert.get(a)!;
  const count = at(0x4000);
  // ETS leaves the address table's own individual address (bytes 1-2) to the device.
  const addr = Buffer.from(Array.from({ length: 1 + 2 * count }, (_, i) => (i === 1 ? ia >> 8 : i === 2 ? ia & 0xff : at(0x4000 + i))));
  const assocAt = 0x4000 + addr.length;
  const assoc = Buffer.from(Array.from({ length: 1 + 2 * at(assocAt) }, (_, i) => at(assocAt + i)));
  const model = toAppModel(cfg, { includeUnions: true });
  const decoded = new Map<string, string>();
  for (const seg of cfg.absoluteSegments) {
    if (seg.data.length === 0) continue;
    const img = Buffer.from(seg.data);
    for (let i = 0; i < seg.size; i++) { const v = revert.get(seg.address + i); if (v !== undefined) img[i] = v; }
    for (const [r, v] of decodeAbsoluteImage(model, seg.id, img)) decoded.set(r, v);
  }
  // The function of each rocker has no memory location, so no image shows it; the project
  // sets both to "Dimmen" (2), whose objects 18 and 20 ETS links to the dimming addresses. On top of
  // them, the device's configuration as Busforge's read-back finds it (profiles.ts
  // deviceRelevantRefs): the decoded value of every parameter active under it, until the active set
  // settles.
  const project = new Map([["M-0008_A-10D7-11-2783-O000A_P-224_R-224", "2"], ["M-0008_A-10D7-11-2783-O000A_P-2194_R-2194", "2"]]);
  let params = new Map(project);
  for (let i = 0; ; i++) {
    const active = new Set(buildDeviceConfig(cfg, params).imageValues.keys());
    const next = new Map([...project, ...[...decoded].filter(([r]) => active.has(r))]);
    if (next.size === params.size && [...next].every(([r, v]) => params.get(r) === v)) break;
    if (i > 16) throw new Error("the configuration read from the revert never settled");
    params = next;
  }
  return { ia, revert, links: decodeGroupTablesMv0705(addr, assoc), params, addr, assoc };
}
