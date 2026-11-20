// The units tools/sim-unit.ts and tools/sim-unit-0701.ts simulate, each from a read-only collection of a real
// unit and its product's application program in the private corpus, with what only the unit's captures show of it.
import { readFileSync } from "node:fs";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { SimUnit } from "./sim-unit.ts";
import type { CollectPackage } from "../packages/product/src/index.ts";
import { simUnitModel, type SystemBBehaviour, type UnitBehaviour } from "./sim-unit-model.ts";
import { SimUnit0701, simUnit0701Model, type MemoryMappedBehaviour } from "./sim-unit-0701.ts";

interface SimUnitSpecBase {
  id: string;
  name: string;
  // The collection of the unit, relative to the corpus root, as the unit held its configuration before the
  // captures below (where the captures found it in another state, `behaviour.stateInCaptures` gives their answers).
  collection: string;
  catalogue: string;
  // The interface address the unit's captures ran through: the source of every frame the tool sent it.
  interfaceIa: number;
  // The maximum APDU the interface announced (cEMI server object 0 PID 56 over device management, or the
  // tunnelling DIB of its search response); a longer frame it confirmed negatively without sending it.
  interfaceMaxApdu: number;
}

// A System B unit, or a memory-mapped System 7 unit (MV-0701, tools/sim-unit-0701.ts) with what only its captures
// show besides.
export type SimUnitSpec = SimUnitSpecBase & ({ behaviour: SystemBBehaviour; memoryMapped?: undefined } | { behaviour: UnitBehaviour; memoryMapped: MemoryMappedBehaviour });

// Busforge's bench bridge at 1.1.100 (a KNX-USB stick), which the Jung's and the GVS's captures ran through
// announcing a maximum APDU of 40: it confirmed their frames longer than that negatively within 2 to 4 ms,
// without sending them (the simulator confirms them after the unit's `link.nakMs`: timing only). It reports the
// type of a long frame, which the house's KNXnet/IP interface does not.
export const BENCH_BRIDGE = { ia: 0x1164, maxApdu: 40 } as const;

// The MEAN WELL KNX-40E-1280D power supply (M-0162_A-0004-11-F245, MV-07B0), from the collection before ETS's
// downloads (captures/meanwell-unit-collect-vor.json). Its behaviour from the captures of ETS's six downloads
// (captures/meanwell-ets-*.log) and Busforge's full download (captures/meanwell-busforge-fulldownload.log),
// all but the two maxtemp ones through a KNX-USB stick behind Busforge's bridge at 1.1.100 announcing a maximum
// APDU of 40, the interface address and limit served here:
// - A_Restart: neither a layer-2 acknowledgement (the interface confirms it negatively, every capture) nor a
//   T_Ack; probes 0.38 s after it confirmed negatively, one 0.65 s after it positively, the line taken back
//   at 0.5 s between them (Busforge's restart proof probes at about those times: a window refusing them would
//   leave its download test to the scheduler of a loaded machine); frames on the connection the restart
//   ended are dropped without T_Disconnect (Busforge's probes, the 4 s after them);
// - the free key (FFFFFFFF) grants access level 0 (ETS's A_Authorize_Request);
// - the interface confirmed a frame 21 ms after the request at the earliest, negatively after 74 to 95 ms;
// - its device control (PID 14) reads 0 before a download, 1 after the application is unloaded and 5 with
//   verify mode, 0 again after the restart;
// - a description read by PID is answered with the property's own index (object 2's PID 23 at index 3).
export const MEANWELL_KNX40E: SimUnitSpec = {
  id: "meanwell-knx40e",
  name: "MEAN WELL KNX-40E-1280D",
  collection: "captures/meanwell-unit-collect-vor.json",
  catalogue: "M-0162_A-0004-11-F245.xml.gz",
  interfaceIa: BENCH_BRIDGE.ia,
  interfaceMaxApdu: BENCH_BRIDGE.maxApdu,
  behaviour: {
    restart: { basic: { acknowledged: false, tAck: "never" }, line: [{ atMs: 0, up: false }, { atMs: 499, up: false }, { atMs: 500, up: true }], deadConnection: "nothing", confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 75 },
    unloadStopsApplication: true,
    memoryExtendedWrite: false,
    descriptionIndex: "property",
    clearsAfterRestart: [],
    shownWrites: new Map(),
  },
};

// The house's KNXnet/IP interface the Theben, OpenKNX and the MEAN WELL's maxtemp captures ran through: tunnels 1.1.253 to
// 1.1.255, a maximum APDU of 210 in its search response's tunnelling DIB; it confirmed a frame 16 ms after the
// request at the earliest, negatively after 63 ms (the Theben DALI-Gateway's captures, the only ones with a
// negative confirmation through it).
const HOUSE_INTERFACE = { maxApdu: 210, link: { ackMs: 16, nakMs: 63 } } as const;

// The Theben DALI-Gateway KNX plus (M-0048_A-9071-20-F258-O00EF, MV-07B0), from the collection before ETS's
// downloads (captures/dali-gateway-unit-collect-vor.json). Its behaviour from ETS's six captures in the order they
// ran on it (captures/dali-ets-fulldownload.log, -partial-params, -partial-links, -partial-revert, -unload,
// -fulldownload-real), through the house's interface:
// - A_Restart: acknowledged on layer 2 in every capture; a T_Ack before it where only the tables were loaded since
//   the last restart (-fulldownload, which ran differential, and -partial-links), none where the application's
//   load-state machine was (-partial-params, -partial-revert, -fulldownload-real); a T_Disconnect 1058 and 1071 ms
//   after it confirmed negatively, 2992 to 2998 ms after it positively; nothing on the connection it ended;
// - the free key (FFFFFFFF) grants access level 0;
// - its device control (PID 14) reads 0 after the application is unloaded (-partial-params, -partial-revert,
//   -fulldownload-real), not 1;
// - a description read by PID is answered with the request's index (object 2's PID 23 at index 0; its own is 3);
// - ETS's unload writes its programming mode (object 0 PID 54) 00, echoed;
// - its memory-control blocks report 01 33 between size and CRC for the three tables, 00 33 for the application.
export const THEBEN_DALI_GATEWAY: SimUnitSpec = {
  id: "theben-dali-gateway",
  name: "Theben DALI-Gateway KNX plus",
  collection: "captures/dali-gateway-unit-collect-vor.json",
  catalogue: "M-0048_A-9071-20-F258-O00EF.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: HOUSE_INTERFACE.maxApdu,
  behaviour: {
    restart: { basic: { acknowledged: true, tAck: "unless-application-loaded" }, line: [{ atMs: 1058, up: false }, { atMs: 1071, up: false }, { atMs: 2992, up: true }], deadConnection: null, confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: HOUSE_INTERFACE.link,
    unloadStopsApplication: false,
    memoryExtendedWrite: false,
    descriptionIndex: "request",
    clearsAfterRestart: [],
    shownWrites: new Map([["0/54 00", Buffer.from([0x00])]]),
  },
};

// The OpenKNX RaumController (M-00FA_A-A012-55-0000, MV-07B0), from the collection before ETS's downloads
// (captures/openknx-unit-collect-vor.json). Its behaviour from ETS's four captures in the order they ran on it
// (captures/openknx-ets-fulldownload.log, -partial-params, -partial-links, -partial-revert), through the house's
// interface:
// - A_Restart: acknowledged on layer 2, no T_Ack (every capture); a T_Disconnect 2864 to 2992 ms after it
//   confirmed positively; nothing on the connection it ended;
// - the free key (FFFFFFFF) grants access level 0;
// - memory is written with A_MemoryExtended_Write, answered with return code 0;
// - a description read by PID is answered with the property's own index (object 2's PID 23 at index 1);
// - its memory-control blocks held no element when it was collected; after the application's load completed
//   it reports size, 00 FF and the CRC-16/CCITT over the segment with the 16 zero bits appended (object 4's
//   PID 27 in -fulldownload);
// - the unload of object 5's load state, which it did not describe and whose read it refused, is answered
//   without elements;
// - what its device control reads after the application is unloaded none of them shows.
export const OPENKNX_RAUMCONTROLLER: SimUnitSpec = {
  id: "openknx-raumcontroller",
  name: "OpenKNX RaumController",
  collection: "captures/openknx-unit-collect-vor.json",
  catalogue: "M-00FA_A-A012-55-0000.xml.gz",
  interfaceIa: 0x11fd,
  interfaceMaxApdu: HOUSE_INTERFACE.maxApdu,
  behaviour: {
    restart: { basic: { acknowledged: true, tAck: "never" }, line: [{ atMs: 2864, up: true }], deadConnection: null, confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: HOUSE_INTERFACE.link,
    unloadStopsApplication: null,
    memoryExtendedWrite: true,
    descriptionIndex: "property",
    clearsAfterRestart: [],
    shownWrites: new Map([["5/5 04000000000000000000", Buffer.alloc(0)]]),
    mcb: { control: "00ff", crc: "ccitt" },
  },
};

// The Theben MIX 2 HMG 6 T (M-0048_A-493B-21-B471, MV-07B0), from the collection before ETS's downloads
// (captures/mix2-hmg6t-unit-collect-vor.json). Its behaviour from ETS's six captures in the order they ran on it
// (captures/mix2-hmg6t-ets-fulldownload.log, -partial-params, -partial-links, -partial-revert, -partial-diag-on,
// -partial-diag-off), through the house's interface:
// - a master reset with erase code 1 (confirmed restart) is answered with A_Restart_Response, process time 1 s;
//   ETS's T_Disconnect 22 to 41 ms after the response's T_Ack confirmed positively; no basic restart, and no
//   frame on the connection the restart ended;
// - the free key (FFFFFFFF) grants access level 0;
// - a description read by PID is answered with the property's own index (object 2's PID 23 at index 3);
// - after its restart it clears P-199 "A_Download erfolgt" (bit 7 of octet 39 of the application segment),
//   which every full and parameter download sets: the CRC of the first block of object 4's memory-control
//   block it reports at the start of the next download is over the cleared bit;
// - what its device control reads after the application is unloaded none of them shows.
export const THEBEN_MIX2_HMG6T: SimUnitSpec = {
  id: "theben-mix2-hmg6t",
  name: "Theben MIX 2 HMG 6 T",
  collection: "captures/mix2-hmg6t-unit-collect-vor.json",
  catalogue: "M-0048_A-493B-21-B471.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: HOUSE_INTERFACE.maxApdu,
  behaviour: {
    restart: { basic: null, line: [{ atMs: 22, up: true }], deadConnection: null, confirmedRestartSeconds: 1 },
    authorize: new Map([["ffffffff", 0]]),
    link: HOUSE_INTERFACE.link,
    unloadStopsApplication: null,
    memoryExtendedWrite: true,
    descriptionIndex: "property",
    clearsAfterRestart: [{ lsm: 4, offset: 39, mask: 0x80, from: 0x80, to: 0x00 }],
    shownWrites: new Map(),
  },
};

// The Jung 400021SE (M-0004_A-7072-21-99A7-O000A, MV-07B0). Its only collection was taken after the unit was
// switched to Data Secure, in a later configuration (captures/jung-400021se-unit-collect-secure.json); its ETS
// full download is plain (captures/jung-400021se-ets-fulldownload.log, through the bench bridge). What that
// capture found different from the collection is taken from it: the security mode 00 00 (plain), the
// application's load state 3 (error). Its behaviour from the capture:
// - a master reset with erase code 1 (confirmed restart) is answered with A_Restart_Response, process time 0;
//   ETS's T_Disconnect 26 and 29 ms after the response's T_Ack confirmed negatively, its T_Connect 1279 ms
//   after positively; no basic restart, and no frame on the connection the restart ended;
// - a connection idle for 6 s is closed by the unit with T_Disconnect (twice, while the bridge refused ETS's
//   64-octet writes);
// - the free key (FFFFFFFF) grants access level 0;
// - the bridge confirmed a frame 21 ms after the request at the earliest, negatively after 68 to 69 ms;
// - after its restart the one-byte second block of the application segment (octet 7700), which every ETS
//   download writes 01, reads 00: the block's CRC at the start of ETS's next download
//   (captures/jung-400021se-ets-partial-links.log) is over 00; another value there no capture shows;
// - a description read by PID is answered with the property's own index (object 2's PID 23 at index 3);
// - what its device control reads after the application is unloaded it does not show.
export const JUNG_400021SE: SimUnitSpec = {
  id: "jung-400021se",
  name: "Jung 400021SE",
  collection: "captures/jung-400021se-unit-collect-secure.json",
  catalogue: "M-0004_A-7072-21-99A7-O000A.xml.gz",
  interfaceIa: BENCH_BRIDGE.ia,
  interfaceMaxApdu: BENCH_BRIDGE.maxApdu,
  behaviour: {
    restart: { basic: null, line: [{ atMs: 26, up: false }, { atMs: 29, up: false }, { atMs: 1279, up: true }], deadConnection: null, confirmedRestartSeconds: 0 },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 21, nakMs: 68 },
    unloadStopsApplication: null,
    memoryExtendedWrite: true,
    descriptionIndex: "property",
    clearsAfterRestart: [{ lsm: 4, offset: 7700, mask: 0xff, from: 0x01, to: 0x00 }],
    shownWrites: new Map(),
    stateInCaptures: { properties: { "4/5": "03" }, functionStates: { "17/1/51 0000": "0000" } },
  },
};

// The GVS AMMA-04/06.S (M-0085_A-0072-30-69AA, MV-07B0). Its only collections were taken after the unit was
// switched to Data Secure (captures/gvs-amma-unit-collect-secure.json); its ETS full download at the
// application's defaults is plain (captures/gvs-amma-ets-fulldownload-defaults.log, through the bench bridge).
// What that capture found different from the collection is taken from it: the security mode 00 00 (plain). Its
// behaviour from the capture:
// - a master reset with erase code 1 (confirmed restart) is answered with A_Restart_Response, process time 0;
//   ETS's T_Disconnect 24 ms after the response's T_Ack confirmed positively, its T_Connect and descriptor read
//   1215 and 1289 ms after negatively, its T_Disconnect 4292 ms after positively; no basic restart, and no frame
//   on the connection the restart ended;
// - the free key (FFFFFFFF) grants access level 0;
// - the bridge confirmed a frame 20 ms after the request at the earliest, negatively after 71 to 77 ms;
// - a description read by PID is answered with the property's own index (object 2's PID 23 at index 3);
// - a write of 01 to object 4's PID 67, whose read it refused, is echoed;
// - what its device control reads after the application is unloaded it does not show.
export const GVS_AMMA: SimUnitSpec = {
  id: "gvs-amma",
  name: "GVS AMMA-04/06.S",
  collection: "captures/gvs-amma-unit-collect-secure.json",
  catalogue: "M-0085_A-0072-30-69AA.xml.gz",
  interfaceIa: BENCH_BRIDGE.ia,
  interfaceMaxApdu: BENCH_BRIDGE.maxApdu,
  behaviour: {
    restart: { basic: null, line: [{ atMs: 24, up: true }, { atMs: 1215, up: false }, { atMs: 1289, up: false }, { atMs: 4292, up: true }], deadConnection: null, confirmedRestartSeconds: 0 },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 74 },
    unloadStopsApplication: null,
    memoryExtendedWrite: true,
    descriptionIndex: "property",
    clearsAfterRestart: [],
    shownWrites: new Map([["4/67 01", Buffer.from([0x01])]]),
    stateInCaptures: { properties: {}, functionStates: { "17/1/51 0000": "0000" } },
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
//   confirmed negatively (42 ms: a3-abb-ia-201to211.log, a4-abb-ia-211to201.log), one 1.04 s after it
//   positively, and one between is refused (no capture shows it);
//   numbered frames on the connection the restart ended are dropped without T_Disconnect (Busforge's probes);
// - the free key (FFFFFFFF) grants access level 0;
// - the interface confirmed a frame about 21 ms after the request, negatively after 70 to 90 ms;
// - no PID 56 (the unit answers it with no element; ETS negotiates 15, "restricted by ByTargetDevice"): its
//   longest frames, a 12-octet memory read and write, carry an APDU of 15 octets;
// - of the additional load controls at 0x0104, the absolute segment and the task segment, PEI type 80;
// - no capture reads a property description by PID, nor writes a property, nor uses an extended memory service.
export const ABB_USU42: SimUnitSpec = {
  id: "abb-usu-4.2",
  name: "ABB US/U 4.2",
  collection: "internal/captures/abb-counter-2026-11-20/collect-1.1.201-before.json",
  catalogue: "M-0002_A-A001-13-63C2.xml.gz",
  interfaceIa: BENCH_BRIDGE.ia,
  interfaceMaxApdu: BENCH_BRIDGE.maxApdu,
  behaviour: {
    restart: { basic: { acknowledged: true, tAck: "always" }, line: [{ atMs: 0, up: false }, { atMs: 42, up: false }, { atMs: 1040, up: true }], deadConnection: "nothing", confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 70 },
    memoryExtendedWrite: false,
    descriptionIndex: null,
    shownWrites: new Map(),
  },
  memoryMapped: { maxApdu: 15, additional: ["absolute-segment", "task-segment"], peiType: 0x80, tableReferenceFollows: false, addressTableCountOnDeclaration: null, clearedByRestart: new Map() },
};

// The Theben Meteodata 140 S weather station (M-0048_A-140C-14-EB70, MV-0701, memory-mapped load control), from
// the house unit's collection before ETS's downloads (collections/meteodata-140s-hc04-2026-10-07/). Its behaviour
// from ETS's downloads (captures/meteodata-140s-ets-*.log) and Busforge's (the same collection directory, its
// meteodata-busforge-*.log), through the house's KNXnet/IP interface, tunnel 1.1.254, which reported a maximum
// APDU of 210 to ETS (ETS6.log, InterfaceFeatures):
// - A_Restart: confirmed by the interface and acknowledged on layer 2, without T_Ack; a frame 41 ms after it
//   is confirmed positively, and the line is taken as up from the restart on: no capture shows a frame sooner,
//   and Busforge's restart proof probes 1 ms after it (a refusal there would end its download test); numbered
//   frames on the connection the restart ended are dropped without T_Disconnect (Busforge's probes);
// - the free key (FFFFFFFF) grants access level 0;
// - the interface confirmed a frame about 18 ms after the request; its own captures show it confirm none
//   negatively, the Theben DALI-Gateway's through the same interface after 63 ms;
// - no PID 56 (ETS: "Empty response; assuming 15");
// - of the additional load controls at 0x0104, the absolute segment, the task segment (PEI type 00) and task
//   control 1;
// - after a download, objects 1 and 2 report by PID 7 the address their table was declared at (Busforge's
//   verification reads, where the address equals the one collected);
// - after load-state machine 1 is unloaded and its segment declared again, the address table's count reads 01
//   (every ETS download that declares it reads it there; the ABB US/U 4.2 keeps its count);
// - the download marker P-2228 at 0x4800, written AA by every download, reads AA within the session and 00 in
//   the next one;
// - no capture reads a property description by PID, nor writes a property, nor uses an extended memory service.
export const THEBEN_METEODATA_140S: SimUnitSpec = {
  id: "theben-meteodata-140s",
  name: "Theben Meteodata 140 S",
  collection: "collections/meteodata-140s-hc04-2026-10-07/1.1.24-meteodata-collect-vor.json",
  catalogue: "M-0048_A-140C-14-EB70.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: HOUSE_INTERFACE.maxApdu,
  behaviour: {
    restart: { basic: { acknowledged: true, tAck: "never" }, line: [{ atMs: 0, up: true }], deadConnection: "nothing", confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 18, nakMs: HOUSE_INTERFACE.link.nakMs },
    memoryExtendedWrite: false,
    descriptionIndex: null,
    shownWrites: new Map(),
  },
  memoryMapped: { maxApdu: 15, additional: ["absolute-segment", "task-segment", "task-control-1"], peiType: 0x00, tableReferenceFollows: true, addressTableCountOnDeclaration: 0x01, clearedByRestart: new Map([[0x4800, 0x00]]) },
};

export const SIM_UNITS: readonly SimUnitSpec[] = [MEANWELL_KNX40E, THEBEN_DALI_GATEWAY, OPENKNX_RAUMCONTROLLER, THEBEN_MIX2_HMG6T, JUNG_400021SE, GVS_AMMA, ABB_USU42, THEBEN_METEODATA_140S];

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
export function newSimUnit(spec: SimUnitSpec, opts: SimOpts = {}, behaviour: Partial<SystemBBehaviour> = {}, collectionPath = spec.collection): SimUnit {
  if (spec.memoryMapped) {
    const systemB = (["unloadStopsApplication", "clearsAfterRestart", "mcb", "stateInCaptures"] as const).filter((k) => k in behaviour);
    if (systemB.length) throw new Error(`no simulated unit: ${systemB.join(", ")} of a System B unit given for the memory-mapped ${spec.id}`);
    return newSimUnit0701(spec, opts, behaviour, collectionPath);
  }
  return new SimUnit(simUnitModel(collectionOf(spec, collectionPath), catalogueXml(spec.catalogue), { ...spec.behaviour, ...behaviour }), spec.interfaceIa, { interfaceMaxApdu: spec.interfaceMaxApdu, ...opts });
}

// The same for a memory-mapped System 7 unit, refused for a spec of another.
export function newSimUnit0701(spec: SimUnitSpec, opts: SimOpts = {}, behaviour: Partial<UnitBehaviour> = {}, collectionPath = spec.collection): SimUnit0701 {
  if (!spec.memoryMapped) throw new Error(`${spec.id} is not a memory-mapped System 7 unit`);
  return new SimUnit0701(simUnit0701Model(collectionOf(spec, collectionPath), catalogueXml(spec.catalogue), { ...spec.behaviour, ...behaviour }, spec.memoryMapped), spec.interfaceIa, { interfaceMaxApdu: spec.interfaceMaxApdu, ...opts });
}
