import { transferChunks, OBJECT_TYPE_SECURITY, type PropertyDescription, type PropertyValueResponse, type PartialMemRead } from "@busforge/knx";
import { planForMask, unreadableReason, type CollectApp, type MaskPlan, type MemoryRange, type RangeSource, type TableStep } from "./collectplan.ts";

// Raw acquisition (docs/raw-acquisition.md): read a device's identity, its interface objects and the
// memory ranges its mask plan names, and record every answer, refusal and gap. It issues read
// services only (descriptor, free-key authorize, property description and value, memory read, the
// security-mode state read) and changes nothing: not the device, not the project, not a baseline.

// The services the collector may send, as the device answers them. KnxDevice satisfies it; tests use
// a fake.
export interface CollectDevice {
  readonly secured: boolean;
  descriptorType0(): Promise<string>;
  authorizeFreeKey(): Promise<number>;
  propertyDescription(obj: number, pid: number, propertyIndex: number): Promise<PropertyDescription>;
  propReadCounted(obj: number, pid: number, start: number, count: number): Promise<PropertyValueResponse>;
  memReadPartial(addr: number, len: number, opts: { chunk: number; signal?: AbortSignal; beforeRequest?: () => void }): Promise<PartialMemRead>;
  funcPropExtStateRead(objectType: number, instance: number, pid: number, data: Buffer): Promise<{ returnCode: number; result: Buffer }>;
}

export type RecordSpace = "descriptor" | "authorize" | "property" | "property-description" | "function-property" | "memory" | "memory-extended";
export type RecordOutcome = "bytes" | "refused" | "timeout" | "connection-closed" | "malformed" | "not-attempted";
export interface CollectRecord {
  step: string;
  space: RecordSpace;
  target: Record<string, number | string>;
  source: RangeSource;
  outcome: RecordOutcome;
  bytes?: string;      // hex, outcome bytes
  raw?: string;        // hex, the device's answer to a refused or malformed request
  description?: PropertyDescription;
  detail?: string;
  at: number;
}
// "error": a failure in the collector itself; the package keeps what was read before it. A cancelled
// job has no package: collectDevice throws CollectCancelled instead.
export type StopReason = "duration" | "unresponsive" | "descriptor-malformed" | "secured-no-key" | "interface" | "error";

// The caller cancelled the job. Everything read up to then is dropped with it.
export class CollectCancelled extends Error {
  readonly code = "COLLECT_CANCELLED";
  constructor() { super("the collection was cancelled; nothing it read is kept"); this.name = "CollectCancelled"; }
}

export interface CollectPackage {
  format: "busforge-raw-collect/1";
  ia: string;
  mask: string | null;
  family: string | null;
  secured: boolean;
  authorizeLevel: number | null;
  maxApdu: number | null;
  plan: MaskPlan | null;
  records: CollectRecord[];
  // Every bound that cut the job short. A package with limits is not complete.
  limits: string[];
  // Why the job ended before its plan did; null when the plan ran to its end.
  stop: { reason: StopReason; detail: string } | null;
  counts: { requests: number; scanRequests: number; memoryRequests: number; memoryBytes: number; reconnects: number };
  startedAt: number;
  finishedAt: number;
}

// The regions a table's memory control block may declare for the collector to read the table by: more
// is a malformed answer, not a table.
const MAX_MCB_REGIONS = 16;

// docs/raw-acquisition.md, "Bounds". The duration and the failures in a row are the bounds a user is
// told about. memoryBytes only guards against a device that states a wrong table size; at the request
// rates of the bench (about 4 per second) the duration ends a job long before it.
export const COLLECT_LIMITS = {
  durationMs: 10 * 60_000,
  failuresInARow: 3,
  memoryBytes: 1024 * 1024,
  propertyBytes: 1024,       // per property, past element 0
  maxObjects: 64,
  maxPropertyIndex: 255,
};

export interface CollectOptions {
  ia: string;
  signal: AbortSignal;
  // T_Disconnect and T_Connect again: after a request that got no answer, the connection's sequence
  // is unreliable (a device that took the request and did not answer counts it, Busforge does not).
  reopen: () => Promise<void>;
  app?: CollectApp | null;
  now?: () => number;
  limits?: Partial<typeof COLLECT_LIMITS>;
  // When the job's clock started, if before this call (the server takes the bus and connects first).
  startedAt?: number;
  // false: no free-key authorize even where the mask declares one, to compare what a device answers
  // without it (tools/collect.ts). The package records the step as not attempted.
  authorize?: boolean;
  onProgress?: (phase: string, done?: number, total?: number) => void;
  // Called before each request with the number of requests issued so far, this one included.
  onRequest?: (requests: number) => void;
}

const LOADED = 1; // PID_LOAD_STATE_CONTROL state Loaded
const hex = (b: Buffer) => b.toString("hex");
// PDT_FUNCTION and PDT_ESCAPE, and the reserved codes before them: a function property is invoked,
// reading its value is not defined (inferred).
const unreadablePdt = (pdt: number) => pdt >= 0x37 && pdt <= 0x3f;

class Stop extends Error { constructor(public reason: StopReason | "cancelled", detail: string) { super(detail); } }
class PhaseLimit extends Error {}

type Failure = { outcome: "timeout" | "connection-closed" | "malformed"; detail: string };

export async function collectDevice(dev: CollectDevice, opts: CollectOptions): Promise<CollectPackage> {
  const now = opts.now ?? (() => Date.now());
  const L = { ...COLLECT_LIMITS, ...opts.limits };
  const startedAt = opts.startedAt ?? now();
  const pkg: CollectPackage = {
    format: "busforge-raw-collect/1", ia: opts.ia, mask: null, family: null, secured: dev.secured, authorizeLevel: null, maxApdu: null,
    plan: null, records: [], limits: [], stop: null,
    counts: { requests: 0, scanRequests: 0, memoryRequests: 0, memoryBytes: 0, reconnects: 0 }, startedAt, finishedAt: startedAt,
  };
  const rec = (r: Omit<CollectRecord, "at">) => { pkg.records.push({ ...r, at: now() }); };
  let phase: "generic" | "scan" | "memory" = "generic";
  let failures = 0;
  let authorize = false;
  // The reason no maximum APDU length is known, for as long as none is.
  let noMaxApdu = "no maximum APDU length is known: this plan does not read PID 56 of object 0";

  const checkJob = () => {
    if (opts.signal.aborted) throw new Stop("cancelled", "the job was cancelled");
    if (now() - startedAt > L.durationMs) throw new Stop("duration", `the job ran past its ${L.durationMs / 60_000} minutes`);
  };
  // Count one request against the job and its phase.
  const beforeRequest = () => {
    checkJob();
    pkg.counts.requests++;
    opts.onRequest?.(pkg.counts.requests);
    if (phase === "scan") pkg.counts.scanRequests++;
    if (phase === "memory") pkg.counts.memoryRequests++;
  };
  const classify = (e: unknown): Failure => {
    if (e instanceof Stop || e instanceof PhaseLimit) throw e;
    const code = (e as { code?: string }).code ?? "";
    const detail = e instanceof Error ? e.message : String(e);
    if (code === "READ_ABORTED") throw new Stop("cancelled", "the job was cancelled");
    if (code === "DEVICE_NOT_ANSWERING") return { outcome: "timeout", detail };
    if (code === "DEVICE_CLOSED_CONNECTION") return { outcome: "connection-closed", detail };
    if (/MISMATCH|INVALID|SECURE_ANSWER_REJECTED/.test(code)) return { outcome: "malformed", detail };
    // The interface or tunnel failed, or something unforeseen: nothing further can be trusted.
    throw new Stop("interface", `${code ? `${code}: ` : ""}${detail}`);
  };
  // After a failed request: three in a row close the device off, anything less reopens the link. A
  // malformed answer counts too: a late answer to an earlier request shifts every answer after it by
  // one, and only a new connection ends that.
  const failed = async () => {
    // A cancelled job opens no new link.
    checkJob();
    failures++;
    if (failures >= L.failuresInARow) throw new Stop("unresponsive", `${failures} requests in a row failed; the device is closed off as unresponsive`);
    try {
      await opts.reopen();
      pkg.counts.reconnects++;
    } catch (e) {
      throw new Stop("interface", `reopening the connection after a failed request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Authorization belongs to the connection, so a new one is authorized again.
    if (authorize) {
      // Until it is known again, no property is skipped for its read level; the device refuses what it must.
      pkg.authorizeLevel = null;
      // The authorize answering does not show the failed request would now be answered: the count stands.
      const before = failures;
      const a = await ask({ step: "authorize", space: "authorize", target: { key: "free" }, source: "master-data" }, () => dev.authorizeFreeKey());
      if (a.ok) {
        failures = before;
        pkg.authorizeLevel = a.value;
        rec({ step: "authorize", space: "authorize", target: { key: "free" }, source: "master-data", outcome: "bytes", bytes: a.value.toString(16).padStart(2, "0"), detail: "again, on the reopened connection" });
      }
    }
  };
  // One request: its value, or the failure already recorded.
  const ask = async <T>(r: Omit<CollectRecord, "at" | "outcome">, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: Failure }> => {
    beforeRequest();
    try {
      const value = await run();
      failures = 0;
      return { ok: true, value };
    } catch (e) {
      const failure = classify(e);
      rec({ ...r, outcome: failure.outcome, detail: failure.detail });
      await failed();
      return { ok: false, failure };
    }
  };

  // The value and the element count the device answered (never more than asked, see propReadCounted).
  const readCounted = async (step: string, obj: number, pid: number, start: number, count: number, source: RangeSource): Promise<{ value: Buffer; count: number } | null> => {
    const target = { object: obj, pid, start, count };
    const r = await ask({ step, space: "property", target, source }, () => dev.propReadCounted(obj, pid, start, count));
    if (!r.ok) return null;
    if (r.value.count === 0) {
      rec({ step, space: "property", target, source, outcome: "refused", raw: hex(r.value.value), detail: "element count 0: the device has no such property or refuses the read" });
      return null;
    }
    if (r.value.value.length === 0) {
      rec({ step, space: "property", target, source, outcome: "malformed", detail: `${r.value.count} element(s) answered with no octets` });
      return null;
    }
    rec({ step, space: "property", target: { ...target, count: r.value.count }, source, outcome: "bytes", bytes: hex(r.value.value) });
    return { value: r.value.value, count: r.value.count };
  };
  const readProperty = async (step: string, obj: number, pid: number, start: number, count: number, source: RangeSource): Promise<Buffer | null> =>
    (await readCounted(step, obj, pid, start, count, source))?.value ?? null;

  try {
    checkJob();
    // ---- descriptor ----
    opts.onProgress?.("descriptor");
    const dd = await ask({ step: "descriptor", space: "descriptor", target: { type: 0 }, source: "device" }, () => dev.descriptorType0());
    if (!dd.ok) {
      throw dd.failure.outcome === "malformed"
        ? new Stop("descriptor-malformed", `the device's descriptor answer is not a type 0 descriptor: ${dd.failure.detail}`)
        : new Stop("unresponsive", `the device did not answer its descriptor (${dd.failure.outcome})`);
    }
    const mask = dd.value;
    pkg.mask = mask;
    rec({ step: "descriptor", space: "descriptor", target: { type: 0 }, source: "device", outcome: "bytes", bytes: mask.replace("MV-", "").toLowerCase() });
    if (mask === "MV-FFFF" && !dev.secured) {
      throw new Stop("secured-no-key", "the device answers a plain descriptor read with 0xFFFF (KNX Data Secure), and no tool key is on file");
    }
    const plan = planForMask(mask, opts.app);
    pkg.plan = plan;
    pkg.family = plan.family;
    for (const n of plan.notAttempted) rec({ step: "plan", space: n.space ?? "memory", target: { name: n.name }, source: "master-data", outcome: "not-attempted", detail: n.reason });

    // ---- generic stage ----
    if (plan.authorize && opts.authorize === false) {
      rec({ step: "authorize", space: "authorize", target: { key: "free" }, source: "master-data", outcome: "not-attempted", detail: "the caller asked for a session without the free-key authorize" });
    } else if (plan.authorize) {
      opts.onProgress?.("authorize");
      const a = await ask({ step: "authorize", space: "authorize", target: { key: "free" }, source: "master-data" }, () => dev.authorizeFreeKey());
      if (a.ok) {
        authorize = true;
        pkg.authorizeLevel = a.value;
        rec({ step: "authorize", space: "authorize", target: { key: "free" }, source: "master-data", outcome: "bytes", bytes: a.value.toString(16).padStart(2, "0") });
      }
    }
    if (plan.objects === "declared" || plan.maxApduAlone) {
      opts.onProgress?.("identity");
      const m = await readProperty("max-apdu", 0, 56, 1, 1, "master-data");
      pkg.maxApdu = m === null ? null : m.length >= 2 ? m.readUInt16BE(0) : m[0];
      if (m === null) {
        const outcome = pkg.records.findLast((r) => r.step === "max-apdu")?.outcome;
        noMaxApdu = outcome === "refused" ? "the device declares no maximum APDU length (PID 56 of object 0 answered with element count 0)"
          : `no maximum APDU length is known: the read of PID 56 of object 0 ended ${outcome ?? "without a record"}`;
        // On a plan without interface objects no answer is expected, so it does not count towards
        // closing the device off.
        if (plan.objects !== "declared") failures = 0;
      }
    }
    if (plan.objects === "declared") {
      if (plan.identity) {
        for (const pid of [11, 12, 15, 25, 78, 9]) await readProperty("identity", 0, pid, 1, 1, "master-data");
      }
      if (plan.applicationObject !== null) await readProperty("identity", plan.applicationObject, 13, 1, 1, "master-data");
      for (const p of plan.properties) await readProperty(`resource: ${p.name}`, p.object, p.pid, 1, 1, "master-data");
    }
    const loadStates = new Map<number, number>();
    for (const o of plan.loadStateObjects) {
      const v = await readProperty("load-states", o, 5, 1, 1, "master-data");
      if (v && v.length >= 1) loadStates.set(o, v[0]);
    }

    // ---- interface-object scan ----
    if (plan.objects !== "none") {
      opts.onProgress?.("scan");
      phase = "scan";
      await scan();
      phase = "generic";
    }

    // ---- memory plan ----
    opts.onProgress?.("memory");
    phase = "memory";
    try { await memoryPlan(plan, loadStates); }
    catch (e) {
      if (!(e instanceof PhaseLimit)) throw e;
      pkg.limits.push(e.message);
    }
    phase = "generic";

    // ---- security mode, the session's last request ----
    if (plan.securityModeLast) {
      opts.onProgress?.("security-mode");
      const target = { objectType: OBJECT_TYPE_SECURITY, instance: 1, pid: 51 };
      const r = await ask({ step: "security-mode", space: "function-property", target, source: "master-data" }, () => dev.funcPropExtStateRead(OBJECT_TYPE_SECURITY, 1, 51, Buffer.from([0x00, 0x00])));
      if (r.ok) {
        const raw = hex(Buffer.concat([Buffer.from([r.value.returnCode]), r.value.result]));
        if (r.value.returnCode === 0) rec({ step: "security-mode", space: "function-property", target, source: "master-data", outcome: "bytes", bytes: hex(r.value.result) });
        else rec({ step: "security-mode", space: "function-property", target, source: "master-data", outcome: "refused", raw, detail: r.value.returnCode === 0xfc ? "access denied" : `return code 0x${r.value.returnCode.toString(16)}` });
      }
    }
  } catch (e) {
    if (e instanceof Stop && e.reason === "cancelled") throw new CollectCancelled();
    pkg.stop = e instanceof Stop ? { reason: e.reason as StopReason, detail: e.message } : { reason: "error", detail: e instanceof Error ? e.message : String(e) };
  }
  // A cancel that came after the last request still drops the package.
  if (opts.signal.aborted) throw new CollectCancelled();
  pkg.finishedAt = now();
  return pkg;

  // The request sizes for this session, or why no secured request fits.
  function chunksOrWhy(): ReturnType<typeof transferChunks> | string {
    if (pkg.maxApdu === null && dev.secured) return `${noMaxApdu}, so the secured session is held to standard frames, and a secured memory request does not fit one`;
    try { return transferChunks(pkg.maxApdu, dev.secured); }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  }

  // Objects by index, each object's properties by index, then the values the session may read.
  async function scan(): Promise<void> {
    // Data bytes one property response carries: the classic memory figure less the two octets a
    // property response spends more (object, PID, count and start against a 2-byte address).
    const c = chunksOrWhy();
    const budget = typeof c === "string" ? c : c.classicRead - 2;
    let anyAnswer = false;
    for (let obj = 0; obj < L.maxObjects; obj++) {
      const first = await ask({ step: "scan", space: "property-description", target: { object: obj, propertyIndex: 0 }, source: "device" }, () => dev.propertyDescription(obj, 0, 0));
      if (!first.ok) {
        if (!anyAnswer) { rec({ step: "scan", space: "property-description", target: { object: obj }, source: "device", outcome: "not-attempted", detail: `property descriptions unsupported: the first description request ended ${first.failure.outcome}; the scan ends` }); return; }
        continue;
      }
      anyAnswer = true;
      rec({ step: "scan", space: "property-description", target: { object: obj, propertyIndex: 0 }, source: "device", outcome: "bytes", description: first.value, detail: first.value.pid === 0 ? "no object at this index" : undefined });
      if (first.value.pid === 0) continue;
      const typeBytes = await readProperty("scan", obj, 1, 1, 1, "device");
      const objectType = typeBytes && typeBytes.length === 2 ? typeBytes.readUInt16BE(0) : null;
      const described: PropertyDescription[] = [first.value];
      for (let idx = 1; idx <= L.maxPropertyIndex; idx++) {
        const d = await ask({ step: "scan", space: "property-description", target: { object: obj, propertyIndex: idx }, source: "device" }, () => dev.propertyDescription(obj, 0, idx));
        if (!d.ok) {
          rec({ step: "scan", space: "property-description", target: { object: obj, propertyIndex: idx + 1 }, source: "device", outcome: "not-attempted", detail: `property index ${idx} was not described (the record before says why); this object's further properties are not described` });
          break;
        }
        if (idx === L.maxPropertyIndex && d.value.pid !== 0) pkg.limits.push(`object ${obj}: property index ${L.maxPropertyIndex}`);
        rec({ step: "scan", space: "property-description", target: { object: obj, propertyIndex: idx }, source: "device", outcome: "bytes", description: d.value, detail: d.value.pid === 0 ? "end of this object's properties" : undefined });
        if (d.value.pid === 0) break;
        described.push(d.value);
      }
      for (const d of described) {
        const target = { object: obj, pid: d.pid };
        const skip = objectType === null ? "the object's type is not known, so it may be the security object, whose content never enters a package"
          : objectType === OBJECT_TYPE_SECURITY ? "a property of the security object; key tables are write-only and keys never enter a package"
          : unreadablePdt(d.pdt) ? `PDT 0x${d.pdt.toString(16)}: a function or reserved property type, which is invoked, not read`
          : pkg.authorizeLevel !== null && d.readLevel < pkg.authorizeLevel ? `read level ${d.readLevel}, above the session's level ${pkg.authorizeLevel}`
          : d.pid === 1 ? "read above as the object type"
          : typeof budget === "string" ? budget : null;
        if (skip) { rec({ step: "scan", space: "property", target, source: "device", outcome: "not-attempted", detail: skip }); continue; }
        await readValues(obj, d.pid, budget as number);
      }
      if (obj === L.maxObjects - 1) pkg.limits.push(`interface-object scan: an object at index ${obj}, the last one asked`);
    }
  }

  // Element 0 (the current count), then the elements, as many per request as fit, within the
  // per-property byte budget.
  async function readValues(obj: number, pid: number, budget: number): Promise<void> {
    const count0 = await readProperty("scan", obj, pid, 0, 1, "device");
    if (!count0) return;
    if (count0.length !== 2) { rec({ step: "scan", space: "property", target: { object: obj, pid, start: 0 }, source: "device", outcome: "malformed", raw: hex(count0), detail: "element 0 is the element count, two octets" }); return; }
    const n = count0.readUInt16BE(0);
    if (n === 0) return;
    const first = await readProperty("scan", obj, pid, 1, 1, "device");
    if (!first) return;
    let per = Math.min(15, Math.max(1, Math.floor(budget / first.length)));
    let bytes = first.length;
    let start = 2;
    while (start <= n && bytes < L.propertyBytes) {
      const c = Math.min(per, n - start + 1);
      // A device may answer fewer elements than asked; the next request starts after the last it gave.
      const v = await readCounted("scan", obj, pid, start, c, "device");
      if (v) { bytes += v.value.length; start += v.count; continue; }
      // A batch that was not read is asked again one element at a time; a single element not read
      // ends the property (the GVS AMMA refuses every element past the first of some PIDs, hundreds).
      if (c > 1) { per = 1; continue; }
      if (start < n) rec({ step: "scan", space: "property", target: { object: obj, pid, start: start + 1, count: n - start }, source: "device", outcome: "not-attempted", detail: `element ${start} was not read (the record before says why); the rest of this property is not read` });
      return;
    }
    if (start <= n) {
      rec({ step: "scan", space: "property", target: { object: obj, pid, start, count: n - start + 1 }, source: "device", outcome: "not-attempted", detail: `per-property budget of ${L.propertyBytes} bytes reached` });
      pkg.limits.push(`object ${obj} PID ${pid}: ${L.propertyBytes}-byte property budget`);
    }
  }

  async function memoryPlan(plan: MaskPlan, loadStates: Map<number, number>): Promise<void> {
    const chunks = chunksOrWhy();
    if (typeof chunks === "string") {
      rec({ step: "memory", space: "memory", target: {}, source: "master-data", outcome: "not-attempted", detail: chunks });
      return;
    }
    const range = async (step: string, r: MemoryRange, source: RangeSource): Promise<Buffer | null> => {
      // A master-data resource is a location in its own right; anything else must lie in a declared segment.
      const why = r.address + r.length > 0x1000000
        ? `0x${r.address.toString(16)}+${r.length} lies outside the 24-bit address space of the memory services`
        : unreadableReason(plan.mask, r, source === "master-data" ? null : plan.segments);
      if (why) { rec({ step, space: "memory", target: { address: r.address, length: r.length }, source, outcome: "not-attempted", detail: why }); return null; }
      return readMemory(step, r, source, chunks);
    };
    for (const m of plan.memory) await range(m.name, m, m.source);
    for (const t of plan.tables) await table(t, loadStates, range);
  }

  async function table(t: TableStep, loadStates: Map<number, number>, range: (step: string, r: MemoryRange, source: RangeSource) => Promise<Buffer | null>): Promise<void> {
    if (t.kind === "property-pointer") {
      const step = t.name;
      const state = loadStates.get(t.object);
      if (state !== LOADED) {
        rec({ step, space: "memory", target: { object: t.object }, source: "device", outcome: "not-attempted", detail: state === undefined ? "its load state was not read" : `its load state is ${state}, not Loaded; a pointer means nothing then` });
        return;
      }
      const ptr = await readProperty(step, t.object, 7, 1, 1, "device");
      if (!ptr || ptr.length !== 4) { rec({ step, space: "memory", target: { object: t.object }, source: "device", outcome: "not-attempted", detail: "no 4-byte table reference (PID 7), so no start" }); return; }
      // The memory control block (PID 27) has one element per region of the table, each [length:4]
      // [flags:2][crc:2], the regions one behind the other from the table reference (two on the Theben
      // MIX 2 application, as its load procedure declares them). The table is their sum.
      const count = await readProperty(step, t.object, 27, 0, 1, "device");
      const regions = count?.length === 2 ? count.readUInt16BE(0) : 0;
      if (regions === 0 || regions > MAX_MCB_REGIONS) { rec({ step, space: "memory", target: { object: t.object }, source: "device", outcome: "not-attempted", detail: regions === 0 ? "no memory control block (PID 27), so the length is unknown" : `the memory control block (PID 27) declares ${regions} regions, more than the ${MAX_MCB_REGIONS} a table is read with` }); return; }
      let length = 0;
      for (let i = 1; i <= regions; i++) {
        const mcb = await readProperty(step, t.object, 27, i, 1, "device");
        if (!mcb || mcb.length !== 8) { rec({ step, space: "memory", target: { object: t.object }, source: "device", outcome: "not-attempted", detail: `memory control block (PID 27) element ${i} of ${regions} is not 8 bytes, so the length is unknown` }); return; }
        length += mcb.readUInt32BE(0);
      }
      const address = ptr.readUInt32BE(0);
      if (address === 0) { rec({ step, space: "memory", target: { object: t.object }, source: "device", outcome: "not-attempted", detail: "the table reference is 0: not loaded" }); return; }
      if (length === 0) { rec({ step, space: "memory", target: { object: t.object, address }, source: "device", outcome: "not-attempted", detail: "the memory control block gives size 0" }); return; }
      await range(step, { address, length }, "device");
      return;
    }
    const step = t.name;
    let address: number;
    if ("address" in t.at) address = t.at.address;
    else if ("property" in t.at) {
      const p = await readProperty(step, t.at.property.object, t.at.property.pid, 1, 1, "master-data");
      if (!p || p.length !== t.at.property.bytes) { rec({ step, space: "memory", target: { name: t.name }, source: "device", outcome: "not-attempted", detail: "its pointer property gave no usable address" }); return; }
      address = p.readUIntBE(0, p.length);
    } else {
      const p = await range(`${step} pointer`, { address: t.at.memory.address, length: t.at.memory.bytes }, "master-data");
      if (!p || p.length !== t.at.memory.bytes) { rec({ step, space: "memory", target: { name: t.name }, source: "device", outcome: "not-attempted", detail: "its pointer gave no usable address" }); return; }
      address = p.readUIntBE(0, p.length);
    }
    if (address === 0) { rec({ step, space: "memory", target: { name: t.name }, source: "device", outcome: "not-attempted", detail: "the pointer is 0: not loaded" }); return; }
    const head = await range(step, { address, length: 1 }, "device");
    if (!head || head.length !== 1) return;
    if (head[0] > 0) await range(step, { address: address + 1, length: head[0] * t.entryBytes }, "device");
  }

  // A range read in pieces. What the device gave and what it refused are both recorded; a request
  // that failed is recorded for its chunk and the read goes on after it.
  async function readMemory(step: string, r: MemoryRange, source: RangeSource, chunks: ReturnType<typeof transferChunks>): Promise<Buffer | null> {
    // The bytes are kept for the caller only for a range the budget can hold; a device-supplied length
    // must not size an allocation.
    const out = r.length <= L.memoryBytes ? Buffer.alloc(r.length) : null;
    let complete = true;
    let pos = r.address;
    const end = r.address + r.length;
    while (pos < end) {
      if (pkg.counts.memoryBytes >= L.memoryBytes) {
        rec({ step, space: end - 1 > 0xffff ? "memory-extended" : "memory", target: { address: pos, length: end - pos }, source, outcome: "not-attempted", detail: `memory budget of ${L.memoryBytes} bytes reached` });
        throw new PhaseLimit(`memory plan: ${L.memoryBytes} bytes`);
      }
      const len = Math.min(end - pos, L.memoryBytes - pkg.counts.memoryBytes);
      // memReadPartial takes the extended service for a request whose range passes 0xFFFF.
      const extended = pos + len - 1 > 0xffff;
      const space: RecordSpace = extended ? "memory-extended" : "memory";
      const chunk = extended ? chunks.extRead : chunks.classicRead;
      const res = await dev.memReadPartial(pos, len, { chunk, signal: opts.signal, beforeRequest });
      for (const p of res.pieces) {
        pkg.counts.memoryBytes += p.length;
        if ("bytes" in p) { rec({ step, space, target: { address: p.address, length: p.length }, source, outcome: "bytes", bytes: hex(p.bytes) }); if (out) p.bytes.copy(out, p.address - r.address); }
        else { complete = false; rec({ step, space, target: { address: p.address, length: p.length }, source, outcome: "refused", raw: p.refused }); }
      }
      // Any answer, refusals included, shows the device is there.
      if (res.pieces.length > 0) failures = 0;
      if (!res.stopped) { pos += len; continue; }
      complete = false;
      if (res.stopped.error instanceof PhaseLimit) {
        rec({ step, space, target: { address: res.stopped.address, length: end - res.stopped.address }, source, outcome: "not-attempted", detail: res.stopped.error.message });
        throw res.stopped.error;
      }
      if (res.stopped.error instanceof Stop) {
        rec({ step, space, target: { address: res.stopped.address, length: end - res.stopped.address }, source, outcome: "not-attempted", detail: res.stopped.error.message });
        throw res.stopped.error;
      }
      let f: Failure;
      try { f = classify(res.stopped.error); }
      catch (e) {
        rec({ step, space, target: { address: res.stopped.address, length: end - res.stopped.address }, source, outcome: "not-attempted", detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      const lost = Math.min(chunk, end - res.stopped.address);
      rec({ step, space, target: { address: res.stopped.address, length: lost }, source, outcome: f.outcome, detail: f.detail });
      pos = res.stopped.address + lost;
      try { await failed(); }
      catch (e) {
        if (pos < end) rec({ step, space, target: { address: pos, length: end - pos }, source, outcome: "not-attempted", detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }
    return complete && out ? out : null;
  }
}
