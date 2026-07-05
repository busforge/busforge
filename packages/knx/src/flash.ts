import { KnxDevice } from "./device.ts";

// The KNX load procedure (MV-07B0 / System B, property-mapped LSMs). Ported from
// the proven reference; see docs/findings.md for the wire details and gotchas.
//
// SAFETY: a download UNLOADS device segments before rewriting them. A failure
// between unload and load-completed leaves the device "unloaded" (still
// addressable, recoverable by re-flash). Always back up the segments first.

// LSM "load events" written to PID 5 (the value differs from the read-back STATE).
export const LSM = { LOAD: 1, LOAD_COMPLETED: 2, UNLOAD: 4 } as const;
// LSM states read back from PID 5.
export const STATE = { UNLOADED: 0, LOADED: 1, LOADING: 2, ERROR: 3 } as const;

const ev = (e: number) => { const b = Buffer.alloc(10); b[0] = e; return b; };
function allocPayload(size: number): Buffer {
  const b = Buffer.alloc(10);
  b[0] = 0x03; b[1] = 0x0b;          // AdditionalLoadControls: allocate relative segment
  b.writeUInt32BE(size >>> 0, 2);    // size, big-endian
  b[6] = 0; b[7] = 0;                // mode, fill
  return b;
}

export async function lsmEvent(dev: KnxDevice, obj: number, event: number) { await dev.propWrite(obj, 5, ev(event)); }
export async function lsmState(dev: KnxDevice, obj: number) { return (await dev.propRead(obj, 5))[0]; }
export async function allocSegment(dev: KnxDevice, obj: number, size: number) { await dev.propWrite(obj, 5, allocPayload(size)); }

// app-id stamp for PID 13: manufacturer(2) + applicationNumber(2) + version(1), big-endian
export function appId(manufacturer: number, appNumber: number, version: number): Buffer {
  return Buffer.from([(manufacturer >> 8) & 0xff, manufacturer & 0xff, (appNumber >> 8) & 0xff, appNumber & 0xff, version & 0xff]);
}

// Group-address ("grp") download: rewrites the com-object (3), association (2) and
// address (1) tables. Pass the exact table images to write.
export async function flashGroupTables(dev: KnxDevice, tables: { addr: Buffer; assoc: Buffer; comObj: Buffer }) {
  for (const o of [3, 2, 1]) await lsmEvent(dev, o, LSM.UNLOAD);
  await lsmEvent(dev, 3, LSM.LOAD); await allocSegment(dev, 3, tables.comObj.length);
  await lsmEvent(dev, 1, LSM.LOAD); await allocSegment(dev, 1, tables.addr.length);
  await lsmEvent(dev, 2, LSM.LOAD); await allocSegment(dev, 2, tables.assoc.length);
  await dev.memWrite(await dev.tableAddr(3), tables.comObj);
  await dev.memWrite(await dev.tableAddr(2), tables.assoc);
  await dev.memWrite(await dev.tableAddr(1), tables.addr);
  for (const o of [3, 2, 1]) await lsmEvent(dev, o, LSM.LOAD_COMPLETED);
  for (const o of [3, 2, 1]) if ((await lsmState(dev, o)) !== STATE.LOADED) throw new Error(`LSM ${o} not Loaded after flash`);
  await dev.restart();
}

// MV-0705 (System 7) group-address download: the address (LSM 1) and association (LSM 2)
// tables live at fixed absolute addresses, so unlike System B there is no relative-segment
// alloc. Mirrors the hardware-proven absolute PARAMETER path (planAbsoluteParFlash): per LSM,
// LOAD -> write the table at its fixed address (chunk-verified) -> LOAD_COMPLETED, then restart.
// The com-object table (object 3) is left untouched (a GA change does not alter it). The caller
// must already be connected (a second T_Connect resets the sequence counter; see the absolute
// param path) and should have backed up the current tables first.
export async function flashGroupTablesMv0705(dev: KnxDevice, tables: { addr: Buffer; assoc: Buffer }) {
  const writeTable = async (lsm: number, bytes: Buffer) => {
    await lsmEvent(dev, lsm, LSM.LOAD);
    if ((await lsmState(dev, lsm)) !== STATE.LOADING) throw new Error(`LSM ${lsm} not Loading after Load`);
    await dev.memWrite(await dev.tableAddr(lsm), bytes, { verify: true });
    await lsmEvent(dev, lsm, LSM.LOAD_COMPLETED);
    if ((await lsmState(dev, lsm)) !== STATE.LOADED) throw new Error(`LSM ${lsm} not Loaded after flash`);
  };
  await writeTable(1, tables.addr);  // address table
  await writeTable(2, tables.assoc); // association table
  await dev.restart();
}

// Parameter ("par") download: rewrites the application/parameter segment (LSM 4)
// and stamps the application id so load-completed validates.
export async function flashParameters(dev: KnxDevice, image: Buffer, id: Buffer, onProgress?: (done: number, total: number) => void) {
  await lsmEvent(dev, 4, LSM.UNLOAD);
  await lsmEvent(dev, 4, LSM.LOAD);
  await allocSegment(dev, 4, image.length);
  await dev.memWrite(await dev.tableAddr(4), image, { onProgress });
  await dev.propWrite(4, 13, id);
  await lsmEvent(dev, 4, LSM.LOAD_COMPLETED);
  if ((await lsmState(dev, 4)) !== STATE.LOADED) throw new Error("LSM 4 not Loaded after parameter flash");
  await dev.restart();
}

// MV-0705 (absolute-segment) parameter downloads are driven by the device's declared
// LoadProcedure: the planner (planAbsoluteParFlash) turns it into a LoadPlan and the
// generic executor (runLoadPlan, loadrunner.ts) runs it. See docs/load-procedures.md.

// LdCtrlCompareProp support: read a declared property and compare it against the
// procedure's expected value (the pre-download hardware/application check ETS runs).
// Trailing-zero padding in the expected value is tolerated: ETS pads InlineData to a
// fixed width while devices return the property's real element size.
export async function compareDeclaredProp(dev: KnxDevice, obj: number, pid: number, expect: Buffer): Promise<{ ok: boolean; got: Buffer }> {
  const got = await dev.propRead(obj, pid);
  const ok =
    got.equals(expect) ||
    (got.length < expect.length && got.equals(expect.subarray(0, got.length)) && expect.subarray(got.length).every((b) => b === 0));
  return { ok, got };
}
