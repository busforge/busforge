import { maskInfo, sameMask } from "./masks.ts";
import type { CfgAbsSegment } from "./appconfig.ts";

// What raw acquisition reads from a device of a given mask, before the first request after the
// descriptor (docs/raw-acquisition.md, "The generic stage" and "Per memory model"). Every location
// here is a master-data resource or a declared memory segment of that mask, checked against ETS 6
// master data version 298; a range the device itself reports (PID 7, PID 27, a table's count byte) is
// a `table` step, resolved while the plan runs.

export type RangeSource = "master-data" | "device" | "product-xml";

export interface MemoryRange { address: number; length: number }

// A table whose start comes from the device and whose length from its own header or memory control
// block.
export type TableStep =
  // System B: start = PID 7 (4 bytes), length = size field of PID 27, read only while PID 5 is Loaded.
  | { kind: "property-pointer"; object: number; name: string }
  // A count-prefixed table: start fixed or behind a pointer, first byte the entry count, then
  // `entryBytes` per entry.
  | { kind: "counted"; name: string; at: { address: number } | { property: { object: number; pid: number; bytes: number } } | { memory: { address: number; bytes: number } }; entryBytes: number };

export interface MaskPlan {
  mask: string;
  family: string;
  // The mask declares AuthorizeLevels; only then is the free key sent.
  authorize: boolean;
  // declared: the mask has interface objects. probe: unknown, one description request decides.
  // none: requests the device does not implement cost a timeout each, so nothing is asked but
  // what maxApduAlone names.
  objects: "declared" | "probe" | "none";
  // Object 0 identity properties.
  identity: boolean;
  // PID 56 of object 0 (maximum APDU length) is read on every plan with declared objects; set, also
  // on a plan without them, before its memory step: a secured memory read fits no standard frame.
  maxApduAlone: boolean;
  // Interface object carrying the application id (PID 13).
  applicationObject: number | null;
  // Other property values the master data names as resources (pointers, stamps).
  properties: { object: number; pid: number; name: string }[];
  // Load states read as PID 5 of these objects.
  loadStateObjects: number[];
  memory: (MemoryRange & { name: string; source: RangeSource })[];
  tables: TableStep[];
  // Declared memory segments a range must lie in; null where the device allocates them at runtime.
  segments: MemoryRange[] | null;
  // The security-mode read (System B only, last request of the session).
  securityModeLast: boolean;
  notAttempted: { name: string; reason: string; space?: "memory" | "property" }[];
}

// The masks whose master data declares AuthorizeLevels.
const AUTHORIZE = new Set(["MV-0020", "MV-0021", "MV-0025", "MV-0310", "MV-0700", "MV-0701", "MV-0705", "MV-07B0", "MV-0912", "MV-1310", "MV-17B0", "MV-2705", "MV-27B0", "MV-2920", "MV-5705", "MV-57B0"]);

// Locations whose master-data read access is None and that no readable resource covers. On these
// masks the 12-byte load control at 0x0104 is one; on MV-0700 the run controls at 0x0101 and 0x0102
// share their bytes with the readable run statuses, so a one-byte read of exactly that byte is the
// status and allowed, anything wider is not.
const UNREADABLE: Record<string, { address: number; length: number; exactReadAllowed?: boolean }[]> = {
  "MV-0700": [{ address: 0x0104, length: 12 }, { address: 0x0101, length: 1, exactReadAllowed: true }, { address: 0x0102, length: 1, exactReadAllowed: true }],
  "MV-0701": [{ address: 0x0104, length: 12 }],
  "MV-0705": [{ address: 0x0104, length: 12 }],
  "MV-5705": [{ address: 0x0104, length: 12 }],
};

// Why a range may not be read on this mask, or null when it may.
export function unreadableReason(mask: string, r: MemoryRange, segments: MemoryRange[] | null): string | null {
  const end = r.address + r.length;
  for (const u of UNREADABLE[mask] ?? []) {
    const overlaps = r.address < u.address + u.length && u.address < end;
    if (overlaps && !(u.exactReadAllowed && r.address === u.address && r.length === u.length)) {
      return `overlaps 0x${u.address.toString(16)}+${u.length}, a location the master data marks unreadable (read access None)`;
    }
  }
  if (segments) {
    // Covered byte by byte by declared segments; adjacent ones (0x4000+8192 and 0x6000 on M112) join.
    let at = r.address;
    for (const s of [...segments].sort((x, y) => x.address - y.address)) {
      if (s.address <= at && at < s.address + s.length) at = s.address + s.length;
    }
    if (at < end) return `0x${r.address.toString(16)}+${r.length} lies outside every memory segment the mask declares`;
  }
  return null;
}

const M112_SEGMENTS: MemoryRange[] = [{ address: 0x4000, length: 8192 }, { address: 0x6000, length: 22016 }, { address: 0xb800, length: 2048 }];
// On the TP and IP M112 masks the four load statuses are memory bytes (address table, association
// table, application, PEI program).
const M112_LOAD_STATUS = { address: 0xb6ea, length: 4, name: "load statuses (address table, association table, application, PEI program)", source: "master-data" as const };

const GA_TABLE_0X4000: TableStep = { kind: "counted", name: "group address table", at: { address: 0x4000 }, entryBytes: 2 };
const ASSOC_BY_PROPERTY: TableStep = { kind: "counted", name: "association table", at: { property: { object: 2, pid: 7, bytes: 2 } }, entryBytes: 2 };

const base = (mask: string, family: string): MaskPlan => ({
  mask, family, authorize: AUTHORIZE.has(mask), objects: "probe", identity: false, maxApduAlone: false, applicationObject: null,
  properties: [], loadStateObjects: [], memory: [], tables: [], segments: null, securityModeLast: false, notAttempted: [],
});

// The project's application program for the device, or why there is none to use.
export type CollectApp = { mask: string; absoluteSegments: CfgAbsSegment[] } | { unavailable: string };

// The plan for a device that answered `mask`. On M112 the project's application program alone places
// the com-object table and the parameter segments, and only if it is for the mask the device answered.
export function planForMask(mask: string, app?: CollectApp | null): MaskPlan {
  const info = maskInfo(mask);
  const p = base(info.mask, info.family);
  const m = info.mask;
  switch (info.family) {
    case "system-b": {
      p.objects = "declared"; p.identity = true; p.applicationObject = 4;
      p.properties.push({ object: 5, pid: 13, name: "PEI program id" });
      p.loadStateObjects = [1, 2, 3, 4, 5];
      const names = ["group address table", "association table", "group object table", "application", "PEI program"];
      p.tables = names.map((name, i) => ({ kind: "property-pointer" as const, object: i + 1, name }));
      p.securityModeLast = true;
      return p;
    }
    case "system-7": {
      p.segments = M112_SEGMENTS;
      if (m === "MV-0700") {
        // Everything is memory; no interface object is declared.
        p.objects = "probe";
        p.memory.push(
          { address: 0xb6e5, length: 5, name: "application id", source: "master-data" },
          { address: 0xb6e0, length: 5, name: "PEI program id", source: "master-data" },
          { address: 0xb607, length: 9, name: "order id", source: "master-data" },
          { address: 0xb61a, length: 6, name: "serial number", source: "master-data" },
          { address: 0x0101, length: 1, name: "application run status", source: "master-data" },
          { address: 0x0102, length: 1, name: "PEI program run status", source: "master-data" },
          M112_LOAD_STATUS,
        );
        p.tables = [GA_TABLE_0X4000, { kind: "counted", name: "association table", at: { memory: { address: 0xb6f8, bytes: 2 } }, entryBytes: 2 }];
      } else {
        p.objects = "declared"; p.identity = true; p.applicationObject = 3;
        p.properties.push({ object: 4, pid: 13, name: "PEI program id" });
        if (m !== "MV-0701") for (const o of [1, 2, 3, 4]) p.properties.push({ object: o, pid: 27, name: `stamp of object ${o}` });
        if (m === "MV-2705") p.loadStateObjects = [1, 2, 3, 4];
        else p.memory.push(M112_LOAD_STATUS);
        p.tables = [GA_TABLE_0X4000, ASSOC_BY_PROPERTY];
      }
      p.notAttempted.push({ name: "group object table", reason: "the master data gives it no location (AddressSpace None)" });
      const appWhy = !app ? "only the product XML places them, and the project holds none for this device"
        : "unavailable" in app ? `only the product XML places them, and the project's cannot be used: ${app.unavailable}`
        : !sameMask(app.mask, m) ? `the project's application program is for ${app.mask}, the device answered ${m}`
        : app.absoluteSegments.length === 0 ? "the project's application program declares no absolute segment" : null;
      if (appWhy || !app || "unavailable" in app) p.notAttempted.push({ name: "application segments", reason: appWhy ?? "" });
      else for (const s of app.absoluteSegments) p.memory.push({ address: s.address, length: s.size, name: `application segment ${s.id}`, source: "product-xml" });
      return p;
    }
    case "system-1": {
      // No interface objects, no AuthorizeLevels: a request the device does not implement costs a
      // timeout. The EEPROM segment holds every resource but the run status; on BCU1 the table
      // pointers are one byte added to 0x0100, so the tables lie inside it.
      p.objects = "none";
      // The one property read: an IP interface that reports this mask (the house's MDT SCN-IP000.03)
      // answers secured property reads, and without a maximum APDU no secured memory read is sent. A
      // real BCU1 is not expected to answer it (inferred), which costs one unanswered request with its
      // retries and a reopened link.
      p.maxApduAlone = true;
      p.segments = [{ address: 0x0060, length: 1 }, { address: 0x0100, length: 256 }];
      p.memory.push(
        { address: 0x0060, length: 1, name: "run status and programming mode", source: "master-data" },
        { address: 0x0100, length: 256, name: "EEPROM segment", source: "master-data" },
      );
      return p;
    }
    case "system-2": {
      p.objects = "declared"; p.identity = true; p.applicationObject = 3;
      for (const o of [1, 2, 3]) p.properties.push({ object: o, pid: 7, name: `table pointer of object ${o}` });
      p.loadStateObjects = [1, 2, 3];
      p.segments = [{ address: 0x0100, length: 880 }];
      p.memory.push({ address: 0x0100, length: 880, name: "EEPROM segment", source: "master-data" });
      p.notAttempted.push({ name: "tables outside the EEPROM segment", reason: "a table pointer gives a start but no length; only the declared segment is read" });
      return p;
    }
    case "system-300": {
      p.objects = "declared"; p.identity = true;
      p.properties.push({ object: 0, pid: 72, name: "management descriptor" });
      p.notAttempted.push({ name: "variant resources and memory", reason: "the System 300 variant plans (MV-0300-0100…) are not implemented; see docs/roadmap.md" });
      return p;
    }
    case "coupler":
      if (m === "MV-0900" || m === "MV-0910" || m === "MV-0911") {
        p.objects = "none";
        p.segments = [{ address: 0x010d, length: 1 }, { address: 0x0119, length: 4 }];
        p.memory.push(
          { address: 0x010d, length: 1, name: "run error", source: "master-data" },
          { address: 0x0119, length: 4, name: "LcMode, LcError, LcConfig, LcGrpConfig", source: "master-data" },
        );
      }
      p.notAttempted.push({ name: "filter table", reason: "it lies in the LcFilterMemory address space, and no capture shows how a tool reads it" });
      return p;
    case "media-coupler":
      if (m === "MV-1900") {
        p.objects = "none";
        p.segments = [{ address: 0x4000, length: 30208 }];
        p.memory.push(
          { address: 0x510d, length: 2, name: "group configuration", source: "master-data" },
          { address: 0x4003, length: 4096, name: "filter table", source: "master-data" },
        );
      } else {
        p.objects = "declared";
        p.notAttempted.push({ name: "filter table", reason: "it is relative memory behind the router object, a plan not implemented; see docs/roadmap.md" });
        p.notAttempted.push({ space: "property", name: "discovery by PID_IO_LIST", reason: "not implemented; the objects are scanned by index instead; see docs/roadmap.md" });
      }
      return p;
    case "interface": case "rf": case "ir-decoder": case "dummy": case "unknown":
      // Interfaces, RF-only, IR decoders, dummy and unknown masks: the descriptor, then properties
      // only if the device answers a property description.
      return p;
  }
}
