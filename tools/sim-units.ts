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
  // The collection of the unit, under captures/, as the unit held its configuration before the captures below.
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
  collection: "meanwell-unit-collect-vor.json",
  catalogue: "M-0162_A-0004-11-F245.xml.gz",
  interfaceIa: 0x1164,
  interfaceMaxApdu: 40,
  behaviour: {
    restart: { acknowledged: false, linkDownMs: 500, deadConnection: "nothing" },
    authorize: new Map([["ffffffff", 0]]),
    link: { ackMs: 20, nakMs: 75 },
  },
};

export const SIM_UNITS: readonly SimUnitSpec[] = [MEANWELL_KNX40E];

export function simUnitSpec(id: string): SimUnitSpec {
  const spec = SIM_UNITS.find((u) => u.id === id);
  if (!spec) throw new Error(`no simulated unit "${id}"; there are: ${SIM_UNITS.map((u) => u.id).join(", ")}`);
  return spec;
}

// A fresh unit as its collection shows it.
export function newSimUnit(spec: SimUnitSpec, opts: ConstructorParameters<typeof SimUnit>[2] = {}, behaviour: Partial<UnitBehaviour> = {}): SimUnit {
  const collection = JSON.parse(readFileSync(corpusPath(`captures/${spec.collection}`), "utf8")) as CollectPackage;
  return new SimUnit(simUnitModel(collection, catalogueXml(spec.catalogue), { ...spec.behaviour, ...behaviour }), spec.interfaceIa, opts);
}
