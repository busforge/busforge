// The smoke run for a device that is commissioned and in use (provision "in-service"). Unlike every
// other spec it does not bring the device to a known state: the device's configuration IS the state,
// so the run takes it over by read-back and writes only the steps the spec names (spec.ts
// InServiceSpec), each set back and read back before the next. It never erases, never runs a
// baseline configuration or the fuzzer, and runs a full download only when the spec offers one and
// the operator asks for it on the command line. Anything that could make a write touch more than its
// step stops the run before the first write.
//
// The run is a fixed sequence of phases (inServicePhases), so its writes can be listed without a
// device (planInService, the runner's --plan), and runInService performs exactly that list.
//
// All device access goes through InServiceIo, so the sequence runs against a scripted device in
// inservice.test.ts exactly as against hardware.
import { gaToNum, numToGa } from "../../packages/knx/src/index.ts";
import { BCU1_APPLICATION_ID_RANGE, maskInfo, planForMask, type DeviceReadbackInfo, type SystemFamily } from "../../packages/product/src/index.ts";
import { allComObjects, allParams, findComObject, findParam, type ConfigView, type DeviceCapabilities, type FlashResult } from "./client.ts";
import { judgeLoadStates, judgeRestoredConfig, judgeRunError, type RebootObservation } from "./persistence.ts";
import type { CapabilityResult } from "./capabilities.ts";
import type { BehaviourResult } from "./behaviours.ts";
import type { Channel, DeviceSpec } from "./spec.ts";
import { serverDataPath } from "./evidence.ts";
import { guardAddresses, judgeWeather, parseWeatherGuard, WIND_MARGIN, type WeatherGuard } from "./guard.ts";

// The server's API, for the project bound to the device under test: the oracle and the plumbing
// (adoption, dry runs, the unlink, the restore after a failure).
export interface InServiceApi {
  // `assume`: values of parameters without a memory location for the read to assume (read-back route).
  readBack(assume?: { paramRefId: string; value: string }[]): Promise<DeviceReadbackInfo | null>;
  // Discard the project's edits: every parameter and link takes the baseline the last read-back set.
  revert(): Promise<unknown>;
  getConfig(): Promise<ConfigView>;
  setParam(paramRefId: string, value: string): Promise<unknown>;
  // The group address exists in the project (created when missing), so an object can be linked to it.
  ensureGa(ga: string): Promise<void>;
  // Whether the project holds the group address (an imported installation project holds its own).
  hasGa(ga: string): Promise<boolean>;
  // The group address goes out plain whatever the device runs (Data Secure mode "off").
  setGaPlain(ga: string): Promise<void>;
  setLinks(comObjRefId: string, gaRaws: number[]): Promise<unknown>;
  flashDry(): Promise<FlashResult>;
  flashGaDry(): Promise<FlashResult>;
  downloadDry(): Promise<FlashResult>;
  flashReal(): Promise<FlashResult>;
  flashGaReal(): Promise<FlashResult>;
}

// The surface under test (api: the production endpoints, ui: the web app). A write on the ui channel
// throws unless the dialog reported it verified, so it carries no FlashResult.
export interface FlashOutcome { structural: boolean; result?: FlashResult }
export interface InServiceChannel {
  name: Channel;
  setParam(paramRefId: string, value: string): Promise<void>;
  link(obj: { refId: string; number: number }, ga: string): Promise<void>;
  // Add `ga` behind the object's own addresses `own` (in the project already), which stay, the first
  // still the one the object sends on.
  addLink(obj: { refId: string; number: number }, ga: string, own: number[]): Promise<void>;
  flashParams(): Promise<FlashOutcome>;
  flashLinks(): Promise<FlashOutcome>;
  fullDownload(): Promise<FlashOutcome>;
  readBack(): Promise<DeviceReadbackInfo | null>;
}

// The runner's own connections to the device's bus, never while the server holds a bus operation.
export interface InServiceBus {
  // One interface object property of the device, null where it reports none.
  readProperty(object: number, pid: number): Promise<Buffer | null>;
  // Device memory, `length` bytes from `address`.
  readMemory(address: number, length: number): Promise<Buffer>;
  // Which interface the run's connections go through: the individual address and serial number the
  // interface reports for itself (its KNXnet/IP device information; null where it reports none), and
  // the tunnel address it gave the run's connection.
  route(): Promise<{ interfaceIa: string | null; interfaceSerial: string | null; tunnelIa: string }>;
  // GroupValueRead from the witness: the response value as hex, null when nothing answered.
  groupRead(ga: string): Promise<string | null>;
  // GroupValueRead of `readGa`, an address added behind the object's own `ownGas` (first association
  // first), answered by the device on `ownGas[0]` (witness.ts); `unattributable` when another client
  // read one of the object's own addresses meanwhile.
  groupReadAnsweredOn(readGa: string, ownGas: string[]): Promise<{ value: string | null; unattributable: boolean }>;
  // A telegram the device sends on `ga` within the window, as hex; null when none came.
  listen(ga: string, windowMs: number): Promise<string | null>;
  // A_Restart with the reboot observed, and the load states before and after it (runner.ts); on a
  // System 1 unit, which has no load-state machines, its run error byte instead.
  reboot(): Promise<{ reboot: RebootObservation; before: Map<number, number | null>; after: Map<number, number | null> } | { reboot: RebootObservation; runError: { before: number | null; after: number | null } }>;
}

const UNATTRIBUTABLE = "a read of one of the object's own addresses or of the test address by another client, or an answer on the object's first address before the witness's read, came while the witness waited, so no answer can be attributed to its read";

export interface InServiceIo {
  api: InServiceApi;
  chan: InServiceChannel;
  bus: InServiceBus;
  log: (m: string) => void;
  settle: (ms: number) => Promise<void>;
}

// What the operator gives this run on top of the spec: whether the offered full download runs, the
// test group address of the link step, for a Data Secure unit the installation's project file that
// holds its keys, and for a weather station the weather guard's addresses and wind threshold
// (guard.ts; all of them belong to the installation, so never in the spec).
export interface InServiceOptions { fullDownload: boolean; testGa?: string; knxproj?: string; weatherGuard?: string }

// The configuration the device was found with, before the first write: every parameter value and
// every object's links, as the read-back decoded them. Together with the server's own backups (the
// `backup` of each FlashResult, kept with the project) it is what a recovery by hand starts from.
export interface FoundConfiguration {
  params: Record<string, string>;
  links: Record<string, number[]>;
  backups: string[];
  // Assumed parameters whose value another value of theirs writes the same: taken, not shown.
  unprovenAssumptions?: string[];
  // The bytes the parameter flash's dry run found differing only where the unit reads FF (FlashResult.readsFF),
  // device addresses: taken as bytes the unit does not give back, which every parameter write of the run
  // must then show on its write confirmation alone (confirmedOnly).
  readsFF?: Ranges;
}

export interface InServiceResult {
  ok: boolean;
  capabilities: CapabilityResult[];
  behaviours: BehaviourResult[];
  persistence?: { state: "pass" | "fail"; detail: string };
  // The write whose result the persistence check covers (the link while it is placed, else the full download).
  persistenceOf?: "flashLinks" | "fullDownload";
  // The device's configuration back as it was found: after a clean run, the dry runs; after a
  // failure, the undo of whatever the run had changed.
  restore?: { state: "pass" | "fail"; detail: string };
  found?: FoundConfiguration;
  // Where the run stopped, if it did; nothing after it was attempted.
  stopped?: { phase: string; detail: string };
  // The interface the run's connections went through, as the fingerprint phase found it.
  route?: string;
}

export type Phase = "fingerprint" | "adopt" | "capabilities" | "params" | "links" | "structural" | "fullDownload" | "final";

// One step of the plan. `write` and `restart` reach the device; `read` does not change it.
export interface PlanStep { phase: Phase; kind: "read" | "write" | "restart"; op?: "flashParams" | "flashLinks" | "structuralFlash" | "fullDownload"; text: string }

// The phases a spec runs, in order: smallest write first, the full download last.
export function inServicePhases(spec: DeviceSpec, opts: InServiceOptions): Phase[] {
  const s = spec.inService;
  const out: Phase[] = ["fingerprint", "adopt", "capabilities"];
  if (s?.param) out.push("params");
  if (s?.link) out.push("links");
  if (s?.structural) out.push("structural");
  if (s?.fullDownload && opts.fullDownload) out.push("fullDownload");
  out.push("final");
  return out;
}

// The version property of object 0 the units of a family report, and the one they refuse (PID 9
// firmware revision, PID 25 version), as read-only collections of MV-0705 and MV-07B0 units show
// them; another mask of the family that refuses its version property stops the run at the
// fingerprint. The application id is PID 13 of the object the mask's master data names for it
// (collectplan.ts). A family without an entry has no in-service spec yet; its rule comes from a
// collection of one of its units.
// A System 1 unit has no interface object carrying the application id: it keeps the id (manufacturer,
// application number, version) in its EEPROM (system1.ts), and the read-only collections of an MV-0012
// unit show no object-0 version property, so the fingerprint is that memory range alone; the mask
// version is the device descriptor, which the read-back checks.
const FINGERPRINT_RULES: Partial<Record<SystemFamily, { versionPid: number; refusedPid: number } | { memory: { address: number; length: number } }>> = {
  "system-7": { versionPid: 9, refusedPid: 25 },
  "system-b": { versionPid: 25, refusedPid: 9 },
  "system-1": { memory: BCU1_APPLICATION_ID_RANGE },
};

const hex4 = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;
type FingerprintEntry = InServiceFingerprint[number];
const fingerprintTarget = (f: FingerprintEntry) => ("memory" in f ? `memory ${hex4(f.memory)}, ${f.length} byte(s)` : `object ${f.object} PID ${f.pid}`);

// The fingerprint a spec must give for its mask's family: the application id and the version
// property the family's units report, never the one they refuse.
function fingerprintProblems(spec: DeviceSpec, fp: InServiceFingerprint): string[] {
  const family = maskInfo(spec.device.mask).family;
  const rule = FINGERPRINT_RULES[family];
  if (!rule) return [`no fingerprint rule for mask ${spec.device.mask} (family ${family}); add one to FINGERPRINT_RULES from a read-only collection of a unit`];
  if ("memory" in rule) {
    const { address, length } = rule.memory;
    return fp.some((f) => "memory" in f && f.memory === address && f.length === length) ? [] : [`the fingerprint lacks the application id: on ${family} it is memory ${hex4(address)}, ${length} byte(s)`];
  }
  const appObject = planForMask(spec.device.mask).applicationObject;
  if (appObject === null) return [`mask ${spec.device.mask} declares no interface object carrying the application id, so the fingerprint cannot name the application`];
  const has = (object: number, pid: number) => fp.some((f) => !("memory" in f) && f.object === object && f.pid === pid);
  const out: string[] = [];
  if (!has(appObject, 13)) out.push(`the fingerprint lacks the application id: on ${family} it is object ${appObject} PID 13`);
  if (!has(0, rule.versionPid)) out.push(`the fingerprint lacks the version: on ${family} it is object 0 PID ${rule.versionPid}`);
  if (has(0, rule.refusedPid)) out.push(`object 0 PID ${rule.refusedPid}: ${family} units refuse it, the version is object 0 PID ${rule.versionPid}`);
  return out;
}
type InServiceFingerprint = NonNullable<DeviceSpec["inService"]>["fingerprint"];

// What makes a spec fit for a device in service. Returns the problems; an empty list means fit.
export function inServiceProblems(spec: DeviceSpec): string[] {
  const out: string[] = [];
  const s = spec.inService;
  if (spec.provision !== "in-service") out.push(`provision is "${spec.provision}", not "in-service"`);
  if (!s) return [...out, "no inService block: the fingerprint and the writes are missing"];
  if (!s.fingerprint.length) out.push("the fingerprint is empty: nothing would tell this unit from another");
  for (const f of s.fingerprint) if (!/^([0-9a-f]{2})+$/.test(f.expect)) out.push(`fingerprint ${f.name}: expect "${f.expect}" is not lower-case hex bytes`);
  for (const f of s.fingerprint) if ("memory" in f && f.expect.length !== 2 * f.length) out.push(`fingerprint ${f.name}: expect holds ${f.expect.length / 2} byte(s), the range ${f.length}`);
  if (s.ipInterface && !/^\d+\.\d+\.\d+$/.test(s.ipInterface.ia)) out.push(`ipInterface: "${s.ipInterface.ia}" is not an individual address`);
  if (s.ipInterface && !s.ipInterface.shown) out.push("ipInterface: say where what a restart does to the interface's tunnels was shown");
  out.push(...fingerprintProblems(spec, s.fingerprint));
  const expected = (s.expectParams ?? []).map((e) => e.paramRefId);
  for (const ref of new Set(expected.filter((r, i) => expected.indexOf(r) !== i))) out.push(`expectParams names ${ref} more than once`);
  for (const e of s.expectParams ?? []) if (!e.name || !e.paramRefId || !e.value) out.push(`expectParams: an entry needs a name, a paramRefId and a value (${e.name || e.paramRefId || "unnamed"})`);
  const assumed = (s.assumeParams ?? []).map((e) => e.paramRefId);
  for (const ref of new Set(assumed.filter((r, i) => assumed.indexOf(r) !== i))) out.push(`assumeParams names ${ref} more than once`);
  for (const e of s.assumeParams ?? []) if (!e.name || !e.paramRefId || !e.value) out.push(`assumeParams: an entry needs a name, a paramRefId and a value (${e.name || e.paramRefId || "unnamed"})`);
  for (const ref of assumed) {
    if (expected.includes(ref)) out.push(`${ref} is both assumed and expected; an assumed value is the one the run takes over`);
    if (ref === s.param?.paramRefId || ref === s.structural?.paramRefId) out.push(`${ref} is assumed and a step's parameter; a step writes a parameter with a memory location`);
  }
  if (!s.param && !s.link && !s.structural && !s.fullDownload) out.push("no step: the run would write nothing and prove nothing");
  if (spec.precondition) out.push("a precondition (a human step before the run) has no place on a device in service");
  if (spec.configure.length) out.push("configure steps would write the device beyond the spec's steps");
  if (spec.fuzz) out.push("a fuzz policy has no place on a device in service");
  if (spec.structuralTrigger) out.push("structuralTrigger is for the bench specs; a device in service names its structural step in inService.structural");
  if (s.param && s.structural && s.param.paramRefId === s.structural.paramRefId) out.push("param and structural name the same parameter");
  for (const b of spec.behaviours) {
    if (b.kind !== "output" && b.kind !== "heartbeat") { out.push(`behaviour ${b.label}: only output and heartbeat behaviours observe the linked object`); continue; }
    if (!s.link) { out.push(`behaviour ${b.label}: there is no link to observe it on`); continue; }
    if (b.ga || b.enable?.length) out.push(`behaviour ${b.label}: a fixed address or enable parameters would need writes of their own`);
    if (b.comObjRefId !== s.link.comObjRefId) out.push(`behaviour ${b.label}: observes ${b.comObjRefId}, not the linked object ${s.link.comObjRefId}`);
    // An object sends on its first address only, and the added test address comes behind its own.
    if (b.kind === "heartbeat" && s.link.addToLinked) out.push(`behaviour ${b.label}: an object sends on its first address only, so a heartbeat is never seen on an address added behind its own; observe it with an output (a read)`);
  }
  const unsafe = new Set((spec.unsafe ?? []).map((u) => u.capability));
  const steps: [string, unknown][] = [["flashParams", s.param], ["flashLinks", s.link], ["structuralFlash", s.structural], ["fullDownload", s.fullDownload]];
  for (const [cap, step] of steps) if (step && unsafe.has(cap)) out.push(`${cap} has a step and is declared unsafe`);
  return out;
}

const short = (ref: string) => ref.split("_").slice(-2).join("_");

// What the operator's options must hold for this spec: a Data Secure unit needs the installation's
// project file, and only such a unit takes one; a weather station needs the weather guard, and only
// such a unit takes one; a link step needs a valid test address.
export function optionProblems(spec: DeviceSpec, opts: InServiceOptions): string[] {
  const out: string[] = [];
  if (spec.inService?.dataSecure && !opts.knxproj) out.push("the unit runs Data Secure: its keys come from the installation's project file (--knxproj=<file>, password in BUSFORGE_SMOKE_KNXPROJ_PASSWORD)");
  if (!spec.inService?.dataSecure && opts.knxproj) out.push("--knxproj is read for a Data Secure unit's keys only; this unit is taken over without the installation's project");
  if (spec.inService?.weatherGuard && !opts.weatherGuard) out.push("the unit is a weather station: the run needs the installation's weather addresses and wind threshold (--weather-guard=wind:<ga>:<m/s>,<name>:<ga>,...)");
  if (!spec.inService?.weatherGuard && opts.weatherGuard) out.push("--weather-guard is read for a weather station only; this spec declares none");
  if (spec.inService?.weatherGuard && opts.weatherGuard) { const g = parseWeatherGuard(opts.weatherGuard); if ("refused" in g) out.push(g.refused); }
  if (!spec.inService?.link) return out;
  if (!opts.testGa) return [...out, "the link step needs the test group address (--test-ga=<main/middle/sub>)"];
  // Three levels: the link step creates it as a project group address, which takes main/middle/sub.
  const bad = `--test-ga=${opts.testGa} is not a group address of the form main/middle/sub`;
  if (!/^\d+\/\d+\/\d+$/.test(opts.testGa)) return [...out, bad];
  try { gaToNum(opts.testGa); return out; } catch { return [...out, bad]; }
}

// The sequence runInService performs, without a device. Values the device holds are named, not
// known: the run reads them.
export function planInService(spec: DeviceSpec, opts: InServiceOptions): PlanStep[] {
  const problems = [...inServiceProblems(spec), ...optionProblems(spec, opts)];
  if (problems.length) throw new Error(`spec ${spec.id} is not fit for a device in service: ${problems.join("; ")}`);
  const ga = opts.testGa ?? "";
  const s = spec.inService!;
  const out: PlanStep[] = [];
  // A System 1 unit's parameter route is its whole download, written whatever it finds, and it has no
  // load-state machines.
  const bcu1 = maskInfo(spec.device.mask).memoryModel === "bcu1";
  const loaded = bcu1 ? "the run error FF before and after it" : "load objects LOADED after it";
  for (const phase of inServicePhases(spec, opts)) {
    const read = (text: string) => out.push({ phase, kind: "read", text });
    const write = (op: PlanStep["op"], text: string) => out.push({ phase, kind: "write", op, text });
    if (phase === "fingerprint") {
      const g = opts.weatherGuard ? parseWeatherGuard(opts.weatherGuard) : null;
      if (g && !("refused" in g)) read(`weather guard, before the channel and before every write and restart (the undo's included): wind ${g.wind.ga} must answer below ${WIND_MARGIN * 100} % of ${g.wind.thresholdMs} m/s${g.bits.length ? `, ${g.bits.map((b) => `${b.name} ${b.ga}`).join(", ")} must answer 0` : ""}; an address the unit itself does not answer stops the run`);
      if (s.dataSecure) read(`the project file given with --knxproj is imported; the unit at ${spec.device.ia} must be this spec's product, and the file must hold its tool key: the server takes the unit's keys and those of its group addresses with it, and the runner's own connections (fingerprint, restart) open the unit's secure session`);
      const iface = s.ipInterface;
      read(`route: the individual address the interface reports for itself (KNXnet/IP device information) and the run's tunnel address${!iface ? "" : iface.restart === "drops" ? `; refused when the interface is ${iface.ia}, whose tunnels a restart of this unit drops` : `; through ${iface.ia} too, whose tunnels a restart of this unit keeps (${iface.shown})`}`);
      read(`fingerprint: ${s.fingerprint.map((f) => `${fingerprintTarget(f)} (${f.name}) = ${f.expect}`).join(", ")}`);
    }
    if (phase === "adopt") read(`read-back${s.assumeParams?.length ? `, assuming ${s.assumeParams.map((e) => `${short(e.paramRefId)} (${e.name}) = ${e.value}`).join(", ")} (parameters the device does not hold: the server takes them only if the device's configuration then shows an object for every link and a parameter dry run under them finds nothing to write)` : ""}; the project takes the device's values; a second read-back under them must resolve every association (the server then no longer counts the device as never programmed from this project); the dry runs of the writes the product offers (parameter flash, GA flash) must find nothing to write (the server keeps their backups; a download that always writes, as System 1's: no byte that differs); the configuration found is recorded${s.expectParams?.length ? `; the device's own values: ${s.expectParams.map((e) => `${short(e.paramRefId)} (${e.name}) = ${e.value}`).join(", ")}` : ""}`);
    if (phase === "capabilities") read(`every claimed write capability has its step in the spec or is declared unsafe; readParams and readLinks are claimed; every step's target is visible on the device${s.link ? `; ${short(s.link.comObjRefId)} is ${s.link.addToLinked ? "linked" : "unlinked"} on the device${spec.behaviours.some((b) => b.kind === "output") ? " and has its read flag" : ""}; the test address: no object of the unit uses it${s.link.addToLinked ? ", it lies above every address of the object (which keeps sending on its own first address)" : ""}, nothing on the bus answers a read of it or sends on it within 5 s${s.dataSecure ? ", it is no group address of the installation's project" : ""}` : ""}`);
    if (phase === "params" || phase === "links" || phase === "structural" || phase === "fullDownload") read("before each write: the project holds the configuration found plus this step only, and the other kind of write, where the product offers it, reports unchanged");
    if (phase === "params") {
      const p = s.param!;
      const kind = bcu1 ? "the whole download, which goes out whatever it finds: the dry run must find bytes that differ" : "surgical";
      write("flashParams", `parameter flash: ${short(p.paramRefId)} from the device's value to ${p.value} (dry run first: ${kind})`);
      write("flashParams", `parameter flash: ${short(p.paramRefId)} back to the device's value (dry run first: ${kind})`);
      read("read-back: nothing differs from the configuration found");
    }
    if (phase === "links") {
      const l = s.link!;
      if (s.dataSecure) read(`${ga} set to plain in the project (Data Secure off), so the unit takes it without a key and the witness reads it plainly`);
      write("flashLinks", l.addToLinked
        ? `GA flash: ${short(l.comObjRefId)} (linked on the device) gets ${ga} added behind its own addresses, which stay (dry run first: surgical)`
        : `GA flash: ${short(l.comObjRefId)} (unlinked on the device) linked to ${ga} (dry run first: surgical)`);
      read(`read-back: ${short(l.comObjRefId)} carries ${l.addToLinked ? `its own addresses and ${ga} (the read-back shows the set; the order, own sending address first, is the one the verified write put into the association table)` : `${ga} alone`}${spec.behaviours.length ? `; witness: ${spec.behaviours.map((b) => b.label).join(", ")}${l.addToLinked ? " (a read of the test address, answered on the object's own first address)" : ""}` : "; no behaviour declared, the link is shown to the byte only"}`);
      out.push({ phase, kind: "restart", text: `A_Restart, reboot observed, ${loaded}, read-back equal to the project (the link persists)` });
      write("flashLinks", l.addToLinked
        ? `GA flash: ${ga} removed from ${short(l.comObjRefId)} again, its own addresses left as found (dry run first: surgical)`
        : `GA flash: ${short(l.comObjRefId)} unlinked again (dry run first: surgical)`);
      read(`read-back: nothing differs from the configuration found${l.addToLinked && spec.behaviours.some((b) => b.kind === "output") ? "; witness control: the same read of the test address goes unanswered on the object's first address" : ""}`);
    }
    if (phase === "structural") {
      const t = s.structural!;
      write("structuralFlash", `structural flash: ${short(t.paramRefId)} from the device's value to ${t.value} (dry run first: structural)`);
      write("structuralFlash", `structural flash: ${short(t.paramRefId)} back to the device's value (dry run first: structural)`);
      read("read-back: nothing differs from the configuration found");
    }
    if (phase === "fullDownload") {
      write("fullDownload", "full download of the configuration found (requested with --full-download)");
      read("read-back: nothing differs from the configuration found");
      if (!s.link) out.push({ phase, kind: "restart", text: `A_Restart, reboot observed, ${loaded}, read-back equal to the project` });
    }
    if (phase === "final") read("the dry runs of the writes the product offers find nothing to write: the device holds the configuration it was found with");
  }
  return out;
}

class Stop extends Error { constructor(readonly phase: string, readonly detail: string) { super(detail); } }

const errText = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return typeof code === "string" && !msg.includes(code) ? `${code}: ${msg}` : msg;
};
const sameLinks = (a: number[], b: number[]) => a.length === b.length && a.every((g, i) => g === b[i]);

// The weather guard's reads (guard.ts) through the runner's witness; a refusal stops the run before
// whatever was about to happen.
async function weatherCheck(io: InServiceIo, g: WeatherGuard, before: string): Promise<void> {
  const answers = new Map<string, string | null>();
  // Only the unit's own answer counts; another client reading the same address meanwhile does not
  // change what the unit answered, so attribution is not asked.
  for (const ga of guardAddresses(g)) answers.set(ga, (await io.bus.groupReadAnsweredOn(ga, [ga]).catch((e) => { throw new Stop("weather guard", `${before}: the read of ${ga} broke off: ${errText(e)}`); })).value);
  const v = judgeWeather(g, answers);
  io.log(`weather guard ${before}: ${v.detail}`);
  if (!v.pass) throw new Stop("weather guard", `${before}: ${v.detail}`);
}

// Every write of the run and of its undo ends with the unit's restart, so the guard reads before each
// of them and before the persistence restart. The full download's check runs in its phase, before the
// run counts the download as sent (runInService).
function weatherGuarded(io: InServiceIo, g: WeatherGuard): InServiceIo {
  const before = async <R>(what: string, f: () => Promise<R>): Promise<R> => { await weatherCheck(io, g, what); return f(); };
  return {
    ...io,
    api: { ...io.api, flashReal: () => before("before the parameter flash", () => io.api.flashReal()), flashGaReal: () => before("before the GA flash", () => io.api.flashGaReal()) },
    chan: {
      ...io.chan,
      flashParams: () => before("before the parameter flash", () => io.chan.flashParams()),
      flashLinks: () => before("before the GA flash", () => io.chan.flashLinks()),
    },
    bus: { ...io.bus, reboot: () => before("before the restart", () => io.bus.reboot()) },
  };
}

// Set an object's links over the API. The project takes a link only to a group address it holds, and
// a project that took a unit over by read-back holds none of the unit's own addresses: each is
// created first.
async function setLinks(io: InServiceIo, refId: string, gaRaws: number[]): Promise<void> {
  for (const g of gaRaws) await io.api.ensureGa(numToGa(g));
  await io.api.setLinks(refId, gaRaws);
}
const drift = (view: ConfigView): string[] => [
  ...allParams(view).filter((p) => p.changed).map((p) => p.refId.split("_").pop() ?? p.refId),
  ...allComObjects(view).filter((c) => c.changed).map((c) => `object ${c.number}`),
];

// What the read-back says can resolve its unresolved links, by its split of them: only an assumed
// value of a parameter no read sees places an object the device's own configuration does not take;
// one the configuration places is hidden by the project's values; for the rest the read could not tell.
export function whatResolves(rb: Pick<DeviceReadbackInfo, "unplacedObjects" | "hiddenObjects" | "unknownObjects">, assumed: boolean): string {
  const out: string[] = [];
  if (rb.unplacedObjects?.length) out.push(`Object(s) ${rb.unplacedObjects.join(", ")}: no object of the device's own configuration takes them, only a value of a parameter without a memory location can place them: ${assumed ? "the assumed values do not; another such parameter's value may" : "give its value in assumeParams"}`);
  if (rb.hiddenObjects?.length) out.push(`Object(s) ${rb.hiddenObjects.join(", ")}: the device's configuration places them, the project's own values hide them`);
  if (rb.unknownObjects?.length) out.push(`Object(s) ${rb.unknownObjects.join(", ")}: the read could not tell what places them`);
  return out.length ? out.join(". ") : "The read-back did not say what can resolve them";
}

// A read-back that must have covered parameters and links completely and found nothing that differs
// from the project.
async function noDrift(io: InServiceIo, coverage: DeviceReadbackInfo | null, what: string): Promise<string | null> {
  if (!coverage) return `${what}: the read-back did not report what it covered`;
  if (!coverage.paramsRead || !coverage.linksRead) return `${what}: the read-back did not cover both parameters and links`;
  if (coverage.linkGaps > 0) return `${what}: ${coverage.linkGaps} association(s) did not resolve${coverage.unresolvedObjects?.length ? ` (object(s) ${coverage.unresolvedObjects.join(", ")})` : ""}`;
  const d = drift(await io.api.getConfig());
  return d.length ? `${what}: the device differs from the project in ${d.slice(0, 5).join(", ")}${d.length > 5 ? ` and ${d.length - 5} more` : ""}` : null;
}

// Where the project differs from the configuration the run found, apart from the step under way: a
// parameter or link edit the run did not ask for (a dependent default, a value the UI reformatted, an
// edit a stopped step left behind) would otherwise go out with the step's write.
function apartFromStep(view: ConfigView, found: FoundConfiguration, step: { param?: [string, string]; link?: [string, number[]] } = {}): string[] {
  const out: string[] = [];
  for (const p of allParams(view)) {
    const want = step.param?.[0] === p.refId ? step.param[1] : found.params[p.refId];
    if (want !== undefined && p.value !== want) out.push(`${p.refId.split("_").pop() ?? p.refId} = ${p.value}`);
  }
  for (const c of allComObjects(view)) {
    const want = step.link?.[0] === c.refId ? step.link[1] : (found.links[c.refId] ?? []);
    if (!sameLinks(c.gaRaws ?? [], want)) out.push(`object ${c.number} links`);
  }
  return out;
}

type Ranges = { address: number; length: number }[];
const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
const rangeText = (rs: Ranges) => rs.map((x) => (x.length === 1 ? hex(x.address) : `${hex(x.address)}-${hex(x.address + x.length - 1)}`)).join(", ");
const covers = (rs: Ranges, a: number) => rs.some((x) => a >= x.address && a < x.address + x.length);
// A dry run whose every differing byte the unit reads as FF (FlashResult.readsFF): what a unit returns for
// a byte it does not give back, which only a write tells from a byte that holds FF.
const onlyFF = (r: FlashResult): boolean => r.kind === "dryRun" && !r.alwaysWrite && (r.diffBytes ?? 0) > 0
  && (r.readsFF ?? []).reduce((n, x) => n + x.length, 0) === r.diffBytes;
// A dry run that finds nothing to write: unchanged; for a write that goes out whatever it finds (the
// System 1 download, which also writes state it does not read), one in which no byte differs; or one that
// differs only where the unit reads FF, at exactly the bytes the adoption took as not given back (`ff`).
const sameRanges = (a: Ranges, b: Ranges) => a.length === b.length && a.every((x, i) => x.address === b[i].address && x.length === b[i].length);
const nothingToWrite = (r: FlashResult, ff: Ranges | undefined): boolean => r.kind === "unchanged" || (r.kind === "dryRun" && r.alwaysWrite === true && r.diffBytes === 0)
  || (!!ff?.length && onlyFF(r) && sameRanges(r.readsFF!, ff));
const dryKind = (r: FlashResult): string => r.kind !== "dryRun" ? r.kind
  : `${r.alwaysWrite || r.readsFF?.length ? `dryRun with ${r.diffBytes ?? "?"} differing byte(s)` : r.kind}${r.readsFF?.length ? ` (read as FF at ${rangeText(r.readsFF)})` : ""}`;

// A parameter write after an adoption that took bytes as not given back (FoundConfiguration.readsFF): the
// write puts the project's value there, and must show each of them on its write confirmation alone. One it
// read back as written was given back: the unit held FF there, not the configuration taken over, and now
// holds the project's value, which no undo by dry run sees; the value found is in the server's backups.
function ffProblem(r: FlashResult | undefined, ff: Ranges): string | null {
  if (!r) return `the write's result is not known, so the bytes at ${rangeText(ff)} taken as not given back are not shown on its write confirmation`;
  const c = r.confirmedOnly ?? [];
  const missing = ff.flatMap((x) => Array.from({ length: x.length }, (_, i) => x.address + i)).filter((a) => !covers(c, a));
  if (!missing.length) return null;
  return `the adoption took the bytes at ${rangeText(ff)} as not given back by the unit, but this write ${c.length ? `rested on its confirmation alone only at ${rangeText(c)}` : "read every byte back"}: the unit gave back ${missing.length} of them, so it held FF there, not the configuration taken over, and now holds the project's value there; the value found is in the server's backups`;
}
function confirmFF(o: FlashOutcome, ff: Ranges | undefined, phase: string): string {
  if (!ff?.length) return "";
  const problem = ffProblem(o.result, ff);
  if (problem) throw new Stop(phase, problem);
  return `, ${rangeText(ff)} written from the project on the write confirmation alone`;
}

// The dry run before a write: it must find a change to write, of the expected kind. A coded refusal
// (e.g. the com-object table would go stale) ends the run here; it is never routed to a download.
async function dryBeforeWrite(dry: () => Promise<FlashResult>, phase: string, structural: boolean, ff: Ranges | undefined): Promise<void> {
  let r: FlashResult;
  try { r = await dry(); } catch (e) { throw new Stop(phase, `dry run refused: ${errText(e)}`); }
  if (r.kind !== "dryRun") throw new Stop(phase, `dry run reported ${r.kind}, expected a change to write`);
  if (nothingToWrite(r, ff)) throw new Stop(phase, `the dry run reports ${dryKind(r)}, nothing beyond the configuration found (the write would go out all the same); expected a change to write`);
  if (!!r.structural !== structural) throw new Stop(phase, structural ? "the dry run is not a structural flash; this step is approved as one" : "the dry run would be a structural flash (com-object table and group tables); this step is approved as a surgical flash only");
}

function checkWritten(o: FlashOutcome, phase: string, structural: boolean): string {
  if (o.structural !== structural) throw new Stop(phase, structural ? "the write did not go out as a structural flash" : "the write went out as a structural flash");
  if (o.result && (o.result.kind !== "flashed" || o.result.verified !== true)) throw new Stop(phase, `${o.result.kind}, verified=${String(o.result.verified)}`);
  const n = o.result?.kind === "flashed" ? o.result.diffBytes : undefined;
  return `${n !== undefined ? `${n} B, ` : ""}verified${o.result?.kind === "flashed" && o.result.restartUnproven ? ", restart not confirmed by the device" : ""}`;
}

// What the run has changed on the device (or may have) and not yet set back; the undo after a
// failure sets back exactly these, with the same kind of write.
interface Outstanding { params: Map<string, { value: string; structural: boolean }>; links: Map<string, number[]> }

export async function runInService(spec: DeviceSpec, io: InServiceIo, opts: InServiceOptions): Promise<InServiceResult> {
  const channel = io.chan.name;
  let route: string | undefined;
  // The writes the product offers, read from the server before the adoption: a dry run of a write it
  // does not offer is refused (System 1 writes no group tables).
  let claims: DeviceCapabilities | undefined;
  // The dry runs of the writes the product offers, each named.
  const dryRuns = async (): Promise<{ name: string; r: FlashResult }[]> => [
    ...(claims!.flashParams ? [{ name: "parameter flash", r: await io.api.flashDry() }] : []),
    ...(claims!.flashLinks ? [{ name: "GA flash", r: await io.api.flashGaDry() }] : []),
  ];
  const capabilities: CapabilityResult[] = [];
  const behaviours: BehaviourResult[] = [];
  const out: Outstanding = { params: new Map(), links: new Map() };
  let persistence: InServiceResult["persistence"];
  let persistenceOf: InServiceResult["persistenceOf"];
  let restore: InServiceResult["restore"];
  let found: FoundConfiguration | undefined;
  let stopped: InServiceResult["stopped"];
  let view: ConfigView | null = null;
  // A read-back of the channel under test decoded parameters and links completely and matched.
  let channelReadOk = false;
  // A full download was sent and has not come back verified.
  let downloadOut = false;
  // The weather guard's check before the full download, where the run has one.
  let guardDownload: (() => Promise<void>) | undefined;
  // The phase a failure that is not a Stop (a channel, the server, the bus) is reported in.
  let at = "spec";
  const cap = (capability: string, state: CapabilityResult["state"], detail: string, evidence?: Record<string, unknown>) =>
    capabilities.push({ capability, channel, state, detail, ...(evidence ? { evidence } : {}) });
  const s = spec.inService;
  // A failure of the runner's own connections, not of the device: reported, no evidence record.
  const harness = (what: string, detail: string) => { io.log(`${what}: ${detail}`); cap(`harness: ${what}`, "fail", detail); };

  // A_Restart and a read-back that must equal the project. A failure is recorded; the run goes on, so
  // whatever is placed is still set back.
  const persist = async (): Promise<InServiceResult["persistence"]> => {
    const r = await (async (): Promise<NonNullable<InServiceResult["persistence"]>> => {
      const observed = await io.bus.reboot();
      const { reboot } = observed;
      if (!reboot.rebooted) return { state: "fail", detail: reboot.detail };
      const states = "runError" in observed ? judgeRunError(observed.runError.before, observed.runError.after) : judgeLoadStates(observed.before, observed.after);
      await io.settle(3000);
      const coverage = await io.api.readBack();
      const judged = judgeRestoredConfig(await io.api.getConfig(), coverage);
      await io.settle(3000);
      return { state: states.state === "pass" && judged.state === "pass" ? "pass" : "fail", detail: `${reboot.detail}; ${states.detail}; ${judged.detail}` };
    })().catch((e) => { if (e instanceof Stop) throw e; harness("persistence", `the persistence check broke off: ${errText(e)}`); return undefined; });
    if (r) io.log(`persistence: ${r.detail}`);
    return r;
  };

  // The project, before a write, must hold the configuration found plus the step and nothing else, and
  // the other kind of write must have nothing to do; after a step it must hold exactly what was found.
  const onlyTheStep = async (phase: string, step: Parameters<typeof apartFromStep>[2], other?: () => Promise<FlashResult>): Promise<void> => {
    const extra = apartFromStep(await io.api.getConfig(), found!, step);
    if (extra.length) throw new Stop(phase, `the project holds more than this step before its write: ${extra.slice(0, 5).join(", ")}`);
    if (!other) return;
    const o = await other();
    if (!nothingToWrite(o, found!.readsFF)) throw new Stop(phase, `the other kind of write reports ${dryKind(o)} before this step's write; the write would carry more than the step`);
  };
  // A read-back of the channel under test after a step: complete, equal to the project, and the
  // project equal to the configuration found.
  const settled = async (phase: string, what: string): Promise<void> => {
    const left = await noDrift(io, await io.chan.readBack(), what);
    await io.settle(3000);
    if (left) throw new Stop(phase, left);
    const extra = apartFromStep(await io.api.getConfig(), found!);
    if (extra.length) throw new Stop(phase, `${what}: the device differs from the configuration found in ${extra.slice(0, 5).join(", ")}`);
    channelReadOk = true;
  };

  // A parameter there and back, surgical or structural, then a read-back without drift.
  const thereAndBack = async (phase: "flashParams" | "structuralFlash", step: { paramRefId: string; value: string }, original: string): Promise<void> => {
    const structural = phase === "structuralFlash";
    io.log(`${phase}: ${step.paramRefId} ${original} → ${step.value}`);
    at = `${phase} preflight`;
    out.params.set(step.paramRefId, { value: original, structural });
    // While a change that alters the com-object table is pending, the GA flash route runs the
    // structural flash, so for a structural step the group tables are checked to have nothing to do
    // before its parameter is set; the structural flash then writes them from links that must still
    // equal the configuration found.
    const gaDry = claims!.flashLinks ? () => io.api.flashGaDry() : undefined;
    if (structural) await onlyTheStep(`${phase} preflight`, {}, gaDry);
    await io.chan.setParam(step.paramRefId, step.value);
    await onlyTheStep(`${phase} preflight`, { param: [step.paramRefId, step.value] });
    await dryBeforeWrite(() => io.api.flashDry(), `${phase} preflight`, structural, found!.readsFF);
    if (!structural) await onlyTheStep(`${phase} preflight`, { param: [step.paramRefId, step.value] }, gaDry);
    at = phase;
    const thereOut = await io.chan.flashParams();
    const there = checkWritten(thereOut, phase, structural) + confirmFF(thereOut, found!.readsFF, phase);
    await io.settle(2000);
    if (structural) await onlyTheStep(phase, { param: [step.paramRefId, step.value] }, gaDry);
    await io.chan.setParam(step.paramRefId, original);
    await onlyTheStep(phase, {});
    await dryBeforeWrite(() => io.api.flashDry(), phase, structural, found!.readsFF);
    if (!structural) await onlyTheStep(phase, {}, gaDry);
    const backOut = await io.chan.flashParams();
    const back = checkWritten(backOut, phase, structural) + confirmFF(backOut, found!.readsFF, phase);
    out.params.delete(step.paramRefId);
    await io.settle(2000);
    await settled(phase, `after the ${phase} revert`);
    cap(phase, "pass", `${short(step.paramRefId)} ${original}→${step.value} (${there}) →${original} (${back}), zero drift on read-back`,
      { swept: [{ ref: step.paramRefId, from: original, to: step.value }] });
  };

  try {
    const problems = [...inServiceProblems(spec), ...optionProblems(spec, opts)];
    if (problems.length) throw new Stop("spec", problems.join("; "));
    if (opts.weatherGuard) {
      const g = parseWeatherGuard(opts.weatherGuard) as WeatherGuard;
      io = weatherGuarded(io, g);
      await weatherCheck(io, g, "before the channel");
      guardDownload = () => weatherCheck(io, g, "before the full download");
    }
    const testGa = opts.testGa ?? "";
    const si = s!;
    for (const phase of inServicePhases(spec, opts)) {
      at = phase;
      if (phase === "fingerprint") {
        // Which interface the run goes through, before anything reaches the unit: where the unit's
        // restart drops an interface's tunnels, the run must not depend on that interface.
        const r = await io.bus.route().catch((e) => { throw new Stop(phase, `the interface could not be asked which it is: ${errText(e)}`); });
        route = `${r.interfaceIa ? `interface ${r.interfaceIa}${r.interfaceSerial ? ` (serial ${r.interfaceSerial})` : ""}` : "an interface that reports no device information"}, tunnel address ${r.tunnelIa}`;
        io.log(`route: ${route}`);
        const iface = si.ipInterface;
        if (iface?.restart === "drops") {
          if (!r.interfaceIa) throw new Stop(phase, `the interface reports no individual address of its own, so the run cannot show it does not go through ${iface.ia}, whose tunnels a restart of this unit drops`);
          // The unit itself may be what the box's KNXnet/IP server reports.
          if (r.interfaceIa === iface.ia || r.interfaceIa === spec.device.ia) throw new Stop(phase, `the run goes through ${r.interfaceIa}, ${r.interfaceIa === iface.ia ? "whose tunnels a restart of this unit drops" : "this unit, whose restart drops the tunnels of the interface it shares its housing with"}, the run's own included; reach the unit through another interface`);
        }
        // The unit the spec was written for, before anything else touches it.
        for (const f of si.fingerprint) {
          const where = fingerprintTarget(f);
          const got = await ("memory" in f ? io.bus.readMemory(f.memory, f.length) : io.bus.readProperty(f.object, f.pid)).catch((e) => { throw new Stop(phase, `${f.name} (${where}) not read: ${errText(e)}`); });
          const hex = got ? Buffer.from(got).toString("hex") : null;
          if (hex !== f.expect) throw new Stop(phase, `${f.name} (${where}) reads ${hex ?? "nothing"}, the spec expects ${f.expect}: not the unit this spec was written for`);
        }
        io.log(`fingerprint: ${si.fingerprint.map((f) => `${f.name} ${f.expect}`).join(", ")}`);
      }

      if (phase === "adopt") {
        // The project takes the device's configuration, and the writes must then find nothing to do.
        // A freshly placed device shows the catalogue defaults, under which objects the unit uses may
        // be hidden, so their links count as unresolved on the first read. The project first takes
        // the device's parameters, and a second read must then resolve every link.
        claims = (await io.api.getConfig()).capabilities;
        if (!claims) throw new Stop(phase, "device config carried no capabilities");
        const assume = (si.assumeParams ?? []).map(({ paramRefId, value }) => ({ paramRefId, value }));
        let first: DeviceReadbackInfo | null;
        try { first = await io.api.readBack(assume.length ? assume : undefined); }
        catch (e) { throw new Stop(phase, `the read-back ${assume.length ? "under the assumed values " : ""}was refused: ${errText(e)}`); }
        if (!first?.paramsRead || !first.linksRead) throw new Stop(phase, "the read-back did not cover both parameters and links, so the project cannot take the device's configuration");
        const unproven = first.unprovenAssumptions ?? [];
        if (unproven.length) io.log(`assumed, not shown by the device (another value writes the same): ${unproven.map(short).join(", ")}`);
        await io.settle(3000);
        await io.api.revert();
        const second = await io.api.readBack();
        if (!second?.paramsRead || !second.linksRead) throw new Stop(phase, "the second read-back did not cover both parameters and links");
        if (second.linkGaps > 0) throw new Stop(phase, `${second.linkGaps} association(s) of the device did not resolve under its own configuration${second.unresolvedObjects?.length ? ` (object(s) ${second.unresolvedObjects.join(", ")})` : ""}; a GA flash would drop them. ${whatResolves(second, assume.length > 0)}`);
        // The project knows the flags a GA or structural flash rewrites only where the read took them.
        if (second.flagsUnreadable || second.flagsUndecoded?.length) throw new Stop(phase, `the read-back could not take the flags of the device's com-object table (${second.flagsUnreadable ?? `object(s) ${second.flagsUndecoded!.join(", ")}`}); a write that rewrites it would not know them`);
        await io.settle(3000);
        await io.api.revert();
        const dries = await dryRuns();
        if (!dries.length) throw new Stop(phase, "the product offers neither a parameter nor a GA flash, so no dry run can show the device holds the configuration taken over");
        // A parameter dry run that differs only where the unit reads FF: taken as bytes it does not give back,
        // named, and shown by the run's parameter writes (confirmFF); a run without one cannot show them.
        const pDry = dries.find((d) => d.name === "parameter flash")?.r;
        const ff = pDry && onlyFF(pDry) ? pDry.readsFF! : undefined;
        if (ff && !si.param && !si.structural) throw new Stop(phase, `the parameter flash dry run differs only where the unit reads FF (${rangeText(ff)}), and this spec has no parameter write that would show them as bytes the unit does not give back`);
        if (ff) io.log(`parameter flash dry run: ${pDry!.diffBytes} byte(s) differ only where the unit reads FF (${rangeText(ff)}); taken as bytes it does not give back, each parameter write must show them on its write confirmation alone`);
        const busy = dries.filter((d) => !nothingToWrite(d.r, ff));
        if (busy.length) throw new Stop(phase, `with the device's configuration taken over, ${dries.map((d) => `the ${d.name} dry run reports ${dryKind(d.r)}`).join(" and ")}; each must find nothing to write before a write`);
        view = await io.api.getConfig();
        if (allComObjects(view).some((c) => c.gaRaws === undefined)) throw new Stop(phase, "the server's config view carries no gaRaws (an older build); the run could not see the links it must leave alone");
        const backups = dries.map((d) => d.r.backup).filter((b): b is string => !!b).map(serverDataPath);
        found = {
          params: Object.fromEntries(allParams(view).map((p) => [p.refId, p.value])),
          links: Object.fromEntries(allComObjects(view).filter((c) => c.gaRaws!.length).map((c) => [c.refId, c.gaRaws!])),
          backups,
          ...(unproven.length ? { unprovenAssumptions: unproven } : {}),
          ...(ff ? { readsFF: ff } : {}),
        };
        if (backups.length < dries.length) throw new Stop(phase, "the dry runs reported no backup of the device's memory; no write without one");
        // What the fingerprint cannot tell: the product (or a setting) shows in the configuration.
        for (const e of si.expectParams ?? []) {
          const v = findParam(view, e.paramRefId);
          if (!v) throw new Stop(phase, `${e.name}: parameter ${e.paramRefId} is not visible in the device's configuration`);
          if (v.refId !== e.paramRefId) throw new Stop(phase, `${e.name}: parameter ${e.paramRefId} matches ${v.refId} only by its end; give the full ref verbatim`);
          if (v.value !== e.value) throw new Stop(phase, `${e.name}: the device holds ${v.value}, the spec expects ${e.value}: not the unit or configuration this spec was written for`);
        }
        if (si.expectParams?.length) io.log(`expected values: ${si.expectParams.map((e) => `${e.name} ${e.value}`).join(", ")}`);
        // The server took the assumed values only as a whole; the configuration must show them.
        for (const e of si.assumeParams ?? []) {
          const v = findParam(view, e.paramRefId);
          if (!v || v.refId !== e.paramRefId || v.value !== e.value) throw new Stop(phase, `${e.name}: the configuration taken over shows ${v ? `${v.refId} = ${v.value}` : "no parameter"} for the assumed ${e.paramRefId} = ${e.value}`);
        }
        if (si.assumeParams?.length) io.log(`assumed values taken over: ${si.assumeParams.map((e) => `${e.name} ${e.value}`).join(", ")}`);
      }

      if (phase === "capabilities") {
        const caps = view!.capabilities;
        if (!caps) throw new Stop(phase, "device config carried no capabilities");
        if (!caps.readParams || !caps.readLinks) throw new Stop(phase, "the product does not claim reading parameters and links, so the run cannot take over or check the device's configuration");
        const unsafe = new Map((spec.unsafe ?? []).map((u) => [u.capability, u.reason]));
        const step: Record<keyof DeviceCapabilities, boolean> = { readParams: true, readLinks: true, flashParams: !!si.param, flashLinks: !!si.link, structuralFlash: !!si.structural, fullDownload: !!si.fullDownload };
        for (const key of Object.keys(step) as (keyof DeviceCapabilities)[]) {
          if (step[key] && !caps[key]) throw new Stop(phase, `the spec has a ${key} step, but the product does not claim ${key}`);
          if (!caps[key] || step[key]) continue;
          if (!unsafe.has(key)) throw new Stop(phase, `the product claims ${key}, but the spec has no step for it and does not declare it unsafe with a reason`);
          cap(key, "unsafe", unsafe.get(key)!);
        }
        if (si.fullDownload && !opts.fullDownload) cap("fullDownload", "unproven", "the spec offers a full download of the configuration found; not requested for this run (--full-download)");
        // Every target, checked before the first write.
        for (const p of [si.param, si.structural]) {
          if (!p) continue;
          const v = findParam(view!, p.paramRefId);
          if (!v) throw new Stop(phase, `parameter ${p.paramRefId} is not visible in the device's configuration`);
          if (v.refId !== p.paramRefId) throw new Stop(phase, `parameter ${p.paramRefId} matches ${v.refId} only by its end; give the full ref verbatim`);
          if (v.readOnly) throw new Stop(phase, `parameter ${p.paramRefId} is read-only`);
          if (v.value === p.value) throw new Stop(phase, `parameter ${p.paramRefId} already holds ${p.value} on the device; the flash would write nothing`);
        }
        if (si.link) {
          const obj = findComObject(view!, si.link.comObjRefId);
          if (!obj) throw new Stop(phase, `com-object ${si.link.comObjRefId} is not visible in the device's configuration`);
          if (obj.refId !== si.link.comObjRefId) throw new Stop(phase, `com-object ${si.link.comObjRefId} matches ${obj.refId} only by its end; give the full ref verbatim`);
          const own = obj.gaRaws!;
          if (!si.link.addToLinked && own.length) throw new Stop(phase, `object ${obj.number} is linked on the device (${own.length} address(es)); a plain link step links only an object the device holds unlinked (addToLinked adds the test address behind its own)`);
          if (si.link.addToLinked && !own.length) throw new Stop(phase, `object ${obj.number} is unlinked on the device; the spec's link step adds to an object's own addresses (addToLinked), so it would not be the step the spec was written for`);
          if (spec.behaviours.some((b) => b.kind === "output") && !obj.flags.read) throw new Stop(phase, `object ${obj.number} has no read flag; nothing would answer the output witness's read`);
          const users = allComObjects(view!).filter((c) => c.gaRaws!.includes(gaToNum(testGa))).map((c) => c.number);
          if (users.length) throw new Stop(phase, `the test address is already used by object(s) ${users.join(", ")} of the device`);
          // An imported installation project names the addresses the installation uses.
          if (await io.api.hasGa(testGa)) throw new Stop(phase, "the test address is a group address of the installation's project; give one the installation does not use");
          // The association table lists an object's sending address first, and in the ETS captures
          // that address is also its lowest (docs/load-procedures.md); a test address below the
          // object's own could take its place on a device that sends on the lowest instead.
          if (own.some((g) => g > gaToNum(testGa))) throw new Stop(phase, `the test address lies below an address object ${obj.number} holds; give one above all of them, so the object keeps sending on its own`);
          // The linked object may send on the test address (on every restart, for one), so no other
          // device may act on it: nothing must answer a read of it or send on it.
          const heard = await (async () => [await io.bus.groupRead(testGa), await io.bus.listen(testGa, 5000)])()
            .catch((e) => { throw new Stop(phase, `the test address could not be checked on the bus: ${errText(e)}`); });
          if (heard.some((v) => v !== null)) throw new Stop(phase, "something on the bus answers or sends on the test address; give one no device of the installation uses");
        }
      }

      if (phase === "params") await thereAndBack("flashParams", si.param!, findParam(view!, si.param!.paramRefId)!.value);

      if (phase === "links") {
        const obj = findComObject(view!, si.link!.comObjRefId)!;
        const raw = gaToNum(testGa);
        const own = found!.links[obj.refId] ?? [];
        const placedLinks = [...own, raw];
        io.log(`flashLinks: object ${obj.number} → ${si.link!.addToLinked ? `${own.length} own address(es) + ` : ""}${testGa}`);
        at = "flashLinks preflight";
        out.links.set(obj.refId, own);
        // On a Data Secure unit a new address in mode "auto" would be secured with a generated key; the
        // test address goes out plain, as the witness reads it.
        if (si.dataSecure) { await io.api.ensureGa(testGa); await io.api.setGaPlain(testGa); }
        if (si.link!.addToLinked) {
          // The project takes a link only to an address it holds, so the object's own come first.
          for (const g of own) await io.api.ensureGa(numToGa(g));
          await io.api.ensureGa(testGa);
          await io.chan.addLink({ refId: obj.refId, number: obj.number }, testGa, own);
        } else await io.chan.link({ refId: obj.refId, number: obj.number }, testGa);
        await onlyTheStep("flashLinks preflight", { link: [obj.refId, placedLinks] }, claims!.flashParams ? () => io.api.flashDry() : undefined);
        await dryBeforeWrite(() => io.api.flashGaDry(), "flashLinks preflight", false, found!.readsFF);
        at = "flashLinks";
        const linked = checkWritten(await io.chan.flashLinks(), "flashLinks", false);
        await io.settle(2000);
        const placed = await io.chan.readBack();
        await io.settle(3000);
        if (!placed?.linksRead) throw new Stop("flashLinks", "the read-back after the link flash did not read the group tables");
        const after = findComObject(await io.api.getConfig(), obj.refId);
        if (!after || !sameLinks(after.gaRaws ?? [], placedLinks) || after.changed) throw new Stop("flashLinks", `the device does not carry ${own.length ? "its own addresses and the test address" : "the test address alone"} on object ${obj.number} (differs from the project: ${String(after?.changed ?? "?")})`);
        // Details name "the test address", never the address itself: it belongs to the installation
        // and records ship publicly. The report keeps it in `gas`.
        // An object answers a read of any of its addresses on its first association (findings.md §36),
        // so a read of the test address added behind its own is answered on its own first address.
        const added = si.link!.addToLinked === true;
        const answered = added ? "the object's first address answered the read of the test address with" : "the test address answered";
        // With the test address added, a pass waits for its contrast read after the removal; a run that
        // stops before it records no such behaviour.
        const pending: BehaviourResult[] = [];
        for (const b of spec.behaviours) {
          if (b.kind !== "output" && b.kind !== "heartbeat") continue; // refused by inServiceProblems
          let v: string | null;
          try {
            if (b.kind === "heartbeat") v = await io.bus.listen(testGa, b.windowMs);
            else if (added) {
              const a = await io.bus.groupReadAnsweredOn(testGa, own.map(numToGa));
              if (a.unattributable) { harness(`witness ${b.label}`, UNATTRIBUTABLE); continue; }
              v = a.value;
            } else v = await io.bus.groupRead(testGa);
          }
          catch (e) { harness(`witness ${b.label}`, `the witness broke off: ${errText(e)}`); continue; }
          const head = { kind: b.kind, label: b.label, gas: { object: testGa } };
          const res: BehaviourResult = v === null
            ? { ...head, state: "fail", detail: b.kind === "heartbeat" ? `no telegram on the test address within ${b.windowMs}ms` : `no GroupValueResponse on ${added ? "the object's first address to the read of the test address" : "the test address"}` }
            : b.expectValue && v !== b.expectValue
              ? { ...head, state: "fail", detail: `${answered} 0x${v}, expected 0x${b.expectValue}` }
              : { ...head, state: "pass", detail: `${answered} 0x${v}` };
          (added && res.state === "pass" ? pending : behaviours).push(res);
          io.log(`behaviour ${b.label}: ${res.detail}`);
        }
        persistence = await persist();
        if (persistence) persistenceOf = "flashLinks";
        await setLinks(io, obj.refId, own);
        await onlyTheStep("flashLinks", {}, claims!.flashParams ? () => io.api.flashDry() : undefined);
        await dryBeforeWrite(() => io.api.flashGaDry(), "flashLinks", false, found!.readsFF);
        const unlinked = checkWritten(await io.chan.flashLinks(), "flashLinks", false);
        out.links.delete(obj.refId);
        await io.settle(2000);
        await settled("flashLinks", "after the flashLinks revert");
        // The contrast: with the test address removed, the same read must go unanswered on the object's
        // first address. It rules out an answer the unit gives whatever is read and a client reading the
        // object more often than the witness's window, not an unseen read in the first read's window. A control read that
        // cannot decide leaves the behaviour unrecorded, as a first read would.
        for (const res of pending) {
          let after: { value: string | null; unattributable: boolean };
          try { after = await io.bus.groupReadAnsweredOn(testGa, own.map(numToGa)); }
          catch (e) { harness(`witness ${res.label}`, `the control read after the removal broke off: ${errText(e)}`); continue; }
          if (after.unattributable) { harness(`witness ${res.label}`, `control read after the removal: ${UNATTRIBUTABLE}`); continue; }
          behaviours.push(after.value !== null
            ? { ...res, state: "fail", detail: `${res.detail}, but answered the same read with 0x${after.value} after the test address was removed, so the answer is not the test address's` }
            : { ...res, detail: `${res.detail}, and left the same read unanswered once the test address was removed` });
          io.log(`behaviour ${res.label}: ${behaviours.at(-1)!.detail}`);
        }
        cap("flashLinks", "pass", own.length
          ? `added the test address to object ${obj.number} beside its ${own.length} own address(es), own sending address first (${linked}), read back; removed it (${unlinked}), zero drift on read-back`
          : `linked object ${obj.number} to the test address (${linked}), read back; unlinked (${unlinked}), zero drift on read-back`, { object: obj.number });
      }

      if (phase === "structural") await thereAndBack("structuralFlash", si.structural!, findParam(view!, si.structural!.paramRefId)!.value);

      if (phase === "fullDownload") {
        // The configuration found, written whole. The dry run must offer a write; afterwards the
        // device must hold exactly what it held.
        let dry: FlashResult;
        at = "fullDownload preflight";
        await onlyTheStep("fullDownload preflight", {}, claims!.flashParams ? () => io.api.flashDry() : undefined);
        try { dry = await io.api.downloadDry(); } catch (e) { throw new Stop("fullDownload preflight", `dry run refused: ${errText(e)}`); }
        if (dry.kind !== "dryRun") throw new Stop("fullDownload preflight", `dry run reported ${dry.kind}`);
        await guardDownload?.();
        downloadOut = true;
        at = "fullDownload";
        const done = checkWritten(await io.chan.fullDownload(), "fullDownload", false);
        downloadOut = false;
        await io.settle(3000);
        await settled("fullDownload", "after the full download");
        cap("fullDownload", "pass", `the configuration found, downloaded (${done}), zero drift on read-back`);
        if (!si.link) { persistence = await persist(); if (persistence) persistenceOf = "fullDownload"; }
      }

      if (phase === "final") {
        // The read-backs of the channel under test after each step decoded both parts completely and
        // matched the configuration found.
        if (channelReadOk) {
          cap("readParams", "pass", "parameter image read back and decoded, equal to the configuration found");
          cap("readLinks", "pass", "group tables read back and decoded, no gaps, equal to the configuration found");
        }
        const dries = await dryRuns();
        restore = dries.every((d) => nothingToWrite(d.r, found!.readsFF))
          ? { state: "pass", detail: `the device holds the configuration it was found with: ${dries.map((d) => `${d.name} dry run ${d.r.kind === "unchanged" ? "unchanged" : onlyFF(d.r) ? `differs only at the bytes taken as not given back (${rangeText(d.r.readsFF!)}), which the run's parameter writes set to the project's value: what the unit held there before is not known` : "finds no byte that differs"}`).join(", ")}` }
          : { state: "fail", detail: `after the run ${dries.map((d) => `the ${d.name} dry run reports ${dryKind(d.r)}`).join(" and ")}` };
      }
    }
  } catch (e) {
    stopped = e instanceof Stop ? { phase: e.phase, detail: e.detail } : { phase: at, detail: errText(e) };
    io.log(`stopped in ${stopped.phase}: ${stopped.detail}`);
    if (out.params.size || out.links.size) restore = await undo(io, out, found!, claims!);
    else if (downloadOut) restore = { state: "fail", detail: "the full download broke off: the device may hold its application unloaded. Recover by hand from the configuration found and the server's backups" };
  }

  if (stopped) cap(stopped.phase, "fail", stopped.detail);
  const ok = !stopped
    && capabilities.every((c) => c.state !== "fail")
    && behaviours.every((b) => b.state === "pass")
    && (persistence === undefined || persistence.state === "pass")
    && restore?.state === "pass";
  return { ok, capabilities, behaviours, persistence, persistenceOf, restore, found, stopped, ...(route ? { route } : {}) };
}

// After a stop with a change still on the device (or possibly on it): set the whole project back to
// the configuration found, then write the difference with the kind of flash the change went out
// with, over the API. A dry run that finds nothing to write means the device never took the change.
// Never a full download.
async function undo(io: InServiceIo, out: Outstanding, found: FoundConfiguration, claims: DeviceCapabilities): Promise<NonNullable<InServiceResult["restore"]>> {
  const done: string[] = [];
  const fail = (d: string) => ({ state: "fail" as const, detail: `${done.length ? `${done.join("; ")}; ` : ""}${d}. Recover by hand from the configuration found and the server's backups` });
  try {
    const view = await io.api.getConfig();
    for (const p of allParams(view)) if (found.params[p.refId] !== undefined && p.value !== found.params[p.refId]) await io.api.setParam(p.refId, found.params[p.refId]);
    for (const c of allComObjects(view)) if (!sameLinks(c.gaRaws ?? [], found.links[c.refId] ?? [])) await setLinks(io, c.refId, found.links[c.refId] ?? []);
    const left = apartFromStep(await io.api.getConfig(), found);
    if (left.length) return fail(`the project could not be set back to the configuration found (${left.slice(0, 5).join(", ")}); nothing written`);
    const structural = [...out.params.values()].some((p) => p.structural);
    const pDry = claims.flashParams ? await io.api.flashDry() : null;
    if (pDry && !nothingToWrite(pDry, found.readsFF)) {
      if (!!pDry.structural !== structural) return fail(`the parameter revert would ${pDry.structural ? "" : "not "}be a structural flash, unlike the change; not written`);
      const r = await io.api.flashReal();
      if (r.kind !== "flashed" || r.verified !== true) return fail(`parameter revert ${r.kind}, verified=${String(r.kind === "flashed" ? r.verified : "-")}`);
      const ffLeft = found.readsFF?.length ? ffProblem(r, found.readsFF) : null;
      if (ffLeft) return fail(`parameter revert: ${ffLeft}`);
      done.push("parameters written back");
      await io.settle(3000);
    } else if (pDry) done.push(`parameters: dry run ${dryKind(pDry)}, nothing to write back`);
    const gDry = claims.flashLinks ? await io.api.flashGaDry() : null;
    if (gDry && !nothingToWrite(gDry, found.readsFF)) {
      if (gDry.structural) return fail("the link revert would be a structural flash; not written");
      const r = await io.api.flashGaReal();
      if (r.kind !== "flashed" || r.verified !== true) return fail(`link revert ${r.kind}, verified=${String(r.kind === "flashed" ? r.verified : "-")}`);
      done.push("links written back");
      await io.settle(3000);
    } else if (gDry) done.push(`links: dry run ${dryKind(gDry)}, nothing to write back`);
    const drift = await noDrift(io, await io.api.readBack(), "after the undo");
    return drift ? fail(drift) : { state: "pass", detail: `${done.join("; ")}; read-back without drift` };
  } catch (e) {
    return fail(`undo aborted: ${errText(e)}`);
  }
}
