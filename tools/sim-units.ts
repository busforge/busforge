// The units tools/sim-unit.ts, tools/sim-unit-0701.ts and tools/sim-unit-0705.ts simulate, each from a read-only collection of a real
// unit and its product's application program in the private corpus, with what only the unit's captures show of it.
import { readFileSync } from "node:fs";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { SimUnit } from "./sim-unit.ts";
import type { CollectPackage } from "../packages/product/src/index.ts";
import { simUnitModel, type UnitBehaviour } from "./sim-unit-model.ts";
import { SimUnit0701, simUnit0701Model, type MemoryMappedBehaviour } from "./sim-unit-0701.ts";
import { SimUnit0705, simUnit0705Model } from "./sim-unit-0705.ts";

export interface SimUnitSpec {
  id: string;
  name: string;
  // The collection of the unit, relative to the corpus root, as the unit held its configuration before the
  // captures below; its mask selects the simulator.
  collection: string;
  catalogue: string;
  // The interface address the unit's captures ran through: the source of every frame the tool sent it.
  interfaceIa: number;
  // The maximum APDU the interface announced (cEMI server object 0 PID 56 over device management).
  interfaceMaxApdu: number;
  behaviour: UnitBehaviour;
  // A memory-mapped System 7 unit (MV-0701, tools/sim-unit-0701.ts): what only its captures show besides.
  memoryMapped?: MemoryMappedBehaviour;
}

// The MEAN WELL KNX-40E-1280D power supply (M-0162_A-0004-11-F245, MV-07B0), from the collection before ETS's
// downloads (captures/meanwell-unit-collect-vor.json). Its behaviour from the captures of ETS's six downloads
// (captures/meanwell-ets-*.log) and Busforge's full download (captures/meanwell-busforge-fulldownload.log),
// all but the two maxtemp ones through a KNX-USB stick behind Busforge's bridge at 1.1.100 announcing a maximum
// APDU of 40, the interface address and limit served here:
// - A_Restart: neither a layer-2 acknowledgement (the interface confirms it negatively, every capture) nor a
//   T_Ack; probes 0.38 s after it confirmed negatively, one 0.65 s after it positively; frames on the
//   connection the restart ended are dropped without T_Disconnect (Busforge's probes, the 4 s after them);
// - the free key (FFFFFFFF) grants access level 0 (ETS's A_Authorize_Request);
// - the interface confirmed a frame 21 ms after the request at the earliest, negatively after 74 to 95 ms.
export const MEANWELL_KNX40E: SimUnitSpec = {
  id: "meanwell-knx40e",
  name: "MEAN WELL KNX-40E-1280D",
  collection: "captures/meanwell-unit-collect-vor.json",
  catalogue: "M-0162_A-0004-11-F245.xml.gz",
  interfaceIa: 0x1164,
  interfaceMaxApdu: 40,
  behaviour: {
    restart: { acknowledged: false, linkDownMs: 500, deadConnection: "nothing" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 75 },
  },
};

// The ABB US/U 4.2 universal interface (M-0002_A-A001-13-63C2, MV-0701, memory-mapped load control), from the
// bench unit's collection before ETS's counter download (internal/captures/abb-counter-2026-11-20/). Its
// behaviour from ETS's downloads (captures/abb-usu-4.2-ets-*.log, internal/captures/abb-counter-2026-11-20/,
// abb-fresh-2026-11-20/) and Busforge's full download and address assignments
// (internal/captures/progmode-end-2026-11-19/e3-abb-busforge-fulldownload.log,
// restart-end-2026-11-19/a3-abb-ia-201to211.log, a4-abb-ia-211to201.log), all through a KNX-USB stick behind
// Busforge's bridge at 1.1.100:
// - A_Restart: confirmed by the interface and acknowledged with T_Ack; a frame sent up to 42 ms after it is
//   confirmed negatively, one 1.04 s after it positively, and one between is refused (no capture shows it);
//   numbered frames on the connection the restart ended are dropped without T_Disconnect (Busforge's probes);
// - the free key (FFFFFFFF) grants access level 0;
// - the interface confirmed a frame about 21 ms after the request, negatively after 70 to 90 ms;
// - no PID 56 (the unit answers it with no element; ETS negotiates 15, "restricted by ByTargetDevice"): its
//   longest frames, a 12-octet memory read and write, carry an APDU of 15 octets;
// - of the additional load controls at 0x0104, the absolute segment and the task segment, PEI type 80.
export const ABB_USU42: SimUnitSpec = {
  id: "abb-usu-4.2",
  name: "ABB US/U 4.2",
  collection: "internal/captures/abb-counter-2026-11-20/collect-1.1.201-before.json",
  catalogue: "M-0002_A-A001-13-63C2.xml.gz",
  interfaceIa: 0x1164,
  interfaceMaxApdu: 40,
  behaviour: {
    restart: { acknowledged: true, linkDownMs: 42, linkUpMs: 1040, deadConnection: "nothing" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 70 },
  },
  memoryMapped: { maxApdu: 15, additional: ["absolute-segment", "task-segment"], peiType: 0x80, tableReferenceFollows: false, addressTableCountOnDeclaration: null, clearedByRestart: new Map() },
};

// The Theben Meteodata 140 S weather station (M-0048_A-140C-14-EB70, MV-0701, memory-mapped load control), from
// the house unit's collection before ETS's downloads (collections/meteodata-140s-hc04-2026-10-07/). Its behaviour
// from ETS's downloads (captures/meteodata-140s-ets-*.log) and Busforge's (the same collection directory, its
// meteodata-busforge-*.log), through the house's KNXnet/IP interface, tunnel 1.1.254, which reported a maximum
// APDU of 210 to ETS (ETS6.log, InterfaceFeatures):
// - A_Restart: confirmed by the interface and acknowledged on layer 2, without T_Ack; a frame 41 ms after it
//   is confirmed positively; numbered frames on the connection the restart ended are dropped without
//   T_Disconnect (Busforge's probes);
// - the free key (FFFFFFFF) grants access level 0;
// - the interface confirmed a frame about 18 ms after the request; no capture shows it confirm one
//   negatively, so the negative confirmation of a frame to another address takes the bench stick's 70 ms (the
//   ABB US/U 4.2's entry);
// - no PID 56 (ETS: "Empty response; assuming 15");
// - of the additional load controls at 0x0104, the absolute segment, the task segment (PEI type 00) and task
//   control 1;
// - after a download, objects 1 and 2 report by PID 7 the address their table was declared at (Busforge's
//   verification reads, where the address equals the one collected);
// - after load-state machine 1 is unloaded and its segment declared again, the address table's count reads 01
//   (every ETS download that declares it reads it there; the ABB US/U 4.2 keeps its count);
// - the download marker P-2228 at 0x4800, written AA by every download, reads AA within the session and 00 in
//   the next one.
export const THEBEN_METEODATA_140S: SimUnitSpec = {
  id: "theben-meteodata-140s",
  name: "Theben Meteodata 140 S",
  collection: "collections/meteodata-140s-hc04-2026-10-07/1.1.24-meteodata-collect-vor.json",
  catalogue: "M-0048_A-140C-14-EB70.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: 210,
  behaviour: {
    restart: { acknowledged: true, transportAck: false, linkDownMs: 0, deadConnection: "nothing" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 18, nakMs: 70 },
  },
  memoryMapped: { maxApdu: 15, additional: ["absolute-segment", "task-segment", "task-control-1"], peiType: 0x00, tableReferenceFollows: true, addressTableCountOnDeclaration: 0x01, clearedByRestart: new Map([[0x4800, 0x00]]) },
};

// The MDT BE-02001.02 binary input (M-0083_A-00B6-32-9642, MV-0705), from a collection taken after every capture
// below (internal/captures/cap-1004/mdt-plain.json): its starting state is that later collection's, not the
// unit's before a capture, for which no collection exists. ETS's full downloads read no memory and nothing the
// downloads between them change (identity, PID 56, the device control after the unloads), so their replays do
// not depend on it. Its behaviour from ETS's three full downloads
// (captures/mdt-be02001-ets-fulldownload-{defaults,linked,b7}.log) and Busforge's address assignment with its
// restart (internal/captures/restart-end-2026-11-19/a2-mdt-ia-66to56.log), through a KNX-USB stick behind
// Busforge's bridge at 1.1.100, which announces a maximum APDU of 40 (ETS6.log of the unit's partial downloads,
// "InterfaceFeatures"):
// - it refuses PID 56, and takes the 15-octet APDUs ETS sends it ("assuming 15", the same logs);
// - A_Restart: acknowledged on layer 2, without T_Ack, in every capture; a frame 42 ms after the restart request
//   not acknowledged, one 1.04 s after it acknowledged (the assignment), between them none shown; what it
//   answers a numbered frame on the connection the restart ended is not shown. The windows are the captures',
//   from the request; on the wall clock the simulator counts from when its line took the restart, `link.ackMs`
//   later, as for the ABB US/U 4.2 above;
// - in programming mode at the first full download (it answers ETS's A_IndividualAddress_Read), and out of it
//   after a restart (no answer in the second, nor after the assignment's restart); its
//   A_IndividualAddressSerialNumber_Response carries four zero octets after the serial (the second);
// - the free key grants access level 0;
// - the interface confirmed a frame 20 to 35 ms after the request, negatively about 70 ms after it (the
//   assignment).
export const MDT_BE02001: SimUnitSpec = {
  id: "mdt-be02001",
  name: "MDT BE-02001.02",
  collection: "internal/captures/cap-1004/mdt-plain.json",
  catalogue: "M-0083_A-00B6-32-9642.xml.gz",
  interfaceIa: 0x1164,
  interfaceMaxApdu: 40,
  behaviour: {
    restart: { acknowledged: true, transportAck: false, linkDownMs: 43, linkUpMs: 1043, deadConnection: "unknown" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 70 },
    programmingMode: true,
    serialNumberResponseTail: Buffer.alloc(4),
    maxApdu: 15,
  },
};

// The Gira Tastsensor 3 Komfort 3fach (M-0008_A-10D7-11-2783-O000A, MV-0705), from the collection before ETS's
// full download (collections/gira-m0008-backup-2026-10-05/1.1.1-gira-m0008-collect.json). Its behaviour from
// that download (captures/gira-m0008-ets-fulldownload.log, with its ETS6.log) and Busforge's full download
// (collections/gira-m0008-busforge-fulldownload-2026-10-07/gira-m0008-busforge-fulldownload-20261007-004213.log),
// both through a KNXnet/IP interface at 1.1.254 announcing a maximum APDU of 210:
// - it refuses PID 56, and takes the 15-octet APDUs ETS sends it ("assuming 15");
// - it answers a memory read into a segment that is loading with the bytes written there since its load
//   (Busforge's read-backs);
// - A_Restart: acknowledged on layer 2, without T_Ack; a frame 41 or 42 ms after the restart request not
//   acknowledged, one 312 to 315 ms after it acknowledged, between them none shown; numbered frames on the
//   connection the restart ended acknowledged and left without an answer (the probes of Busforge's full
//   download and of its four flashes in collections/gira-m0008-busforge-flashes-2026-10-07), the windows on the
//   clock the MDT's above are;
// - the free key grants access level 0;
// - the interface confirmed a frame 18 to 40 ms after the request, negatively about 70 ms after it (Busforge's
//   first probe), 75 ms on the MEAN WELL above (its two maxtemp downloads).
export const GIRA_TS3: SimUnitSpec = {
  id: "gira-ts3",
  name: "Gira Tastsensor 3 Komfort 3fach",
  collection: "collections/gira-m0008-backup-2026-10-05/1.1.1-gira-m0008-collect.json",
  catalogue: "M-0008_A-10D7-11-2783-O000A.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: 210,
  behaviour: {
    restart: { acknowledged: true, transportAck: false, linkDownMs: 43, linkUpMs: 312, deadConnection: "nothing" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 70 },
    maxApdu: 15,
    readsWhileLoading: true,
  },
};

export const SIM_UNITS: readonly SimUnitSpec[] = [MEANWELL_KNX40E, ABB_USU42, THEBEN_METEODATA_140S, MDT_BE02001, GIRA_TS3];

export function simUnitSpec(id: string): SimUnitSpec {
  const spec = SIM_UNITS.find((u) => u.id === id);
  if (!spec) throw new Error(`no simulated unit "${id}"; there are: ${SIM_UNITS.map((u) => u.id).join(", ")}`);
  return spec;
}

type SimOpts = ConstructorParameters<typeof SimUnit>[2];

// The spec's unit as `collectionPath` shows it: its own collection, or another collection of the same unit (the
// same address and serial), taken at another time.
function collectionOf(spec: SimUnitSpec, collectionPath: string): CollectPackage {
  const read = (path: string) => JSON.parse(readFileSync(corpusPath(path), "utf8")) as CollectPackage;
  const c = read(collectionPath);
  if (collectionPath === spec.collection) return c;
  const serial = (x: CollectPackage) => x.records.find((r) => {
    const t = r.target as { object?: number; pid?: number; start?: number };
    return r.space === "property" && r.outcome === "bytes" && t.object === 0 && t.pid === 11 && (t.start ?? 1) === 1;
  })?.bytes;
  const own = read(spec.collection);
  if (c.ia !== own.ia || !serial(c) || serial(c) !== serial(own)) throw new Error(`no simulated unit: ${collectionPath} is not a collection of the unit of ${spec.collection} (address ${c.ia}, serial ${serial(c) ?? "not read"})`);
  return c;
}

// A fresh unit as its collection shows it (another collection of the same unit where one is named).
export function newSimUnit(spec: SimUnitSpec, opts: SimOpts = {}, behaviour: Partial<UnitBehaviour> = {}, collectionPath = spec.collection): SimUnit {
  if (spec.memoryMapped) return newSimUnit0701(spec, opts, behaviour, collectionPath);
  const collection = collectionOf(spec, collectionPath), b = { ...spec.behaviour, ...behaviour }, xml = catalogueXml(spec.catalogue);
  if (collection.mask === "MV-0705") return new SimUnit0705(simUnit0705Model(collection, xml, b), spec.interfaceIa, opts);
  return new SimUnit(simUnitModel(collection, xml, b), spec.interfaceIa, opts);
}

// The same for a memory-mapped System 7 unit, refused for a spec of another.
export function newSimUnit0701(spec: SimUnitSpec, opts: SimOpts = {}, behaviour: Partial<UnitBehaviour> = {}, collectionPath = spec.collection): SimUnit0701 {
  if (!spec.memoryMapped) throw new Error(`${spec.id} is not a memory-mapped System 7 unit`);
  return new SimUnit0701(simUnit0701Model(collectionOf(spec, collectionPath), catalogueXml(spec.catalogue), { ...spec.behaviour, ...behaviour }, spec.memoryMapped), spec.interfaceIa, opts);
}
