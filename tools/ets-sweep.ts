#!/usr/bin/env bun
// A sweep row: ETS's download of one application at one configuration into a simulated unit
// (tools/sim-unit.ts, captured by tools/knxproxy.ts) against Busforge's download of the same configuration
// into a fresh simulated unit of the same product, judged by the final state both leave.
//
//   BUSFORGE_CORPUS=... bun run tools/ets-sweep.ts [<application>/<variant>]... [--keep=<dir>]
//
// runs every named row (all rows without one), prints each verdict and writes the corpus's manifest
// (MANIFEST). --keep keeps Busforge's capture and the simulator's lines of each row under <dir>.
//
// A ROW lives in the corpus under captures/ets-sweep/<application id>/<variant>/ (ROW_FILES):
//   row.json            what the row is (RowSpec): the simulated unit, ETS's build, the simulator's endpoint
//                       ETS was set to, ETS's project export where the row has one, the capture of ETS's
//                       download of the configuration into the real unit where the row is calibrated by it
//   configuration.json  the device's configuration ETS downloaded (RowConfiguration), which Busforge downloads
//   ets.log             ETS's download into the simulator, as tools/knxproxy.ts logs it
//   ets.log.sim.txt     the simulator's lines of that run, every refusal among them
//   ets6.log.txt        ETS6.log of the run
//   explained.json      the verdict the row has today and every difference with its cause, and where the row
//                       is calibrated, every position its ETS capture differs from the real unit's (Explained)
//
// WHAT IS COMPARED (runState, compareRuns). Each run's requests as the unit took them (a transport-layer
// repetition once; a frame the line confirmed negatively or a numbered one outside a connection not at all)
// and the unit's answers: every segment octet either side wrote or an allocation with fill set, a later one
// winning (a byte only one side set is a difference, and so is one both set by different memory services);
// every property write by object and PID, with its elements, in order; each load-state machine's load
// controls (events and allocation records) in order; every function-property command; the load state and
// table reference the unit last reported for each machine; the restart form; every other service that is
// no read, in order. Reads and the requests the unit did not take are recorded, not compared.
//
// VERDICTS (judge), exactly one per row: identical; differs (the differences, the first first, each with its
// cause once explained); refused (Busforge's coded refusal, a ProductError or ApiError, where ETS downloads); busforge-only (Busforge
// writes where ETS failed or the simulator refused ETS); sim-refused (the simulator refused a request of
// either run); ets-failed; driver-failed (ETS6.log shows no download into the simulator alone).
//
// BESIDE THE VERDICT, where the row has ETS's project export: Busforge's images against ETS's record of the
// download in it (LoadedImage, tools/ets-records.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { gunzipSync } from "node:zlib";
import { APCI, KnxIpServer, MM_CTRL_ADDR, MM_STATUS_BASE, PID, iaToNum } from "../packages/knx/src/index.ts";
import { appProgramId, etsLoadedCompletely, etsNotDownloaded, loadKnxproj, type Project } from "../packages/project/src/index.ts";
import { isMemoryMappedLsm, parseAppConfig, parseLoadProcedures, ProductError, type ComObjectLink, type ComObjInstanceOverride, type FlashResult, type ModuleInstance } from "../packages/product/src/index.ts";
import { downloadDeviceFull } from "../apps/server/src/deviceprofile.ts";
import type { Connection } from "../apps/server/src/db/connections.ts";
import { ApiError } from "../apps/server/src/errors.ts";
import { apciName } from "./capture-index.ts";
import { catalogueXml, corpusPath, corpusUnlistedPath } from "./corpus.ts";
import { openWithPasswords, passwords, PASSWORDS_ENV } from "./corpus-archives.ts";
import { captureLData, capturedOnLoadedUnit, dialogueDifferences, memWriteOf, parseCapture } from "./etsdiff.ts";
import { loadedImageComparison } from "./ets-records.ts";
import { gitRevision } from "./evidence.ts";
import { startProxy } from "./knxproxy.ts";
import type { SimUnit } from "./sim-unit.ts";
import { newSimUnit, simUnitSpec, type SimUnitSpec } from "./sim-units.ts";
import { removeTempDir, tempDir } from "./test-temp.ts";

export const SWEEP_DIR = "captures/ets-sweep";
export const MANIFEST = "internal/ets-sweep/manifest.json";
export const ROW_FORMAT = "busforge-ets-sweep-row/1";
export const MANIFEST_FORMAT = "busforge-ets-sweep-manifest/1";
export const ROW_FILES = {
  row: "row.json", configuration: "configuration.json", ets: "ets.log", etsSim: "ets.log.sim.txt", ets6log: "ets6.log.txt", explained: "explained.json",
} as const;

export interface RowSpec {
  format: typeof ROW_FORMAT;
  // The simulated unit (tools/sim-units.ts) both runs download into; its application is the row's.
  unit: string;
  // ETS's version and build, as its about box and ETS6.log name it.
  etsBuild: string;
  // The interface ETS was set to: the simulator's proxy, "<host>:<port>".
  simulator: string;
  // ETS's project export after the download, a file of the row (gzipped or not); a project's password stays on
  // its export, which then opens with one of KNXPROJ_PASSWORDS.
  export?: string;
  // The calibration: ETS's capture of the same configuration downloaded into the real unit, relative to the
  // corpus root. ETS's dialogue with the simulator is held to it position by position (tools/etsdiff.ts
  // dialogueDifferences), every position that differs explained in explained.json's `calibration`.
  calibration?: string;
  // Where in the calibration capture's dialogue the download this row's ETS run repeats begins: the frames before it
  // are ETS's steps the row does not run (an address assignment before the application download).
  calibrationFrom?: number;
  // The application id the export gives the device where it is another build of the unit's (same manufacturer,
  // number and version) that parses as the unit's: configuration.json names the unit's parameter and module ids,
  // its appRef the export's build (tools/ets-driver.ts).
  exportApplication?: string;
}

export interface RowConfiguration {
  ia: string;
  // The Hardware2Program id of the device in ETS's project, where known: it must name the row's application.
  appRef?: string;
  params: [string, string][];
  links: ComObjectLink[];
  moduleInstances?: ModuleInstance[];
  comObjectOverrides?: [number, ComObjInstanceOverride][];
}

export type Verdict =
  | { verdict: "identical" }
  | { verdict: "differs"; differences: string[] }
  | { verdict: "refused"; code: string; message: string }
  // Busforge wrote where ETS did not download; `busforgeRefused` where it then refused.
  | { verdict: "busforge-only"; ets: string; busforgeWrites: number; busforgeRefused?: string }
  // Where ETS's run failed, `busforge` says how Busforge's ended.
  | { verdict: "sim-refused"; run: "ETS" | "Busforge"; refusals: string[]; busforge?: string }
  | { verdict: "ets-failed"; why: string; busforge?: string }
  | { verdict: "driver-failed"; why: string };

// What a row's explained.json holds: the verdict the row has today and the cause of every difference.
export interface Explained {
  verdict: Verdict["verdict"];
  differences: { difference: string; cause: string }[];
  // Where row.json names a calibration: each position ETS's dialogue with the simulator differs from its
  // dialogue with the real unit, with its cause.
  calibration?: { difference: string; cause: string }[];
}

// ---- one run's final state ----

// The memory-mapped load-state machines of MV-0700/0701 (docs/load-procedures.md): the load control is a
// memory write to MM_CTRL_ADDR with the machine in the high nibble of its first octet, the state the byte at
// MM_STATUS_BASE + the machine.
const MM_LSMS = [1, 2, 3, 4];
const L_DATA_REQ = 0x11, L_DATA_CON = 0x2e, L_DATA_IND = 0x29;
// A function-property command (A_FunctionPropertyCommand, its extended form); its state reads are reads.
const FUNCTION_PROPERTY_SERVICES = new Set([0x2c7, APCI.FUNCTION_PROPERTY_EXT_COMMAND]);
// The requests that leave the unit as it was: reads, and the authorization that opens the session.
const READ_SERVICES = new Set([
  APCI.MEMORY_EXT_READ, APCI.PROPERTY_READ, APCI.PROPERTY_DESCRIPTION_READ, APCI.PROPERTY_EXT_READ, APCI.AUTHORIZE_REQUEST,
  0x2c8, // A_FunctionPropertyState_Read
  APCI.FUNCTION_PROPERTY_EXT_STATE_READ, // A_FunctionPropertyExtState_Read
  0x1d2, // A_PropertyExtDescription_Read
  0x2c0, // A_UserMemory_Read
  0x2c5, // A_UserManufacturerInfo_Read
]);
const READ_GROUPS = new Set([APCI.MEMORY_READ, APCI.DEVICE_DESCRIPTOR_READ, 0x180 /* A_ADC_Read */]);
// Whether a request's APCI is a read, a service of a read group by its high bits; a one-octet TPDU a T_Disconnect.
const isRead = (raw: number) => READ_SERVICES.has(raw) || READ_GROUPS.has(raw & 0x3c0);
const isDisconnect = (t: Buffer) => t.length === 1 && (t[0] & 0xc3) === 0x81;

export interface RunState {
  // Every octet the run left in the unit's segments: its writes, a later one winning, and the fill of an
  // allocation with fill where it came after them.
  memory: Map<number, number>;
  // address -> the service that set it last (A_Memory_Write, A_UserMemory_Write, A_MemoryExtended_Write, the
  // allocation's fill).
  memoryService: Map<number, string>;
  // "<object>/<PID>" -> its writes in order, each "<count>@<start> <value>".
  properties: Map<string, string[]>;
  // load-state machine -> its load controls, in order.
  loadControls: Map<number, string[]>;
  functionCalls: string[];
  loadStates: Map<number, number>;
  tableReferences: Map<number, string>;
  restarts: string[];
  other: string[];
  reads: Set<string>;
  // Requests the unit did not take: negatively confirmed on the line, or numbered outside a connection
  // (the unit drops them or answers T_Disconnect). Recorded, not compared.
  notTaken: string[];
  // Allocations with fill the run shows no table reference for: their segment's octets are not known, so
  // the run's final state cannot be compared (compareRuns refuses it). A run the simulator refused may hold one.
  unplaced: string[];
  // The requests that change the unit: every one but the reads.
  writes: number;
  // How many of them the unit took after its last restart (the restart not counted); null without a restart.
  changesAfterRestart: number | null;
}

const hexOf = (b: Buffer) => b.toString("hex");

// A capture's frames between `tool` and the unit at `device`, as tools/knxproxy.ts logs them.
export function runState(text: string, tool: string, device: number, mask: string): RunState {
  const s: RunState = { memory: new Map(), memoryService: new Map(), properties: new Map(), loadControls: new Map(), functionCalls: [], loadStates: new Map(), tableReferences: new Map(), restarts: [], other: [], reads: new Set(), notTaken: [], unplaced: [], writes: 0, changesAfterRestart: null };
  const memoryMapped = isMemoryMappedLsm(mask);
  const r: Replay = { s, memoryMapped, order: new Map(), fills: [], mmStates: new Map(), n: 0 };
  // Each request with its confirmation on the line, and the unit's frames, in order.
  type Item = { request: true; t: Buffer; neg: boolean } | { request: false; t: Buffer };
  const items: Item[] = [], pending: { t: Buffer; neg: boolean }[] = [];
  for (const fr of captureLData(text, tool)) {
    if (fr.group) continue;
    if (fr.fromTool && fr.code === L_DATA_REQ && fr.dst === device) { const it: Item = { request: true, t: fr.tpdu, neg: false }; items.push(it); pending.push(it); }
    else if (!fr.fromTool && fr.code === L_DATA_CON && fr.dst === device) {
      // The confirmation repeats the request's frame: it confirms the oldest request still waiting with it.
      const i = pending.findIndex((p) => p.t.equals(fr.tpdu));
      if (i >= 0) pending.splice(i, 1)[0].neg = fr.line.includes("CON-NEG");
    }
    else if (!fr.fromTool && fr.code === L_DATA_IND && fr.src === device) items.push({ request: false, t: fr.tpdu });
  }
  // The transport connection as the unit keeps it (KNX 3/3/4): a T_Connect while connected is taken as
  // nothing, so only a new connection, after a disconnect or a restart, starts the sequence numbers again.
  let connected = false, lastSeq: number | null = null;
  for (const it of items) {
    const t = it.t, tpci = t[0];
    if (!it.request) {
      if (isDisconnect(t)) connected = false;
      else if (t.length >= 2) answer(r, t);
      continue;
    }
    const restart = isRestart(t);
    // A frame the line did not confirm did not reach the unit, but for a restart: a unit that restarts at
    // once acknowledges it on no layer (tools/sim-units.ts) and the tool sees it confirmed negatively.
    if (it.neg && !restart) { s.notTaken.push(`not confirmed: ${hexOf(t)}`); continue; }
    if (t.length === 1) {
      if ((tpci & 0xc3) === 0x80 && !connected) { connected = true; lastSeq = null; }
      if (isDisconnect(t)) connected = false;
      continue;
    }
    if ((tpci & 0xc0) === 0x40) {
      if (!connected) { s.notTaken.push(`outside a connection: ${hexOf(t)}`); continue; }
      const seq = (tpci >> 2) & 0x0f;
      // The unit acknowledges a repetition again and does not execute it.
      if (seq === lastSeq) continue;
      lastSeq = seq;
    }
    request(r, t);
    if (restart) connected = false;
  }
  // An allocation with fill sets its whole segment, where the unit reported it, over every earlier write.
  for (const f of r.fills) {
    const ref = s.tableReferences.get(f.lsm);
    if (ref === undefined) { s.unplaced.push(`object ${f.lsm} allocated with fill ${f.fill.toString(16).padStart(2, "0")}, at no table reference the run shows`); continue; }
    const at = parseInt(ref, 16);
    for (let a = at; a < at + f.size; a++) if ((r.order.get(a) ?? -1) < f.n) { s.memory.set(a, f.fill); s.memoryService.set(a, "allocation fill"); r.order.set(a, f.n); }
  }
  // A memory-mapped machine's state, for the machines the run controlled.
  for (const [lsm, state] of r.mmStates) if (MM_LSMS.includes(lsm) || s.loadControls.has(lsm)) s.loadStates.set(lsm, state);
  return s;
}

const isRestart = (t: Buffer) => t.length >= 2 && (((t[0] & 0x03) << 8 | t[1]) & 0x3c0) === APCI.RESTART;

interface Replay {
  s: RunState;
  memoryMapped: boolean;
  // address -> the number of the request that last set it.
  order: Map<number, number>;
  // The allocations with fill (load control 03 0B <size:4> 01 <fill>), numbered in the run.
  fills: { lsm: number; size: number; fill: number; n: number }[];
  // A memory-mapped machine (up to 15) -> the state byte the unit last answered for it.
  mmStates: Map<number, number>;
  n: number;
}

const push = <K>(m: Map<K, string[]>, k: K, v: string) => { (m.get(k) ?? m.set(k, []).get(k)!).push(v); };

function request(r: Replay, t: Buffer): void {
  const { s, memoryMapped } = r;
  const n = r.n++;
  const raw = ((t[0] & 0x03) << 8) | t[1];
  const data = t.subarray(2);
  if (READ_SERVICES.has(raw)) { s.reads.add(`${apciName(raw)} ${hexOf(data)}`); return; }
  // The services of a group carry a count or a type in the APCI's low six bits.
  if (READ_GROUPS.has(raw & 0x3c0)) { s.reads.add(`${apciName(raw)} ${hexOf(Buffer.concat([Buffer.from([raw & 0x3f]), data]))}`); return; }
  s.writes++;
  if (isRestart(t)) s.changesAfterRestart = 0;
  else if (s.changesAfterRestart !== null) s.changesAfterRestart++;
  const mem = memWriteOf(t, raw);
  if (mem && memoryMapped && mem.addr === MM_CTRL_ADDR) { push(s.loadControls, mem.data[0] >> 4, hexOf(mem.data)); return; }
  if (mem) { mem.data.forEach((b, i) => { s.memory.set(mem.addr + i, b); s.memoryService.set(mem.addr + i, mem.service); r.order.set(mem.addr + i, n); }); return; }
  if (raw === APCI.PROPERTY_WRITE && t.length >= 6) {
    const [obj, pid] = [t[2], t[3]];
    const value = t.subarray(6);
    if (pid !== PID.LOAD_STATE_CONTROL) { push(s.properties, `${obj}/${pid}`, `${t[4] >> 4}@${((t[4] & 0x0f) << 8) | t[5]} ${hexOf(value)}`); return; }
    push(s.loadControls, obj, hexOf(value));
    if (value.length >= 8 && value[0] === 0x03 && value[1] === 0x0b && value[6] === 1) r.fills.push({ lsm: obj, size: value.readUInt32BE(2), fill: value[7], n });
    return;
  }
  if (FUNCTION_PROPERTY_SERVICES.has(raw)) { s.functionCalls.push(`${apciName(raw)} ${hexOf(data)}`); return; }
  if ((raw & 0x3c0) === APCI.RESTART) { s.restarts.push(hexOf(Buffer.concat([Buffer.from([raw >> 8, raw & 0xff]), data]))); return; }
  s.other.push(`${apciName(raw)} ${hexOf(data)}`);
}

function answer(r: Replay, t: Buffer): void {
  const { s } = r;
  const raw = ((t[0] & 0x03) << 8) | t[1];
  if (raw === APCI.PROPERTY_RESPONSE && t.length >= 7 && t[4] >> 4 > 0) {
    if (t[3] === PID.LOAD_STATE_CONTROL) s.loadStates.set(t[2], t[6]);
    if (t[3] === PID.TABLE_REFERENCE) s.tableReferences.set(t[2], hexOf(t.subarray(6)));
    return;
  }
  if (r.memoryMapped && (raw & 0x3c0) === APCI.MEMORY_RESPONSE && t.length >= 4) {
    const at = t.readUInt16BE(2), bytes = t.subarray(4, 4 + (raw & 0x3f));
    for (let lsm = 1; lsm <= 15; lsm++) { const i = MM_STATUS_BASE + lsm - at; if (i >= 0 && i < bytes.length) r.mmStates.set(lsm, bytes[i]); }
  }
}

// ---- the comparison ----

// Octets as hex; long ones cut to their first 16, with their count and a digest of all of them, so the text
// still tells every two runs apart.
function octets(hex: string): string {
  return hex.length <= 32 ? hex : `${hex.slice(0, 32)}... (${hex.length / 2} octets, sha256 ${createHash("sha256").update(hex).digest("hex").slice(0, 16)})`;
}
const list = (xs: string[] | undefined) => xs === undefined || xs.length === 0 ? "none" : xs.map(octets).join(", ");

// Every difference of Busforge's run from ETS's, the first first: memory, property writes, load controls,
// function-property commands, load states and table references at the end, the restart, other services.
export function compareRuns(ets: RunState, busforge: RunState): string[] {
  for (const [who, st] of [["ETS", ets], ["Busforge", busforge]] as const) {
    if (st.unplaced.length) throw new Error(`${who}'s run cannot be compared: ${st.unplaced.join("; ")}`);
  }
  const out: string[] = [];
  const at = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;
  const addrs = [...new Set([...ets.memory.keys(), ...busforge.memory.keys()])].sort((a, b) => a - b);
  // Each run of consecutive addresses where `get` differs, as one difference.
  const runs = <V>(what: string, get: (st: RunState, a: number) => V | undefined, text: (vs: (V | undefined)[]) => string) => {
    for (let i = 0; i < addrs.length;) {
      const differ = (a: number) => get(ets, a) !== get(busforge, a);
      if (!differ(addrs[i])) { i++; continue; }
      let j = i;
      while (j + 1 < addrs.length && addrs[j + 1] === addrs[j] + 1 && differ(addrs[j + 1])) j++;
      const span = addrs.slice(i, j + 1);
      out.push(`${what} ${at(addrs[i])}${j > i ? `-${at(addrs[j])}` : ""}: ETS ${text(span.map((a) => get(ets, a)))}, Busforge ${text(span.map((a) => get(busforge, a)))}`);
      i = j + 1;
    }
  };
  runs("memory", (st, a) => st.memory.get(a), (vs) => octets(vs.map((v) => v?.toString(16).padStart(2, "0") ?? "--").join("")));
  // Where both set an octet, they set it by the same service.
  runs("memory service", (st, a) => (ets.memory.has(a) && busforge.memory.has(a) ? st.memoryService.get(a) : undefined), (vs) => [...new Set(vs)].join(", "));
  const keyed = <K>(what: string, a: Map<K, string[]>, b: Map<K, string[]>, order: (x: K, y: K) => number) => {
    for (const k of [...new Set([...a.keys(), ...b.keys()])].sort(order)) {
      if (JSON.stringify(a.get(k) ?? []) !== JSON.stringify(b.get(k) ?? [])) out.push(`${what} ${String(k)}: ETS ${list(a.get(k))}, Busforge ${list(b.get(k))}`);
    }
  };
  keyed("property write", ets.properties, busforge.properties, (x, y) => x.localeCompare(y, "en", { numeric: true }));
  keyed("load controls of object", ets.loadControls, busforge.loadControls, (x, y) => x - y);
  if (JSON.stringify(ets.functionCalls) !== JSON.stringify(busforge.functionCalls)) out.push(`function-property calls: ETS ${list(ets.functionCalls)}, Busforge ${list(busforge.functionCalls)}`);
  // A state the unit reported to one run only is that run's read, not compared: the load controls both runs sent
  // are, above. (A memory-mapped machine reports its state only to a run that reads it.)
  for (const [what, a, b] of [["load state", ets.loadStates, busforge.loadStates], ["table reference", ets.tableReferences, busforge.tableReferences]] as const) {
    for (const k of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)) {
      if (a.has(k) && b.has(k) && a.get(k) !== b.get(k)) out.push(`${what} of object ${k} at the end: ETS ${String(a.get(k))}, Busforge ${String(b.get(k))}`);
    }
  }
  if (JSON.stringify(ets.restarts) !== JSON.stringify(busforge.restarts)) out.push(`restart: ETS ${list(ets.restarts)}, Busforge ${list(busforge.restarts)}`);
  if (JSON.stringify(ets.other) !== JSON.stringify(busforge.other)) out.push(`other services: ETS ${list(ets.other)}, Busforge ${list(busforge.other)}`);
  return out;
}

// ---- ETS's side: did ETS download into the simulator, and only into it ----

// ETS6.log's line for a load task that failed: its LoadDeviceTask logs the exception that ended it
// ("WARN  Knx.Ets.Hawk.LoadDeviceTask - Knx.Ets.Hawk.DeviceManagementException: ..."). Its other warnings, such
// as "Differential Image Stamp does not match, falling back to partial download", are followed by the task's end.
export const ETS_TASK_FAILED = /\s(?:WARN|ERROR)\s+Knx\.Ets\.Hawk\.LoadDeviceTask - [\w.]+Exception:/;

export type EtsOutcome ={ kind: "completed" } | { kind: "ets-failed"; why: string } | { kind: "driver-failed"; why: string };

// From ETS6.log: the application download of `ia` (from ETS's StartLoadDevice to the end of its load task)
// connected to the simulator's endpoint alone, and ETS recorded the application, its parameters and group
// addresses as loaded. Anything less is not shown to be a download into the simulator.
export function etsOutcome(ets6log: string, ia: string, endpoint: string): EtsOutcome {
  const lines = ets6log.split("\n");
  const starts = lines.flatMap((l, i) => (l.includes(`StartLoadDevice(Application) ${ia} `) ? [i] : []));
  if (starts.length !== 1) return { kind: "driver-failed", why: `ETS6.log holds ${starts.length} application downloads of ${ia}, not one` };
  const end = lines.findIndex((l, i) => i > starts[0] && l.includes(`LoadDeviceTask - End LoadApplicationProgram ${ia} `));
  // A load task that fails ends without that line: ETS logs the task's exception instead and goes on
  // reconnecting to the interface afterwards.
  const failed = end >= 0 ? -1 : lines.findIndex((l, i) => i > starts[0] && ETS_TASK_FAILED.test(l));
  const last = end >= 0 ? end : failed;
  const window = lines.slice(starts[0], last < 0 ? undefined : last + 1);
  const connects = window.flatMap((l) => [...l.matchAll(/ - Connect\(([^)]*)\)/g)].map((c) => c[1]));
  const elsewhere = connects.filter((c) => c !== endpoint);
  if (connects.length === 0) return { kind: "driver-failed", why: "ETS6.log shows no connection of the download" };
  if (elsewhere.length) return { kind: "driver-failed", why: `the download connected to ${[...new Set(elsewhere)].join(", ")}, not only to the simulator at ${endpoint}` };
  if (failed >= 0) return { kind: "ets-failed", why: `ETS's load task failed: ${lines[failed].replace(/^.*?LoadDeviceTask - /, "").split(" ---> ")[0].trim()}` };
  if (end < 0) return { kind: "ets-failed", why: "ETS6.log shows no end of the download's load task" };
  // ETS also writes the project's earlier programming state when its load task begins; only the state it
  // records after the last load-procedure step it executed is this download's.
  const lastStep = window.findLastIndex((l) => l.includes("Impl.LoadProcedure - Executing: <LdCtrl"));
  const state = window.findLastIndex((l) => l.includes("UpdateProgramingState: Adr="));
  if (lastStep < 0) return { kind: "ets-failed", why: "ETS6.log shows no load-procedure step executed" };
  if (state < lastStep || !/UpdateProgramingState: Adr=True, Cfg=True, App=True, Par=True, Grp=True\s*$/.test(window[state])) return { kind: "ets-failed", why: "ETS did not record the address, configuration, application, parameters and group addresses as loaded after the download's steps" };
  return { kind: "completed" };
}

// The simulator's refusals among its lines (tools/sim-unit.ts writes each as "sim-refused ...").
export function simRefusals(simLines: string): string[] {
  return simLines.split("\n").flatMap((l) => { const m = l.match(/(?:^|\s)(sim-refused .*)$/); return m ? [m[1]] : []; });
}

// Whether a request changes nothing a comparison covers: a T_Disconnect or a read (as request() reads them).
function changesNothing(hex: string): boolean {
  const t = Buffer.from(hex, "hex");
  if (t.length === 1) return isDisconnect(t);
  return t.length >= 2 && (t[0] & 0xc0) !== 0x80 && isRead(((t[0] & 0x03) << 8) | t[1]);
}

// The simulator's refusals of one run that leave the comparison whole, and the others. A refusal leaves it whole
// only where (a) it comes after the run's last restart, after which the run changed nothing, (b) the refused
// request changes nothing compared (a T_Disconnect, a read, a read on the connection the restart ended), and (c)
// every request of the run the unit did not take changes nothing either. Such refusals stand beside the verdict;
// one of `others` makes the row sim-refused.
export function refusalsAfterRestart(simLines: string, run: RunState): { after: string[]; others: string[] } {
  // Every refusal simRefusals finds is classified; one of another form is one of `others`.
  const lines = simLines.split("\n");
  const restart = lines.findLastIndex((l) => /(?:^|\s)restart\s*$/.test(l));
  const whole = restart >= 0 && run.changesAfterRestart === 0 && run.notTaken.every((n) => changesNothing(n.replace(/^.*: /, "")));
  const after: string[] = [], others: string[] = [];
  lines.forEach((l, i) => {
    const r = simRefusals(l)[0];
    if (r === undefined) return;
    const m = r.match(/^sim-refused (?:([0-9a-f]+) \d+ ms after the restart: |numbered frame ([0-9a-f]+) from \S+ on the connection the restart ended: )/);
    (whole && i > restart && m && changesNothing(m[1] ?? m[2]) ? after : others).push(r);
  });
  return { after, others };
}

// ---- the verdict ----

export interface BusforgeRun {
  capture: string;
  refusals: string[];
  // Busforge's coded refusal (a ProductError of its planner, an ApiError of its server), or null.
  refused: { code: string; message: string } | null;
  // Any other error of its download, where the simulator refused a request of it (which the error follows
  // from); without a refusal such an error is thrown.
  error: string | null;
  result: FlashResult | null;
}

export function judge(ets: { outcome: EtsOutcome; refusals: string[] }, busforge: { refusals: string[]; refused: BusforgeRun["refused"]; writes: number }, differences: () => string[]): Verdict {
  if (ets.outcome.kind === "driver-failed") return { verdict: "driver-failed", why: ets.outcome.why };
  const etsDown = ets.refusals.length ? `the simulator refused ETS: ${ets.refusals[0]}` : ets.outcome.kind === "ets-failed" ? ets.outcome.why : null;
  if (etsDown !== null) {
    if (busforge.writes > 0 && busforge.refusals.length === 0) return { verdict: "busforge-only", ets: etsDown, busforgeWrites: busforge.writes, ...(busforge.refused ? { busforgeRefused: busforge.refused.code } : {}) };
    const bf = busforge.refusals.length ? `the simulator refused Busforge: ${busforge.refusals[0]}` : busforge.refused ? `Busforge refused: ${busforge.refused.code}` : "Busforge wrote nothing";
    return ets.refusals.length ? { verdict: "sim-refused", run: "ETS", refusals: ets.refusals, busforge: bf } : { verdict: "ets-failed", why: etsDown, busforge: bf };
  }
  if (busforge.refusals.length) return { verdict: "sim-refused", run: "Busforge", refusals: busforge.refusals };
  if (busforge.refused) return { verdict: "refused", ...busforge.refused };
  const d = differences();
  return d.length ? { verdict: "differs", differences: d } : { verdict: "identical" };
}

// ---- Busforge's run into a fresh simulated unit ----

// Busforge's full download of `conf` into a fresh unit of `spec`, through the KNXnet/IP server ETS connects
// to and the logging proxy ETS's capture is taken with: the server's own download task.
export async function busforgeIntoSim(spec: SimUnitSpec, conf: RowConfiguration): Promise<BusforgeRun & { sim: SimUnit }> {
  const dir = tempDir("busforge-ets-sweep-");
  const sim = newSimUnit(spec);
  const port = await freePort();
  const server = new KnxIpServer({ transport: sim, maxApdu: spec.interfaceMaxApdu, port });
  const log = join(dir, "capture.log");
  const proxy = startProxy({ port: 0, bridgeHost: "127.0.0.1", bridgePort: port, log, tool: "Busforge" });
  try {
    await server.start();
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const proxyPort = (proxy.address() as { port: number }).port;
    const connection: Connection = { id: "sim", name: "sim", type: "ip", host: "127.0.0.1", port: proxyPort, ipTransport: "tcp", usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0 };
    let result: FlashResult | null = null, refused: BusforgeRun["refused"] = null, error: string | null = null;
    try {
      result = await downloadDeviceFull({
        projectId: "sweep", deviceId: "row", ia: conf.ia, appXml: catalogueXml(spec.catalogue), dataDir: dir, connection,
        params: new Map(conf.params), links: conf.links, moduleInstances: conf.moduleInstances, comObjectOverrides: new Map(conf.comObjectOverrides ?? []), dryRun: false,
      });
    } catch (e) {
      if (e instanceof ProductError || e instanceof ApiError) refused = { code: e.code, message: e.message };
      else if (sim.refusals.length) error = e instanceof Error ? e.message : String(e);
      else throw e;
    }
    // The capture is complete once every KNXnet/IP connection Busforge opened is closed (its T_Disconnect
    // goes before the tunnel's DISCONNECT_REQ). After a refusal the session may end otherwise.
    const ended = () => { const t = existsSync(log) ? readFileSync(log, "utf8") : ""; const n = (svc: string) => t.split("\n").filter((l) => l.includes(`Busforge->BRIDGE ${svc} `)).length; return n("CONNECT_REQ") > 0 && n("DISCONNECT_REQ") >= n("CONNECT_REQ"); };
    for (let i = 0; !ended(); i++) {
      if (i === 100) { if (result) throw new Error("Busforge's session did not end within 10 s of the download's result"); break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { capture: existsSync(log) ? readFileSync(log, "utf8") : "", refusals: [...sim.refusals], refused, error, result, sim };
  } finally {
    proxy.close();
    await server.stop();
    removeTempDir(dir);
  }
}

// A port for the KNXnet/IP server, which takes a port number for its UDP socket and TCP listener alike.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
  });
}

// ---- the second check: ETS's record of the download in its export ----

export type LoadedImageCheck =
  | { state: "no export" }
  | { state: "not compared"; why: string }
  | { state: "equal"; bytes: number }
  | { state: "differs"; bytes: number; mismatches: string[] };

// Busforge's images for `conf` against ETS's LoadedImage of the device at conf.ia in the project export.
// `unitHoldsApplication`: whether the unit held the application when ETS downloaded (etsdiff.ts
// capturedOnLoadedUnit), which decides the form of the download the images are planned for. `exportApplication`:
// the build of the unit's application the export names (RowSpec).
export function loadedImageCheck(proj: Project, appXml: string, conf: RowConfiguration, unitHoldsApplication: boolean, exportApplication?: string): LoadedImageCheck {
  const d = proj.devices.find((x) => x.ia === conf.ia);
  if (!d) return { state: "not compared", why: `the export holds no device ${conf.ia}` };
  const cfg = parseAppConfig(appXml);
  if (appProgramId(d.appRef) !== cfg.id && appProgramId(d.appRef) !== exportApplication) return { state: "not compared", why: `the export's ${conf.ia} runs ${appProgramId(d.appRef)}, not ${cfg.id}` };
  if (!etsLoadedCompletely(d)) return { state: "not compared", why: `ETS marks ${(etsNotDownloaded(d) ?? ["the application"]).join(", ")} as not loaded` };
  if (d.etsLoadedImage === undefined) return { state: "not compared", why: "the export carries no LoadedImage for the device (its load procedure names no LdCtrlLoadImageProp)" };
  const o = loadedImageComparison(cfg, parseLoadProcedures(appXml), conf.ia, {
    params: new Map(conf.params), instances: conf.moduleInstances ?? [], links: conf.links, comObjectOverrides: new Map(conf.comObjectOverrides ?? []),
  }, d.etsLoadedImage, unitHoldsApplication);
  if ("refused" in o) return { state: "not compared", why: `Busforge refuses the full download: ${o.refused}` };
  return o.mismatches.length ? { state: "differs", bytes: o.bytes, mismatches: o.mismatches } : { state: "equal", bytes: o.bytes };
}

// ---- a row ----

export interface Row { id: string; application: string; variant: string; dir: string; spec: RowSpec; unit: SimUnitSpec; conf: RowConfiguration; explained: Explained }

// Every row in the corpus, as "<application>/<variant>".
export function listRows(): string[] {
  const root = corpusPath(SWEEP_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((a) => statSync(join(root, a)).isDirectory()).sort()
    .flatMap((a) => readdirSync(join(root, a)).filter((v) => statSync(join(root, a, v)).isDirectory()).sort().map((v) => `${a}/${v}`));
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export function readRow(id: string): Row {
  const [application, variant, ...rest] = id.split("/");
  if (!application || !variant || rest.length) throw new Error(`a row is named "<application>/<variant>", not "${id}"`);
  const dir = corpusPath(`${SWEEP_DIR}/${id}`);
  const missing = Object.values(ROW_FILES).filter((f) => !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`row ${id} lacks ${missing.join(", ")}`);
  const spec = readJson<RowSpec>(join(dir, ROW_FILES.row));
  const format: unknown = spec.format;
  if (format !== ROW_FORMAT) throw new Error(`row ${id}: ${ROW_FILES.row} is of format ${String(format)}, not ${ROW_FORMAT}`);
  const unit = simUnitSpec(spec.unit);
  const unitApp = unit.catalogue.replace(/\.xml\.gz$/, "");
  if (unitApp !== application) throw new Error(`row ${id}: the simulated unit ${unit.id} runs ${unitApp}, not ${application}`);
  const conf = readJson<RowConfiguration>(join(dir, ROW_FILES.configuration));
  if (conf.appRef !== undefined && appProgramId(conf.appRef) !== application && appProgramId(conf.appRef) !== spec.exportApplication) throw new Error(`row ${id}: the configuration is of ${conf.appRef}, not of ${application}`);
  if (spec.export !== undefined && !existsSync(join(dir, spec.export))) throw new Error(`row ${id}: the export ${spec.export} is missing`);
  if (spec.calibration !== undefined && !existsSync(corpusPath(spec.calibration))) throw new Error(`row ${id}: the calibration capture ${spec.calibration} is missing`);
  const from: unknown = spec.calibrationFrom;
  if (from !== undefined && (spec.calibration === undefined || typeof from !== "number" || !Number.isInteger(from) || from < 0)) throw new Error(`row ${id}: calibrationFrom ${JSON.stringify(from)} is no position of a calibration capture`);
  return { id, application, variant, dir, spec, unit, conf, explained: readJson<Explained>(join(dir, ROW_FILES.explained)) };
}

export interface RowResult {
  verdict: Verdict;
  // The reads only one run made (recorded, not compared).
  reads: { onlyEts: string[]; onlyBusforge: string[] };
  loadedImage: LoadedImageCheck;
  // The requests the unit did not take, per run (recorded, not compared).
  notTaken: { ets: string[]; busforge: string[] };
  // The simulator's refusals after a run's restart that leave the comparison whole (refusalsAfterRestart), each
  // with its request and its time after the restart.
  refusalsAfterRestart: { run: "ETS" | "Busforge"; refusal: string }[];
  // Where the row is calibrated: each position ETS's dialogue with the simulator differs from its dialogue with
  // the real unit, with the cause explained.json gives it (null where none).
  calibration: { capture: string; differences: { difference: string; cause: string | null }[] } | null;
  busforge: BusforgeRun & { sim: SimUnit };
}

export async function runRow(row: Row): Promise<RowResult> {
  const read = (f: string) => readFileSync(join(row.dir, f), "utf8");
  const sim = newSimUnit(row.unit);
  if (iaToNum(row.conf.ia) !== sim.deviceIa) throw new Error(`row ${row.id}: the configuration is of ${row.conf.ia}, the simulated unit answers at another address`);
  const mask = parseAppConfig(catalogueXml(row.unit.catalogue)).mask;
  const etsText = read(ROW_FILES.ets);
  const etsRun = runState(etsText, "ETS", sim.deviceIa, mask);
  const busforge = await busforgeIntoSim(row.unit, row.conf);
  const bfRun = runState(busforge.capture, "Busforge", sim.deviceIa, mask);
  const etsRefusals = refusalsAfterRestart(read(ROW_FILES.etsSim), etsRun);
  // A Busforge download that ended in an error leaves no comparison whole, whatever was refused.
  const bfRefusals = busforge.error === null ? refusalsAfterRestart(busforge.sim.lines.join("\n"), bfRun) : { after: [], others: busforge.refusals };
  const verdict = judge(
    { outcome: etsOutcome(readFileSync(join(row.dir, ROW_FILES.ets6log), "latin1"), row.conf.ia, row.spec.simulator), refusals: etsRefusals.others },
    { refusals: bfRefusals.others, refused: busforge.refused, writes: bfRun.writes },
    () => compareRuns(etsRun, bfRun),
  );
  const exportFile = row.spec.export;
  const loadedImage: LoadedImageCheck = (() => {
    if (exportFile === undefined) return { state: "no export" };
    const b = readFileSync(join(row.dir, exportFile));
    const bytes = exportFile.endsWith(".gz") ? gunzipSync(b) : b;
    const proj = openWithPasswords((password) => loadKnxproj(bytes, password, "export"));
    if (proj === null) return { state: "not compared", why: `the export is password-protected and none of the ${passwords().length} password(s) in ${PASSWORDS_ENV} opens it` };
    return loadedImageCheck(proj, catalogueXml(row.unit.catalogue), row.conf, capturedOnLoadedUnit(parseCapture(etsText, sim.deviceIa)), row.spec.exportApplication);
  })();
  const calibration = row.spec.calibration === undefined ? null : {
    capture: row.spec.calibration,
    differences: dialogueDifferences(readFileSync(corpusPath(row.spec.calibration), "utf8"), etsText, sim.deviceIa, "ETS", row.spec.calibrationFrom)
      .map((d) => ({ difference: d, cause: row.explained.calibration?.find((e) => e.difference === d)?.cause ?? null })),
  };
  const refusals = [...etsRefusals.after.map((r) => ({ run: "ETS" as const, refusal: r })), ...bfRefusals.after.map((r) => ({ run: "Busforge" as const, refusal: r }))];
  return {
    verdict, loadedImage, busforge, calibration, refusalsAfterRestart: refusals, notTaken: { ets: etsRun.notTaken, busforge: bfRun.notTaken },
    reads: { onlyEts: [...etsRun.reads].filter((r) => !bfRun.reads.has(r)).sort(), onlyBusforge: [...bfRun.reads].filter((r) => !etsRun.reads.has(r)).sort() },
  };
}

// The differences of a verdict, with the cause explained.json gives each; null where none is given.
export function causes(verdict: Verdict, explained: Explained): { difference: string; cause: string | null }[] {
  if (verdict.verdict !== "differs") return [];
  return verdict.differences.map((d) => ({ difference: d, cause: explained.differences.find((e) => e.difference === d)?.cause ?? null }));
}

// ---- the manifest ----

export interface ManifestRow {
  application: string; variant: string; unit: string; product: string; mask: string; manufacturer: string; etsBuild: string;
  verdict: Verdict["verdict"];
  // The first difference, refusal or failure; null for an identical row.
  first: string | null;
  // Its cause, where explained; for a refusal or failure the reason itself.
  cause: string | null;
  differences: { difference: string; cause: string | null }[];
  reads: RowResult["reads"];
  notTaken: RowResult["notTaken"];
  loadedImage: LoadedImageCheck;
  // Both absent in an entry kept from a manifest the tool wrote before it recorded them.
  calibration?: RowResult["calibration"];
  refusalsAfterRestart?: RowResult["refusalsAfterRestart"];
  files: string[];
}
export interface Manifest { format: typeof MANIFEST_FORMAT; busforgeRevision: string | null; rows: ManifestRow[] }

export function manifestRow(row: Row, r: RowResult): ManifestRow {
  const v = r.verdict;
  const diffs = causes(v, row.explained);
  const [first, cause] = v.verdict === "identical" ? [null, null]
    : v.verdict === "differs" ? [diffs[0].difference, diffs[0].cause]
    : v.verdict === "refused" ? [v.code, v.message]
    : v.verdict === "sim-refused" ? [v.refusals[0], `the simulator refused ${v.run}${v.busforge ? `; ${v.busforge}` : ""}`]
    : v.verdict === "busforge-only" ? [`Busforge wrote ${v.busforgeWrites} requests${v.busforgeRefused ? ` and then refused: ${v.busforgeRefused}` : ""}`, v.ets]
    : v.verdict === "ets-failed" ? [v.why, v.busforge ? `${v.why}; ${v.busforge}` : v.why]
    : [v.why, v.why];
  const cfg = parseAppConfig(catalogueXml(row.unit.catalogue));
  return {
    application: row.application, variant: row.variant, unit: row.unit.id, product: row.unit.name, mask: cfg.mask,
    manufacturer: row.application.split("_")[0], etsBuild: row.spec.etsBuild, verdict: v.verdict, first, cause, differences: diffs,
    reads: r.reads, notTaken: r.notTaken, loadedImage: r.loadedImage,
    calibration: r.calibration, refusalsAfterRestart: r.refusalsAfterRestart,
    files: readdirSync(row.dir).sort().map((f) => `${SWEEP_DIR}/${row.id}/${f}`),
  };
}

// The manifest with these rows' entries replaced, and the entries of rows no longer in the corpus dropped.
export function updateManifest(results: ManifestRow[], present: string[]): Manifest {
  const path = corpusUnlistedPath(MANIFEST);
  const old: Manifest | null = existsSync(path) ? readJson<Manifest>(path) : null;
  const format: unknown = old?.format;
  if (old && format !== MANIFEST_FORMAT) throw new Error(`${MANIFEST} is of format ${String(format)}, not ${MANIFEST_FORMAT}`);
  const id = (r: ManifestRow) => `${r.application}/${r.variant}`;
  const fresh = new Set(results.map(id));
  const rows = [...(old?.rows ?? []).filter((r) => present.includes(id(r)) && !fresh.has(id(r))), ...results].sort((a, b) => id(a).localeCompare(id(b)));
  return { format: MANIFEST_FORMAT, busforgeRevision: gitRevision(), rows };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith("--") && !a.startsWith("--keep="));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(" ")}; usage: bun run tools/ets-sweep.ts [<application>/<variant>]... [--keep=<dir>]`);
  const keep = args.find((a) => a.startsWith("--keep="))?.slice(7);
  const present = listRows();
  const ids = args.filter((a) => !a.startsWith("--"));
  const todo = ids.length ? ids : present;
  if (todo.length === 0) throw new Error(`no row under ${SWEEP_DIR}`);
  const results: ManifestRow[] = [];
  for (const id of todo) {
    const row = readRow(id);
    const r = await runRow(row);
    const m = manifestRow(row, r);
    results.push(m);
    console.log(`${id}: ${m.verdict}${m.first ? `: ${m.first}` : ""}`);
    for (const d of m.differences) console.log(`  ${d.difference}\n    cause: ${d.cause ?? "NOT EXPLAINED"}`);
    if (m.reads.onlyEts.length || m.reads.onlyBusforge.length) console.log(`  reads only ETS made: ${list(m.reads.onlyEts)}\n  reads only Busforge made: ${list(m.reads.onlyBusforge)}`);
    if (m.notTaken.ets.length || m.notTaken.busforge.length) console.log(`  not taken by the unit, ETS: ${list(m.notTaken.ets)}\n  not taken by the unit, Busforge: ${list(m.notTaken.busforge)}`);
    for (const x of m.refusalsAfterRestart ?? []) console.log(`  after the restart, refused (comparison whole): ${x.run}: ${x.refusal}`);
    console.log(`  LoadedImage: ${m.loadedImage.state}${"why" in m.loadedImage ? ` (${m.loadedImage.why})` : ""}${"bytes" in m.loadedImage ? `, ${m.loadedImage.bytes} bytes` : ""}`);
    if (keep) {
      const out = join(keep, id);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "busforge.log"), r.busforge.capture);
      writeFileSync(join(out, "busforge.log.sim.txt"), r.busforge.sim.lines.join("\n") + "\n");
      copyFileSync(join(row.dir, ROW_FILES.ets), join(out, "ets.log"));
      console.log(`  kept in ${out}`);
    }
  }
  const manifest = updateManifest(results, present);
  writeFileSync(corpusUnlistedPath(MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest: ${MANIFEST} (${manifest.rows.length} rows)`);
  return 0;
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (e) { console.error(`ets-sweep: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
}
