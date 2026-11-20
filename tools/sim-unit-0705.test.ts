import { test, expect, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { cemiLData, withSource } from "../packages/knx/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { captureText, catalogueXml, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { memoryImage, parseCapture } from "./etsdiff.ts";
import { busforgeIntoSim } from "./ets-sweep.ts";
import { giraM0008Configuration } from "./gira-m0008-config.ts";
import type { SimUnit } from "./sim-unit.ts";
import { SimUnit0705 } from "./sim-unit-0705.ts";
import { replayCapture, replayDifferences, type ReplayStep } from "./sim-unit-replay.ts";
import { GIRA_TS3, MDT_BE02001, newSimUnit, type SimUnitSpec } from "./sim-units.ts";

// Busforge's downloads below run on the wall clock (the units' line timing, the restart windows): about 25 s
// alone; twenty times that under a loaded full check (docs/testing.md, "Timeouts of heavy tests").
setDefaultTimeout(600_000);

// A capture replayed into `sim` on its own clock, as tools/sim-unit-replay.ts does it.
async function replay(sim: SimUnit, spec: SimUnitSpec, text: string, tool: string, set: (ms: number) => void, from?: number): Promise<ReplayStep[]> {
  return replayCapture(sim, text, { tool, device: sim.deviceIa, interfaceIa: spec.interfaceIa, clock: set, from, broadcasts: true });
}

// Every byte a capture's tool wrote the unit that the simulated unit does not hold after its replay.
function notHeld(sim: SimUnit, text: string): string[] {
  if (!(sim instanceof SimUnit0705)) throw new Error("not a System 7 unit");
  return [...memoryImage(parseCapture(text, sim.deviceIa).writes)].filter(([a, b]) => sim.memory(a, 1)?.[0] !== b).map(([a]) => a.toString(16));
}

// ETS's three full downloads of the MDT BE-02001.02, in the order they ran on the unit, into one simulated unit
// from the state its collection shows, on the captures' clock. The collection is later than all three, and two ETS
// downloads ran between the second and the third; none of the three reads memory or a property those change, so
// every frame the unit answered is a write's echo, a load state the replay itself sets, or an identity property.
corpusDescribe("the simulated MDT BE-02001.02", () => {
  test("answers every request of ETS's three full downloads as the unit did, and confirms each on the line as its interface did", async () => {
    let clock = 0;
    const sim = newSimUnit(MDT_BE02001, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
    for (const kind of ["defaults", "linked", "b7"]) {
      const text = captureText(`mdt-be02001-ets-fulldownload-${kind}.log`);
      const steps = await replay(sim, MDT_BE02001, text, "ETS", (ms) => { clock = ms; });
      // The b7 capture skips the bridge's frames 6 to 15 of the session before the download: it holds the unit's
      // answer to ETS's A_IndividualAddressSerialNumber_Read, but not the request.
      const answer = "b0 broadcast 03dd008380a0253100000000";
      const held = kind === "b7" ? steps.map((s) => ({ ...s, unit: s.unit.filter((f) => f !== answer) })) : steps;
      expect([kind, steps.flatMap((s) => s.unit).length - held.flatMap((s) => s.unit).length]).toEqual([kind, kind === "b7" ? 1 : 0]);
      expect([kind, steps.length > 100, replayDifferences(held)]).toEqual([kind, true, []]);
      expect([kind, notHeld(sim, text)]).toEqual([kind, []]);
    }
    // The first finds the unit in programming mode, the second, after the first's restart, not.
    expect(sim.lines.filter((l) => l.includes("A_IndividualAddress_Read"))).toEqual(["A_IndividualAddress_Read 0100 from 1.1.100 outside programming mode: no answer"]);
    expect(sim.refusals).toEqual([]);
  });

  // From the address write on, the unit in programming mode at its new address: Busforge's connection, the
  // restart, the frames after it, the check that nobody is in programming mode.
  test("takes the restart of Busforge's address assignment as the unit did: no acknowledgement right after it, one a second later, out of programming mode", async () => {
    let clock = 0;
    const sim = newSimUnit(MDT_BE02001, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
    const text = readFileSync(corpusPath("internal/captures/restart-end-2026-11-19/a2-mdt-ia-66to56.log"), "utf8");
    const steps = await replay(sim, MDT_BE02001, text, "Busforge", (ms) => { clock = ms; }, Date.parse("2026-11-19T17:29:36.366Z"));
    expect(replayDifferences(steps)).toEqual([]);
    // The T_Disconnect right after the restart is the one frame not acknowledged; the address read before the
    // restart is answered, the one after it not.
    expect(steps.filter((s) => s.unitCon === "NEG" || s.request === "0100").map((s) => `${s.request} ${s.unitCon} ${s.unit.join(",")}`)).toEqual(["0100 OK bc broadcast 0140", "81 NEG ", "0100 OK "]);
    expect(sim.refusals).toEqual([]);
  });

  test("refuses load completed after an unload without the segment and task segment every capture declares", async () => {
    const sim = newSimUnit(MDT_BE02001, {}, { link: { ackMs: 0, nakMs: 0 } });
    const send = (tpdu: string) => sim.sendCemi(withSource(cemiLData(0, sim.deviceIa, Buffer.from(tpdu, "hex")), MDT_BE02001.interfaceIa));
    // T_Connect, then unload, load and load completed of object 1, each answer acknowledged.
    for (const t of ["80", "43d70105100104000000000000000000", "c2", "47d70105100101000000000000000000", "c6", "4bd70105100102000000000000000000"]) await send(t);
    expect(sim.refusals).toEqual(["sim-refused A_PropertyValue_Write 1/5 02000000000000000000: load completed after an unload without a segment and a task segment declared, which no capture shows"]);
  });

  test("Busforge's full download of the defaults into a fresh unit: refused where Busforge reads back a write into a segment that is loading, which no capture of the unit shows", async () => {
    const run = await busforgeIntoSim(MDT_BE02001, { ia: "1.1.56", params: [], links: [] });
    expect([run.result, run.refused, run.error]).toEqual([null, null, "no reliable response (device not answering)"]);
    expect(run.refusals).toEqual(["sim-refused A_Memory_Read 1 at 0x4000: into the segment of object 1 while it is in load state 2, where no capture shows the unit answer a read of these octets"]);
  });
});

// ETS's full download of the Gira Tastsensor 3 Komfort, its partial form (the unit holds the application), and
// Busforge's, each into a simulated unit from the collection taken before it.
corpusDescribe("the simulated Gira Tastsensor 3 Komfort", () => {
  test("answers every request of ETS's full download as the unit did, and confirms each on the line as its interface did", async () => {
    let clock = 0;
    const sim = newSimUnit(GIRA_TS3, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
    const text = captureText("gira-m0008-ets-fulldownload.log");
    const steps = await replay(sim, GIRA_TS3, text, "ETS", (ms) => { clock = ms; });
    expect([steps.length > 40, replayDifferences(steps)]).toEqual([true, []]);
    expect(notHeld(sim, text)).toEqual([]);
    expect(sim.refusals).toEqual([]);
  });

  // Busforge's full download into the unit, its read-backs while a segment loads, its restart probes and its
  // verification by the memory-control blocks the unit computed; from the collection taken right before it,
  // whose association segment holds four octets past the table that ETS's downloads after the first collection
  // changed and Busforge does not write (the segment's CRC covers them).
  test("answers every request of Busforge's captured full download as the unit did, and confirms each on the line as its interface did", async () => {
    let clock = 0;
    const dir = "collections/gira-m0008-busforge-fulldownload-2026-10-07";
    const sim = newSimUnit(GIRA_TS3, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } }, `${dir}/1.1.1-gira-m0008-collect-vor-busforge-20261007-004213.json`);
    const text = readFileSync(corpusPath(`${dir}/gira-m0008-busforge-fulldownload-20261007-004213.log`), "utf8");
    const steps = await replay(sim, GIRA_TS3, text, "Busforge", (ms) => { clock = ms; });
    // The capture holds no confirmation of the T_Disconnect that ends Busforge's first session, nor of the last
    // T_Ack and T_Disconnect, after which it ends.
    expect(steps.filter((s) => s.unitCon === undefined).map((s) => s.request)).toEqual(["81", "ce", "81"]);
    expect([steps.length > 500, replayDifferences(steps.filter((s) => s.unitCon !== undefined))]).toEqual([true, []]);
    expect(sim.refusals).toEqual([]);
  });

  test("takes Busforge's full download of the configuration ETS downloaded into a fresh unit, verified", async () => {
    const { links, params } = giraM0008Configuration(parseAppConfig(catalogueXml(GIRA_TS3.catalogue)));
    const run = await busforgeIntoSim(GIRA_TS3, { ia: "1.1.1", params: [...params], links });
    expect([run.refused, run.error, run.refusals]).toEqual([null, null, []]);
    expect(run.result).toMatchObject({ kind: "flashed", verified: true });
  });
});
