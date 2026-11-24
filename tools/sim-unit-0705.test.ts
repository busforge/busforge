import { test, expect, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { cemiLData, numToIa, withSource } from "../packages/knx/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { captureText, catalogueXml, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { memoryImage, parseCapture } from "./etsdiff.ts";
import { busforgeIntoSim } from "./ets-sweep.ts";
import { giraM0008Configuration } from "./gira-m0008-config.ts";
import type { SimUnit } from "./sim-unit.ts";
import { SimUnit0705 } from "./sim-unit-0705.ts";
import { confirmationDifferences, framePairs, replayCapture, replayDifferences, type ReplayStep } from "./sim-unit-replay.ts";
import { AURO_M0081, GIRA_TS3, MDT_BE02001, MDT_BE06001, THEBEN_THELUXA_P300, newSimUnit, type SimUnitSpec } from "./sim-units.ts";

// Busforge's downloads below run on the wall clock (the units' line timing, the restart windows): about 25 s
// alone; twenty times that under a loaded full check (docs/testing.md, "Timeouts of heavy tests").
setDefaultTimeout(600_000);

// A T_Ack or T_Disconnect, the requests whose confirmation a capture may lack.
const ACK_OR_DISCONNECT = /^(81|[c-f][26ae])$/;

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

  test("refuses a task segment no capture shows, a property write but PID 5 and 14, and its programming mode where it contradicts the collection", async () => {
    const sim = newSimUnit(MDT_BE02001, {}, { link: { ackMs: 0, nakMs: 0 } });
    const send = (tpdu: string) => sim.sendCemi(withSource(cemiLData(0, sim.deviceIa, Buffer.from(tpdu, "hex")), MDT_BE02001.interfaceIa));
    // In programming mode at the start, where the collection read PID 54 as 00: its read is refused.
    for (const t of ["80", "43d500361001"]) await send(t);
    // Unload, load and allocate object 1, then a task segment for another application, and a PID 27 write.
    for (const t of ["47d70105100104000000000000000000", "c2", "4bd70105100101000000000000000000", "c6", "4fd701051001030040000201ff038000", "ca", "53d7010510010302400001deadbeef01", "57d7011b10010000000100001234"]) await send(t);
    expect(sim.refusals).toEqual([
      "sim-refused A_PropertyValue_Read 0/54 of 1 from 1: the unit's programming mode differs from the one collected, and what it reports then is not shown",
      "sim-refused A_PropertyValue_Write 1/5 0302400001deadbeef01: a task segment for application deadbeef01, where the unit holds 008300b632",
      "sim-refused A_PropertyValue_Write 1/27 0000000100001234: no capture shows this unit take a write of it",
    ]);
    // The Gira: no capture shows its device control after its application's unload.
    const gira = newSimUnit(GIRA_TS3, {}, { link: { ackMs: 0, nakMs: 0 } });
    const g = (tpdu: string) => gira.sendCemi(withSource(cemiLData(0, gira.deviceIa, Buffer.from(tpdu, "hex")), GIRA_TS3.interfaceIa));
    for (const t of ["80", "43d70305100104000000000000000000", "c2", "47d5000e1001"]) await g(t);
    expect(gira.refusals).toEqual(["sim-refused A_PropertyValue_Read 0/14 of 1 from 1 after the unload of the application: what the unit reports then is not shown"]);
  });

  test("refuses load completed after an unload without the segment and task segment every capture declares", async () => {
    const sim = newSimUnit(MDT_BE02001, {}, { link: { ackMs: 0, nakMs: 0 } });
    const send = (tpdu: string) => sim.sendCemi(withSource(cemiLData(0, sim.deviceIa, Buffer.from(tpdu, "hex")), MDT_BE02001.interfaceIa));
    // T_Connect, then unload, load and load completed of object 1, each answer acknowledged.
    for (const t of ["80", "43d70105100104000000000000000000", "c2", "47d70105100101000000000000000000", "c6", "4bd70105100102000000000000000000"]) await send(t);
    expect(sim.refusals).toEqual(["sim-refused A_PropertyValue_Write 1/5 02000000000000000000: load completed after an unload without a segment and a task segment declared, which no capture shows"]);
  });

  // Busforge's two full downloads of its smoke runs (the proxy names the tool ETS): its read-backs while a segment
  // loads, its probes after each restart, its verification. No collection was taken right before them; the
  // unit's starts from the one taken four days earlier, and the unit then held another configuration (a link,
  // two parameters). Busforge's backup reads before its first load-state event read that configuration, and only
  // they differ. The capture holds no confirmation of some T_Acks and T_Disconnects.
  test("answers every request of Busforge's two captured full downloads as the unit did but for the reads of the configuration it held before them", async () => {
    for (const run of ["api", "ui"]) {
      let clock = 0;
      const sim = newSimUnit(MDT_BE02001, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
      const text = gunzipSync(readFileSync(corpusPath(`internal/house-compat/hc13/runs-2026-10-08/bench-proxy/mdt-be02001-${run}-r2.log.gz`))).toString("utf8");
      const steps = await replay(sim, MDT_BE02001, text, "ETS", (ms) => { clock = ms; });
      const firstEvent = steps.findIndex((s) => /^..d7..05/.test(s.request));
      const isMemoryRead = (tpdu: string) => { const t = Buffer.from(tpdu, "hex"); return ((((t[0] & 0x03) << 8) | t[1]) & 0x3f0) === 0x200; };
      // The unconfirmed requests are T_Acks and T_Disconnects; every other confirmation is the unit's.
      expect([run, steps.filter((s) => s.unitCon === undefined && !ACK_OR_DISCONNECT.test(s.request))]).toEqual([run, []]);
      expect([run, confirmationDifferences(steps.filter((s) => s.unitCon !== undefined))]).toEqual([run, []]);
      // Every differing frame answers a memory read before the first load-state event.
      const differing = framePairs(steps).filter((f) => f.unit !== f.sim);
      expect([run, differing.length > 0, differing.filter((f) => f.unitStep !== f.simStep || f.unitStep >= firstEvent || !isMemoryRead(steps[f.unitStep].request))]).toEqual([run, true, []]);
      expect([run, sim.refusals]).toEqual([run, []]);
    }
  });

  test("takes Busforge's full download of the defaults into a fresh unit, verified", async () => {
    const run = await busforgeIntoSim(MDT_BE02001, { ia: "1.1.56", params: [], links: [] });
    expect([run.refused, run.error, run.refusals]).toEqual([null, null, []]);
    expect(run.result).toMatchObject({ kind: "flashed", verified: true });
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

// ETS's captures of each unit in the order they ran on it, into one simulated unit from the state its collection
// shows (or the other collection of the unit named), on the captures' clock: every frame and confirmation as the unit
// and its interface gave them, every byte written held.
const CALIBRATIONS: { spec: SimUnitSpec; captures: string[]; collection?: string }[] = [
  { spec: AURO_M0081, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `auro-m0081-ets-${k}.log`) },
  { spec: AURO_M0081, collection: "collections/in-service/auro-m0081-in-service.json", captures: ["partial-unlink9", "partial-relink9"].map((k) => `auro-m0081-ets-${k}.log`) },
  { spec: THEBEN_THELUXA_P300, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `theluxa-p300-ets-${k}.log`) },
  { spec: MDT_BE06001, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `mdtui-ets-${k}.log`) },
];

for (const { spec, captures, collection } of CALIBRATIONS) {
  corpusDescribe(`the simulated ${spec.name} against ETS's captures${collection ? ` from ${collection}` : ""}`, () => {
    test("answers every request as the unit did, and confirms each on the line as its interface did", async () => {
      let clock = 0;
      const sim = newSimUnit(spec, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } }, collection);
      for (const capture of captures) {
        const text = captureText(capture);
        const steps = await replay(sim, spec, text, "ETS", (ms) => { clock = ms; });
        expect([capture, steps.length > 40, replayDifferences(steps, { context: 3 })]).toEqual([capture, true, []]);
        expect([capture, notHeld(sim, text)]).toEqual([capture, []]);
      }
      expect(sim.refusals).toEqual([]);
    });
  });
}

// Busforge's captured downloads of the units in the order they ran, from the collection taken right before them:
// their read-backs while a segment loads, their probes after each restart. The captures hold no confirmation of some
// T_Acks and T_Disconnects.
const BUSFORGE_CAPTURES: { spec: SimUnitSpec; collection: string; captures: string[] }[] = [
  {
    spec: AURO_M0081, collection: "collections/auro-m0081-busforge-2026-10-06/1.1.18-auro-m0081-collect-vor-busforge-20261006-223003.json",
    captures: ["params-led0", "params-led1", "ga-add-7ffa"].map((k) => `collections/auro-m0081-busforge-2026-10-06/auro-m0081-busforge-${k}.log`),
  },
  {
    spec: MDT_BE06001, collection: "internal/house-compat/hc08-busforge-2026-10-09/1.1.56-collect-vor.json",
    captures: ["internal/house-compat/hc08-busforge-2026-10-09/mdtui-busforge-full-f1.log"],
  },
];

for (const { spec, collection, captures } of BUSFORGE_CAPTURES) {
  corpusDescribe(`the simulated ${spec.name} against Busforge's captures`, () => {
    test("answers every request as the unit did, and confirms each on the line as its interface did", async () => {
      let clock = 0;
      const sim = newSimUnit(spec, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } }, collection);
      for (const capture of captures) {
        const steps = await replay(sim, spec, readFileSync(corpusPath(capture), "utf8"), "Busforge", (ms) => { clock = ms; });
        expect([capture, steps.filter((s) => s.unitCon === undefined && !ACK_OR_DISCONNECT.test(s.request))]).toEqual([capture, []]);
        expect([capture, steps.length > 100, replayDifferences(steps.filter((s) => s.unitCon !== undefined), { context: 3 })]).toEqual([capture, true, []]);
      }
      expect(sim.refusals).toEqual([]);
    });
  });
}

// The theLuxa P300's line right after its restart is not shown (sim-units.ts): Busforge's probe then is refused.
corpusDescribe("Busforge's full download of the defaults into the new simulated MV-0705 units", () => {
  for (const [spec, refusals] of [[AURO_M0081, []], [MDT_BE06001, []], [THEBEN_THELUXA_P300, ["after the restart: whether the unit acknowledges a frame then is not shown"]]] as const) {
    test(`is taken by the ${spec.name} and verified`, async () => {
      const run = await busforgeIntoSim(spec, { ia: numToIa(newSimUnit(spec).deviceIa), params: [], links: [] });
      expect([run.refused, run.error]).toEqual([null, null]);
      expect(run.result).toMatchObject({ kind: "flashed", verified: true });
      expect(run.refusals.map((r) => refusals.find((k) => r.endsWith(k)) ?? r)).toEqual([...refusals]);
    });
  }
});

corpusDescribe("the new simulated MV-0705 units", () => {
  test("refuse a task control 1 their application does not declare or their captures do not show, and the device control after a load of the application no capture shows", async () => {
    const send = (sim: SimUnit, spec: SimUnitSpec) => (tpdu: string) => sim.sendCemi(withSource(cemiLData(0, sim.deviceIa, Buffer.from(tpdu, "hex")), spec.interfaceIa));
    // T_Connect, unload and load of the application, each answer acknowledged, then a task control 1.
    const taskControl = ["80", "43d70305100104000000000000000000", "c2", "47d70305100101000000000000000000", "c6", "4bd70305100103040010010000000000"];
    const auro = newSimUnit(AURO_M0081, {}, { link: { ackMs: 0, nakMs: 0 } });
    for (const t of taskControl) await send(auro, AURO_M0081)(t);
    expect(auro.refusals).toEqual(["sim-refused A_PropertyValue_Write 3/5 03040010010000000000: a task control 1 at 0x10 with count 1, which the application does not declare for object 3"]);
    const mdt = newSimUnit(MDT_BE06001, {}, { link: { ackMs: 0, nakMs: 0 } });
    for (const t of taskControl) await send(mdt, MDT_BE06001)(t);
    expect(mdt.refusals).toEqual(["sim-refused A_PropertyValue_Write 3/5 03040010010000000000: additional load control 0x4 is not shown on this unit"]);
    // The MDT BE-02001.02's application loaded again while it is loaded, then its device control read.
    const be02001 = newSimUnit(MDT_BE02001, {}, { link: { ackMs: 0, nakMs: 0 } });
    for (const t of ["80", "43d70305100101000000000000000000", "c2", "47d5000e1001"]) await send(be02001, MDT_BE02001)(t);
    expect(be02001.refusals).toEqual(["sim-refused A_PropertyValue_Read 0/14 of 1 from 1 after the load of the application: what the unit reports then is not shown"]);
    // Its unload after the load, which its captures show set the application-stopped bit, makes it known again.
    for (const t of ["4bd70305100104000000000000000000", "c6", "4fd5000e1001"]) await send(be02001, MDT_BE02001)(t);
    expect(be02001.refusals.length).toBe(1);
    // The Gira's application declares its task segment inside a segment, which no capture shows it take.
    const gira = newSimUnit(GIRA_TS3, {}, { link: { ackMs: 0, nakMs: 0 } });
    for (const t of ["80", "43d70305100101000000000000000000", "c2", "47d7030510010302435400000810d711"]) await send(gira, GIRA_TS3)(t);
    expect(gira.refusals).toEqual(["sim-refused A_PropertyValue_Write 3/5 0302435400000810d711: a task segment at 0x4354, inside a segment of object 3, which no capture shows the unit take"]);
  });
});
