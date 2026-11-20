// The units tools/sim-unit.ts (System B) and tools/sim-unit-0705.ts (System 7, MV-0705) simulate, each from a
// read-only collection of a real unit and its product's application program in the private corpus, with what
// only the unit's captures show of it.
import { readFileSync } from "node:fs";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { SimUnit } from "./sim-unit.ts";
import { SimUnit0705, sim0705Model } from "./sim-unit-0705.ts";
import type { CollectPackage } from "../packages/product/src/index.ts";
import { simUnitModel, type UnitBehaviour } from "./sim-unit-model.ts";

export interface SimUnitSpec {
  id: string;
  name: string;
  // The collection of the unit, relative to the corpus; its mask selects the simulator.
  collection: string;
  catalogue: string;
  // The interface address the unit's captures ran through: the source of every frame the tool sent it.
  interfaceIa: number;
  // The maximum APDU the interface announced (cEMI server object 0 PID 56 over device management).
  interfaceMaxApdu: number;
  behaviour: UnitBehaviour;
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

// The MDT BE-02001.02 binary input (M-0083_A-00B6-32-9642, MV-0705), from a collection after ETS's downloads
// (internal/captures/cap-1004/mdt-plain.json). Its behaviour from ETS's three full downloads
// (captures/mdt-be02001-ets-fulldownload-{defaults,linked,b7}.log) and Busforge's address assignment with its
// restart (internal/captures/restart-end-2026-11-19/a2-mdt-ia-66to56.log), through a KNX-USB stick behind
// Busforge's bridge at 1.1.100, which announces a maximum APDU of 40 (ETS6.log of the unit's partial downloads,
// "InterfaceFeatures"):
// - it refuses PID 56, and takes the 15-octet APDUs ETS sends it ("assuming 15", the same logs);
// - A_Restart: acknowledged on layer 2, without T_Ack, in every capture; a frame 42 ms after the restart request
//   not acknowledged, one 1.04 s after it acknowledged (the assignment), between them none shown; what it
//   answers a numbered frame on the connection the restart ended is not shown;
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
    restart: { acknowledged: "layer2", linkDownMs: 43, linkUpMs: 1043, deadConnection: "unknown" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 70 },
    programmingMode: true,
    serialNumberResponseTail: Buffer.alloc(4),
    maxApdu: 15,
  },
};

// The Gira Tastsensor 3 Komfort 3fach (M-0008_A-10D7-11-2783-O000A, MV-0705), from the collection before ETS's
// full download (collections/gira-m0008-backup-2026-10-05/1.1.1-gira-m0008-collect.json). Its behaviour from
// that download (captures/gira-m0008-ets-fulldownload.log, with its ETS6.log), through a KNXnet/IP interface at
// 1.1.254 announcing a maximum APDU of 210:
// - it refuses PID 56, and takes the 15-octet APDUs ETS sends it ("assuming 15");
// - A_Restart: acknowledged on layer 2, without T_Ack; ETS's T_Disconnect 2.97 s after the restart request
//   acknowledged, no frame before it shown; what it answers a numbered frame on the connection the restart ended
//   is not shown;
// - the free key grants access level 0;
// - the interface confirmed a frame 18 to 40 ms after the request; none negatively, so the time of a negative
//   confirmation is the same interface's on the MEAN WELL above (its two maxtemp downloads, 75 ms).
export const GIRA_TS3: SimUnitSpec = {
  id: "gira-ts3",
  name: "Gira Tastsensor 3 Komfort 3fach",
  collection: "collections/gira-m0008-backup-2026-10-05/1.1.1-gira-m0008-collect.json",
  catalogue: "M-0008_A-10D7-11-2783-O000A.xml.gz",
  interfaceIa: 0x11fe,
  interfaceMaxApdu: 210,
  behaviour: {
    restart: { acknowledged: "layer2", linkDownMs: 0, linkUpMs: 2967, deadConnection: "unknown" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 75 },
    maxApdu: 15,
  },
};

export const SIM_UNITS: readonly SimUnitSpec[] = [MEANWELL_KNX40E, MDT_BE02001, GIRA_TS3];

export function simUnitSpec(id: string): SimUnitSpec {
  const spec = SIM_UNITS.find((u) => u.id === id);
  if (!spec) throw new Error(`no simulated unit "${id}"; there are: ${SIM_UNITS.map((u) => u.id).join(", ")}`);
  return spec;
}

// A fresh unit as its collection shows it.
export function newSimUnit(spec: SimUnitSpec, opts: ConstructorParameters<typeof SimUnit>[2] = {}, behaviour: Partial<UnitBehaviour> = {}): SimUnit {
  const collection = JSON.parse(readFileSync(corpusPath(spec.collection), "utf8")) as CollectPackage;
  const b = { ...spec.behaviour, ...behaviour }, xml = catalogueXml(spec.catalogue);
  if (collection.mask === "MV-0705") return new SimUnit0705(sim0705Model(collection, xml, b), spec.interfaceIa, opts);
  return new SimUnit(simUnitModel(collection, xml, b), spec.interfaceIa, opts);
}
