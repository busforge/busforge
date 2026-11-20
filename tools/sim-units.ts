// The units tools/sim-unit.ts simulates, each from a read-only collection of a real unit and its product's
// application program in the private corpus, with what only the unit's captures show of it.
import { readFileSync } from "node:fs";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { SimUnit } from "./sim-unit.ts";
import type { CollectPackage } from "../packages/product/src/index.ts";
import { simUnitModel, type UnitBehaviour } from "./sim-unit-model.ts";

export interface SimUnitSpec {
  id: string;
  name: string;
  // The collection of the unit, under captures/, as the unit held its configuration before the captures below
  // (where the captures found it in another state, `behaviour.stateInCaptures` gives their answers).
  collection: string;
  catalogue: string;
  // The interface address the unit's captures ran through: the source of every frame the tool sent it.
  interfaceIa: number;
  // The maximum APDU the interface announced (cEMI server object 0 PID 56 over device management, or the
  // tunnelling DIB of its search response); a longer frame it confirmed negatively without sending it.
  interfaceMaxApdu: number;
  behaviour: UnitBehaviour;
}

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
  collection: "meanwell-unit-collect-vor.json",
  catalogue: "M-0162_A-0004-11-F245.xml.gz",
  interfaceIa: 0x1164,
  interfaceMaxApdu: 40,
  behaviour: {
    restart: { basic: { acknowledged: false, tAck: "never" }, line: [{ atMs: 0, up: false }, { atMs: 499, up: false }, { atMs: 500, up: true }], deadConnection: "nothing", confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 75 },
    unloadStopsApplication: true,
    descriptionIndex: "property",
    clearsAfterRestart: [],
  },
};

// The house's KNXnet/IP interface the Theben, OpenKNX and second MEAN WELL captures ran through: tunnels 1.1.253 to
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
// - its memory-control blocks report 01 33 between size and CRC for the three tables, 00 33 for the application.
export const THEBEN_DALI_GATEWAY: SimUnitSpec = {
  id: "theben-dali-gateway",
  name: "Theben DALI-Gateway KNX plus",
  collection: "dali-gateway-unit-collect-vor.json",
  catalogue: "M-0048_A-9071-20-F258-O00EF.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: HOUSE_INTERFACE.maxApdu,
  behaviour: {
    restart: { basic: { acknowledged: true, tAck: "unless-application-loaded" }, line: [{ atMs: 1058, up: false }, { atMs: 1071, up: false }, { atMs: 2992, up: true }], deadConnection: null, confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: HOUSE_INTERFACE.link,
    unloadStopsApplication: false,
    descriptionIndex: "request",
    clearsAfterRestart: [],
  },
};

// The OpenKNX RaumController (M-00FA_A-A012-55-0000, MV-07B0), from the collection before ETS's downloads
// (captures/openknx-unit-collect-vor.json). Its behaviour from ETS's four captures in the order they ran on it
// (captures/openknx-ets-fulldownload.log, -partial-params, -partial-links, -partial-revert), through the house's
// interface:
// - A_Restart: acknowledged on layer 2, no T_Ack (every capture); a T_Disconnect 2864 to 2992 ms after it
//   confirmed positively; nothing on the connection it ended;
// - the free key (FFFFFFFF) grants access level 0;
// - a description read by PID is answered with the property's own index (object 2's PID 23 at index 1);
// - its memory-control blocks held no element when it was collected; after the application's load completed
//   it reports size, 00 FF and the CRC-16/CCITT over the segment with the 16 zero bits appended (object 4's
//   PID 27 in -fulldownload);
// - a write of object 5's load state, which it did not describe and whose read it refused, is answered without
//   elements;
// - what its device control reads after the application is unloaded none of them shows.
export const OPENKNX_RAUMCONTROLLER: SimUnitSpec = {
  id: "openknx-raumcontroller",
  name: "OpenKNX RaumController",
  collection: "openknx-unit-collect-vor.json",
  catalogue: "M-00FA_A-A012-55-0000.xml.gz",
  interfaceIa: 0x11fd,
  interfaceMaxApdu: HOUSE_INTERFACE.maxApdu,
  behaviour: {
    restart: { basic: { acknowledged: true, tAck: "never" }, line: [{ atMs: 2864, up: true }], deadConnection: null, confirmedRestartSeconds: null },
    authorize: new Map([["ffffffff", 0]]),
    link: HOUSE_INTERFACE.link,
    unloadStopsApplication: null,
    descriptionIndex: "property",
    clearsAfterRestart: [],
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
  collection: "mix2-hmg6t-unit-collect-vor.json",
  catalogue: "M-0048_A-493B-21-B471.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: HOUSE_INTERFACE.maxApdu,
  behaviour: {
    restart: { basic: null, line: [{ atMs: 22, up: true }], deadConnection: null, confirmedRestartSeconds: 1 },
    authorize: new Map([["ffffffff", 0]]),
    link: HOUSE_INTERFACE.link,
    unloadStopsApplication: null,
    descriptionIndex: "property",
    clearsAfterRestart: [{ lsm: 4, offset: 39, clear: 0x80 }],
  },
};

// Busforge's bench bridge at 1.1.100 (a KNX-USB stick), which the Jung's and the GVS's captures ran through
// announcing a maximum APDU of 40: it confirmed their frames longer than that negatively within 2 to 4 ms,
// without sending them.
const BENCH_BRIDGE = { ia: 0x1164, maxApdu: 40 } as const;

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
// - a description read by PID is answered with the property's own index (object 2's PID 23 at index 3);
// - what its device control reads after the application is unloaded it does not show.
export const JUNG_400021SE: SimUnitSpec = {
  id: "jung-400021se",
  name: "Jung 400021SE",
  collection: "jung-400021se-unit-collect-secure.json",
  catalogue: "M-0004_A-7072-21-99A7-O000A.xml.gz",
  interfaceIa: BENCH_BRIDGE.ia,
  interfaceMaxApdu: BENCH_BRIDGE.maxApdu,
  behaviour: {
    restart: { basic: null, line: [{ atMs: 26, up: false }, { atMs: 29, up: false }, { atMs: 1279, up: true }], deadConnection: null, confirmedRestartSeconds: 0 },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 21, nakMs: 68 },
    unloadStopsApplication: null,
    descriptionIndex: "property",
    clearsAfterRestart: [],
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
// - a write of 01 to object 4's PID 67, which it described as writable and whose read it refused, is echoed;
// - what its device control reads after the application is unloaded it does not show.
export const GVS_AMMA: SimUnitSpec = {
  id: "gvs-amma",
  name: "GVS AMMA-04/06.S",
  collection: "gvs-amma-unit-collect-secure.json",
  catalogue: "M-0085_A-0072-30-69AA.xml.gz",
  interfaceIa: BENCH_BRIDGE.ia,
  interfaceMaxApdu: BENCH_BRIDGE.maxApdu,
  behaviour: {
    restart: { basic: null, line: [{ atMs: 24, up: true }, { atMs: 1215, up: false }, { atMs: 1289, up: false }, { atMs: 4292, up: true }], deadConnection: null, confirmedRestartSeconds: 0 },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 74 },
    unloadStopsApplication: null,
    descriptionIndex: "property",
    clearsAfterRestart: [],
    stateInCaptures: { properties: {}, functionStates: { "17/1/51 0000": "0000" } },
  },
};

export const SIM_UNITS: readonly SimUnitSpec[] = [MEANWELL_KNX40E, THEBEN_DALI_GATEWAY, OPENKNX_RAUMCONTROLLER, THEBEN_MIX2_HMG6T, JUNG_400021SE, GVS_AMMA];

export function simUnitSpec(id: string): SimUnitSpec {
  const spec = SIM_UNITS.find((u) => u.id === id);
  if (!spec) throw new Error(`no simulated unit "${id}"; there are: ${SIM_UNITS.map((u) => u.id).join(", ")}`);
  return spec;
}

// A fresh unit as its collection shows it.
export function newSimUnit(spec: SimUnitSpec, opts: ConstructorParameters<typeof SimUnit>[2] = {}, behaviour: Partial<UnitBehaviour> = {}): SimUnit {
  const collection = JSON.parse(readFileSync(corpusPath(`captures/${spec.collection}`), "utf8")) as CollectPackage;
  return new SimUnit(simUnitModel(collection, catalogueXml(spec.catalogue), { ...spec.behaviour, ...behaviour }), spec.interfaceIa, { interfaceMaxApdu: spec.interfaceMaxApdu, ...opts });
}
