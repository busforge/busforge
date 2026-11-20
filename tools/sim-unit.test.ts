import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { KnxIpServer, cemiLData, cemiLDataGroup, crc16CcittFalse, parseCemiLData, withSource, type PropertyDescription } from "../packages/knx/src/index.ts";
import { downloadDeviceFull } from "../apps/server/src/deviceprofile.ts";
import type { Connection } from "../apps/server/src/db/connections.ts";
import { captureText, catalogueXml, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { memWriteOf, memoryImage, parseCapture, parseTunnelFrame } from "./etsdiff.ts";
import { giraM0008Configuration } from "./gira-m0008-config.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { SimUnit0705 } from "./sim-unit-0705.ts";
import { startProxy } from "./knxproxy.ts";
import { SimUnit, type SimProperty, type SimUnitModel } from "./sim-unit.ts";
import { GIRA_TS3, MDT_BE02001, MEANWELL_KNX40E, newSimUnit, type SimUnitSpec } from "./sim-units.ts";
import { removeTempDir, tempDir } from "./test-temp.ts";

// The Busforge download below runs on the wall clock (the unit's line timing, the restart proof's 4 s window):
// about 15 s alone; twenty times that under a loaded full check (docs/testing.md, "Timeouts of heavy tests").
setDefaultTimeout(300_000);

const TOOL = 0x11ff, DEV = 0x110a;
const desc = (objectIndex: number, pid: number, propertyIndex: number, writable: boolean, pdt: number): PropertyDescription =>
  ({ objectIndex, pid, propertyIndex, writable, pdt, maxElements: 1, readLevel: 3, writeLevel: 3 });
const p = (...elements: string[]): SimProperty => ({ elements: elements.map((e) => Buffer.from(e, "hex")), countKnown: true });

// A unit with a device object and one application segment of four octets at 0x4000. `send` returns the
// unit's frames in answer; `ctrl` holds the first control field of each.
function unit(over: Partial<SimUnitModel> = {}, now?: () => number): { sim: SimUnit; ctrl: number[]; send: (tpdu: string, from?: number, ctrl1?: number) => Promise<string[]> } {
  const segment = Buffer.from("01020304", "hex");
  const crc = crc16CcittFalse(segment);
  const model: SimUnitModel = {
    ia: DEV, mask: 0x07b0, maxApdu: 15,
    objects: new Map([
      [0, new Map([[14, p("00")], [56, p("000f")], [9, { elements: null, countKnown: true }]])],
      [4, new Map([[5, p("01")], [7, p("00004000")], [13, p("0000000000")], [27, p(`00000004${"00ff"}${crc.toString(16).padStart(4, "0")}`)]])],
    ]),
    descriptions: new Map([[0, [desc(0, 14, 2, true, 0x11), desc(0, 0, 3, false, 0)]]]),
    segments: new Map([[4, { at: 0x4000, size: 4, bytes: segment }]]),
    mcbControl: Buffer.from("00ff", "hex"), crc: "ccitt-false",
    authorize: new Map([["ffffffff", 0]]),
    restart: { acknowledged: true, linkDownMs: 0, deadConnection: "disconnect" }, link: { ackMs: 0, nakMs: 0 },
    ...over,
  };
  const sim = new SimUnit(model, TOOL, { now });
  const frames: string[] = [], ctrl: number[] = [];
  sim.onRawCemi = (c) => { frames.push(parseCemiLData(c).tpdu.toString("hex")); ctrl.push(c[2 + c[1]]); };
  const send = async (tpdu: string, from = TOOL, ctrl1 = 0xb0) => {
    const cemi = withSource(cemiLData(0, DEV, Buffer.from(tpdu, "hex")), from);
    cemi[2] = ctrl1;
    const before = frames.length;
    await sim.sendCemi(cemi);
    await new Promise((r) => setTimeout(r, 5));
    return frames.slice(before);
  };
  return { sim, ctrl, send };
}

describe("a simulated unit", () => {
  test("answers on its transport connection: T_Ack, then the answer under its own sequence number; a repetition is acknowledged, not executed", async () => {
    const { sim, ctrl, send } = unit();
    expect(await send("80")).toEqual([]);
    expect(await send("4300")).toEqual(["c2", "434007b0"]);
    expect(await send("c2")).toEqual([]);
    expect(await send("4300")).toEqual(["c2"]);
    expect(await send("47d500381001", TOOL, 0xbc)).toEqual(["c6", "47d600381001000f"]);
    // System priority on the transport-layer control frames, the request's on the answers.
    expect(ctrl.map((c) => c.toString(16))).toEqual(["b0", "b0", "b0", "b0", "bc"]);
    expect(sim.refusals).toEqual([]);
  });

  test("refuses what it does not hold, loudly and without an answer; a property the unit refused is answered without elements", async () => {
    const { sim, send } = unit();
    await send("80");
    expect(await send("43d500091001")).toEqual(["c2", "43d600090001"]);
    await send("c2");
    expect(await send("47d500401001")).toEqual(["c6"]);
    expect(await send("4a00")).toEqual(["ca"]);
    // Its answer past its last property, as the unit gave it.
    expect(await send("4fd8000003")).toEqual(["ce", "47d900000300000133"]);
    expect(sim.refusals).toEqual([
      "sim-refused A_PropertyValue_Read 0/64 of 1 from 1: the unit was not read there",
      "sim-refused 4a00 from 1.1.255: service 0x200 with 0 octets of data",
    ]);
  });

  test("runs its load-state machine in order: a write in verify mode is echoed, load completed reports the CRC over what was written", async () => {
    const { sim, send } = unit();
    await send("80");
    let seq = 0;
    // One request; the unit's answer without its T_Ack, acknowledged in turn.
    const req = async (apdu: string) => {
      const t = Buffer.from(apdu, "hex"); t[0] |= seq << 2;
      const answers = (await send(t.toString("hex"))).filter((f) => f.length > 2);
      for (const a of answers) await send(Buffer.from([0xc2 | (Buffer.from(a, "hex")[0] & 0x3c)]).toString("hex"));
      seq = (seq + 1) & 0x0f;
      return answers.map((f) => f.slice(2));
    };
    expect(await req("43d70405100102000000000000000000")).toEqual([]); // load completed while loaded
    expect(sim.refusals).toEqual(["sim-refused A_PropertyValue_Write 4/5 02000000000000000000: load completed in state 1"]);
    expect(await req("43d7000e100104")).toEqual(["d6000e100104"]);
    expect(await req("43d70405100104000000000000000000")).toEqual(["d60405100100"]);
    expect(await req("43d504071001")).toEqual([]); // the reference after an unload is not shown
    expect(await req("43d70405100101000000000000000000")).toEqual(["d60405100102"]);
    expect(await req("43d704051001030b0000000401000000")).toEqual(["d60405100102"]);
    expect(await req("4284" + "4000" + "0a0b0c0d")).toEqual(["444000" + "0a0b0c0d"]);
    expect(await req("43d70405100102000000000000000000")).toEqual(["d60405100101"]);
    const crc = crc16CcittFalse(Buffer.from("0a0b0c0d", "hex")).toString(16).padStart(4, "0");
    expect(await req("43d5041b1001")).toEqual([`d6041b100100000004${"00ff"}${crc}`]);
    expect(sim.segment(4)?.bytes.toString("hex")).toBe("0a0b0c0d");
    // Written and completed without the allocation after an unload: refused, the segment is not where it was.
    expect(await req("43d70405100104000000000000000000")).toEqual(["d60405100100"]);
    expect(await req("43d70405100101000000000000000000")).toEqual(["d60405100102"]);
    expect(await req("4281" + "4000" + "ff")).toEqual([]);
    expect(await req("43d70405100102000000000000000000")).toEqual([]);
    expect(sim.refusals.slice(2)).toEqual([
      "sim-refused A_Memory_Write 1 at 0x4000: into the segment of object 4, unloaded and not allocated again",
      "sim-refused A_PropertyValue_Write 4/5 02000000000000000000: load completed without an allocation after the unload",
    ]);
    expect(sim.refusals.slice(1, 2)).toEqual(["sim-refused A_PropertyValue_Read 4/7 of 1 from 1 after the unload of its load-state machine: what the unit reports there before the next allocation is not known"]);
  });

  test("answers a numbered frame without a connection with T_Disconnect, on the connection its restart ended as the unit does; another address does not acknowledge on layer 2", async () => {
    expect(await unit().send("4300")).toEqual(["81"]);
    const restarting = unit({ restart: { acknowledged: true, linkDownMs: 0, deadConnection: "nothing" } });
    await restarting.send("80");
    expect(await restarting.send("4380")).toEqual(["c2"]);
    expect(await restarting.send("4700")).toEqual([]);
    expect(await restarting.send("4300", 0x11fe)).toEqual(["81"]);
    expect(restarting.sim.refusals).toEqual([]);
    const { sim } = unit();
    const other = Buffer.from([0x11, 0x00, 0xb0, 0x60, TOOL >> 8, TOOL & 0xff, 0x11, 0x0b, 0x00, 0x80]);
    expect(await sim.sendCemi(other).then(() => "acknowledged", () => "not acknowledged")).toBe("not acknowledged");
  });

  test("answers the address broadcasts as far as its unit's captures show them; its restart ends programming mode, and the time and connection after it the captures do not show are refused", async () => {
    let clock = 0;
    const objects = new Map([[0, new Map([[14, p("00")], [11, p("000a45630b16")]])]]);
    const { sim, send } = unit({ objects, programmingMode: true, serialNumberResponseTail: Buffer.alloc(4), restart: { acknowledged: "layer2", linkDownMs: 40, linkUpMs: 1000, deadConnection: "unknown" } }, () => clock);
    const broadcasts: string[] = [];
    sim.onCemi = (_src, dst, tpdu, isGroup) => { if (isGroup) broadcasts.push(`${dst} ${tpdu.toString("hex")}`); };
    const broadcast = async (tpdu: string) => { await sim.sendCemi(cemiLDataGroup(TOOL, 0, Buffer.from(tpdu, "hex"))); await new Promise((r) => setTimeout(r, 5)); };
    await broadcast("0100");
    // The unit's serial number (object 0 PID 11), then another one.
    await broadcast("03dc000a45630b16");
    await broadcast("03dc000a45630b17");
    expect(broadcasts).toEqual(["0 0140", "0 03dd000a45630b1600000000"]);
    // Acknowledged on layer 2, no T_Ack; within 40 ms nothing acknowledged, before 1000 ms refused.
    await send("80");
    expect(await send("4380")).toEqual([]);
    clock = 39;
    expect(await sim.sendCemi(withSource(cemiLData(0, DEV, Buffer.from("81", "hex")), TOOL)).then(() => "OK", () => "NEG")).toBe("NEG");
    clock = 999;
    expect(await send("80")).toEqual([]);
    clock = 1000;
    expect(await send("4700")).toEqual([]);
    broadcasts.length = 0;
    await broadcast("0100");
    expect(broadcasts).toEqual([]);
    expect(sim.refusals).toEqual([
      "sim-refused 80 from 1.1.255 999 ms after the restart: whether the unit takes a frame then is not shown",
      "sim-refused numbered frame 4700 from 1.1.255 on the connection the restart ended: the unit's answer is not shown",
    ]);
    const { sim: unknown } = unit();
    await unknown.sendCemi(cemiLDataGroup(TOOL, 0, Buffer.from("0100", "hex")));
    expect(unknown.refusals).toEqual(["sim-refused A_IndividualAddress_Read 0100 from 1.1.255: whether the unit is in programming mode is not known"]);
  });
});

// ---- the simulated units against their own captures ----

const DEVICE = 0x1114;
interface Frame { dir: ">>" | "<<"; tpdu: string; con?: "OK" | "NEG"; ctrl?: number; to?: number; broadcast?: boolean }
// The cEMI frame of a capture line's KNXnet/IP frame.
const cemiOf = (hex: string) => { const f = Buffer.from(hex, "hex"); return f.subarray(f[0] + f[f[0]]); };
// The capture's L_Data frames, those from `from` (ms since the epoch) on.
function* tunnelFrames(text: string, from = 0) {
  for (const line of text.split("\n")) {
    const m = line.match(/\| ([0-9a-fA-F]+)\s*$/);
    const fr = m && line.includes("TUNNELLING_REQ") ? parseTunnelFrame(m[1]) : null;
    const at = Date.parse(line.split(" ")[0]);
    if (fr && at >= from) yield { line, fr, hex: m![1], at };
  }
}
// The L_Data frames of a capture between the tool and the unit at `device`: the tool's requests to it and its
// broadcasts (the address reads) with the interface's confirmation, the unit's frames to the interface and its
// broadcasts with their first control field. Group telegrams are left out: the simulator sends none.
function frames(text: string, tool: string, device = DEVICE, from = 0): Frame[] {
  const out: Frame[] = [];
  const pending: Frame[] = [];
  for (const { line, fr, hex } of tunnelFrames(text, from)) {
    if (fr.group && fr.dst !== 0) continue;
    const toUnit = fr.group || fr.dst === device;
    if (line.includes(`${tool}->BRIDGE`) && fr.code === 0x11 && toUnit) { const f: Frame = { dir: ">>", tpdu: fr.tpdu.toString("hex") }; out.push(f); pending.push(f); }
    else if (line.includes(`BRIDGE->${tool}`) && fr.code === 0x2e && toUnit) { const f = pending.shift(); if (f) f.con = line.includes("CON-NEG") ? "NEG" : "OK"; }
    else if (line.includes(`BRIDGE->${tool}`) && fr.code === 0x29 && fr.src === device) { const c = cemiOf(hex); out.push({ dir: "<<", tpdu: fr.tpdu.toString("hex"), ctrl: c[2 + c[1]], to: fr.dst, ...(fr.group ? { broadcast: true } : {}) }); }
  }
  return out;
}
const answerOf = (f: { ctrl?: number; tpdu: string; broadcast?: boolean }) => `${f.ctrl} ${f.broadcast ? "broadcast " : ""}${f.tpdu}`;

// Each request the tool sent the unit at `device` in a capture, and its address broadcasts, in order into `sim`
// on the capture's clock (`clock` sets the simulator's): the frames the simulator answers, as `answerOf` gives
// a captured frame, and how the line confirmed each request. The capture's own: the unit's frames in the same
// form and the interface's confirmations.
async function replay(sim: SimUnit, text: string, o: { tool: string; device: number; interfaceIa: number; clock: (at: number) => void; from?: number }) {
  const answered: string[] = [];
  const before = sim.onRawCemi;
  sim.onRawCemi = (c) => { const f = parseCemiLData(c); answered.push(answerOf({ ctrl: c[2 + c[1]], tpdu: f.tpdu.toString("hex"), broadcast: f.isGroup })); };
  const simFrames: string[] = [], simCons: string[] = [];
  try {
    for (const { line, fr, hex, at } of tunnelFrames(text, o.from)) {
      if (!line.includes(`${o.tool}->BRIDGE`) || fr.code !== 0x11 || (fr.group ? fr.dst !== 0 : fr.dst !== o.device)) continue;
      const cemi = Buffer.from(cemiOf(hex));
      // The bridge sends a frame from 0.0.0 from the tunnel's address.
      if (cemi.readUInt16BE(4) === 0) cemi.writeUInt16BE(o.interfaceIa, 4);
      o.clock(at);
      answered.length = 0;
      simCons.push(await sim.sendCemi(cemi).then(() => "OK", () => "NEG"));
      await new Promise((r) => setTimeout(r, 2));
      simFrames.push(...answered);
    }
  } finally { sim.onRawCemi = before; }
  const unit = frames(text, o.tool, o.device, o.from);
  return { simFrames, simCons, unitFrames: unit.filter((f) => f.dir === "<<").map(answerOf), unitCons: unit.filter((f) => f.dir === ">>").map((f) => f.con!), unit };
}

corpusDescribe("the simulated MEAN WELL KNX-40E-1280D", () => {
  // ETS 6's six downloads of the unit, in the order they ran on it (tools/etsdiff.test.ts): each request as ETS
  // sent it into one simulated unit, from the state its collection shows; the restart window runs on the
  // capture's clock.
  test("answers every request of ETS's six downloads as the unit did, and confirms each on the line as its interface did", async () => {
    let clock = 0;
    const sim = newSimUnit(MEANWELL_KNX40E, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
    for (const kind of ["links", "params", "revert", "fulldownload", "partial-maxtemp-on", "partial-maxtemp-off"]) {
      const { simFrames, simCons, unitFrames, unitCons, unit } = await replay(sim, captureText(`meanwell-ets-${kind}.log`), { tool: "ETS", device: DEVICE, interfaceIa: MEANWELL_KNX40E.interfaceIa, clock: (at) => { clock = at; } });
      expect([kind, unitFrames.length > 0]).toEqual([kind, true]);
      // The frame type of a long frame is the interface's to report: Busforge's bridge reports the extended
      // frames the unit sends, the KNXnet/IP interface of the two later captures a standard one; the priority is
      // the unit's on both.
      if (unit.find((f) => f.dir === "<<")!.to !== MEANWELL_KNX40E.interfaceIa) {
        const priority = (f: string) => f.replace(/^\d+/, (c) => String(Number(c) & 0x0c));
        unitFrames.splice(0, unitFrames.length, ...unitFrames.map(priority));
        simFrames.splice(0, simFrames.length, ...simFrames.map(priority));
      }
      expect([kind, simFrames.length, simCons]).toEqual([kind, unitFrames.length, unitCons]);
      expect([kind, simFrames]).toEqual([kind, unitFrames]);
    }
    expect(sim.refusals).toEqual([]);
  });

  // Busforge's full download through the KNXnet/IP server ETS connects to and the logging proxy the captures
  // are taken with: the server's own download task, the project's configuration of the unit. The capture of
  // the same download into the unit (captures/meanwell-busforge-fulldownload.log) holds the frames of the
  // build that took it, whose download into this simulator gives that capture frame for frame (the corpus's
  // internal/ets-sweep/spike.md); the differences of this build's frames are Busforge's own, named below.
  test("takes Busforge's full download through the KNXnet/IP server, every frame as the unit answered it", async () => {
    const sim = newSimUnit(MEANWELL_KNX40E);
    const fx = JSON.parse(captureText("meanwell-project.json")) as { ia: string; params: [string, string][]; links: { comObjNum: number; gaRaws: number[] }[] };
    const { outcome, log } = await busforgeFullDownload(MEANWELL_KNX40E, sim, { ia: fx.ia, params: new Map(fx.params), links: fx.links });
    if ("error" in outcome) throw new Error(outcome.error);
    const result = outcome.result;
    const unitDownload = frames(captureText("meanwell-busforge-fulldownload.log"), "Busforge");
    const simDownload = frames(log, "Busforge");
    expect(sim.refusals).toEqual([]);
    // The memory-control blocks the unit reported after the capture's download; the restart without a
    // T_Disconnect to prove it, as the unit took it.
    expect(result).toMatchObject({ kind: "flashed", verified: true, restartUnproven: true, stamps: [1, 2, 3, 4].map((obj) => ({ obj, hex: unitDownload.find((f) => f.dir === "<<" && f.tpdu.slice(2, 10) === `d60${obj}1b10`)!.tpdu.slice(12) })) });

    const unitPhases = phases(unitDownload), simPhases = phases(simDownload);
    // The segments in the order written: this build writes the parameter segment before the three tables, in
    // ETS's order (held against ETS's capture of the unit in tools/etsdiff.test.ts); the captured build wrote the
    // tables first.
    const writeOrder = (fs: Frame[]) => {
      const lsms = fs.flatMap((f) => {
        const t = Buffer.from(f.tpdu, "hex");
        const w = f.dir === ">>" && t.length >= 2 ? memWriteOf(t, ((t[0] & 0x03) << 8) | t[1]) : null;
        if (!w) return [];
        return [[1, 2, 3, 4].find((lsm) => { const s = sim.segment(lsm)!; return w.addr >= s.at && w.addr < s.at + s.bytes.length; }) ?? 0];
      });
      return lsms.filter((l, i) => lsms[i - 1] !== l);
    };
    expect(writeOrder(simPhases.bracket)).toEqual([4, 3, 2, 1]);
    expect(writeOrder(unitPhases.bracket)).toEqual([3, 2, 1, 4]);
    // From the first unload to the A_Restart: every request, every answer and every confirmation the unit's, the
    // parameter segment's run (object 4's two PID 7 reads and the segment's memory writes) taken before the tables'.
    expect(simPhases.bracket).toEqual(parameterSegmentFirst(unitPhases.bracket));
    // Before it this build also reads the association table's element form (object 2's PID 23 description).
    const at = simPhases.open.findIndex((f) => f.dir === ">>" && f.tpdu === "43d8021700");
    expect(simPhases.open.slice(at, at + 4)).toEqual([{ dir: ">>", tpdu: "43d8021700", con: "OK" }, { dir: "<<", tpdu: "c2", ctrl: 0xb0, to: 0x1164 }, { dir: "<<", tpdu: "43d90217031400ffff", ctrl: 0xbc, to: 0x1164 }, { dir: ">>", tpdu: "c2", con: "OK" }]);
    expect(simPhases.open.toSpliced(at, 4)).toEqual(unitPhases.open);
    // After the restart: probes on the dead connection, which the unit leaves without a frame (how many of
    // them its interface confirms negatively depends on the wall clock).
    for (const ph of [simPhases, unitPhases]) {
      expect(ph.probes.length).toBeGreaterThan(0);
      expect(ph.probes.every((f) => f.dir === ">>" && f.tpdu === "4300")).toBe(true);
    }
    // The verification on a new connection: this build proves every segment by its memory-control block
    // (PID 27 of objects 1 to 4), the captured one read the three tables back; every request both send is
    // answered as the unit answered it.
    const reqs = (fs: Frame[]) => fs.filter((f) => f.dir === ">>" && f.tpdu.length > 2).map((f) => f.tpdu);
    expect(reqs(simPhases.verify)).toEqual(["4300", "43d5011b1001", "43d5021b1001", "43d5031b1001", "43d504071001", "43d5041b1001"]);
    expect(reqs(unitPhases.verify)).toEqual(["4300", "43d501071001", "43d500381001", "42021002", "420e1002", "43d502071001", "42021404", "421a1404", "43d503071001", "42021c06", "42301c06", "421a1c36", "43d5041b1001"]);
    const answer = (fs: Frame[], req: string) => { const i = fs.findIndex((f) => f.dir === ">>" && f.tpdu === req); return fs.slice(i + 1).find((f) => f.dir === "<<" && f.tpdu.length > 2)?.tpdu; };
    const shared = reqs(simPhases.verify).filter((r) => reqs(unitPhases.verify).includes(r));
    expect(shared).toEqual(["4300", "43d5041b1001"]);
    for (const r of shared) expect([r, answer(simPhases.verify, r)]).toEqual([r, answer(unitPhases.verify, r)]);
  });
});

// ---- the System 7 units (MV-0705) ----

// Every byte a capture's tool wrote the unit at `device`, which the simulated unit must hold after its replay.
function heldWrites(sim: SimUnit, text: string, device: number): string[] {
  if (!(sim instanceof SimUnit0705)) throw new Error("not a System 7 unit");
  return [...memoryImage(parseCapture(text, device).writes)].filter(([a, b]) => sim.memory(a, 1)?.[0] !== b).map(([a]) => a.toString(16));
}

// ETS's three full downloads of the MDT BE-02001.02, in the order they ran on the unit, into one simulated unit
// from the state its collection shows, on the captures' clock.
corpusDescribe("the simulated MDT BE-02001.02", () => {
  test("answers every request of ETS's three full downloads as the unit did, and confirms each on the line as its interface did", async () => {
    let clock = 0;
    const sim = newSimUnit(MDT_BE02001, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
    for (const kind of ["defaults", "linked", "b7"]) {
      const text = captureText(`mdt-be02001-ets-fulldownload-${kind}.log`);
      const r = await replay(sim, text, { tool: "ETS", device: sim.deviceIa, interfaceIa: MDT_BE02001.interfaceIa, clock: (at) => { clock = at; } });
      // The b7 capture skips the bridge's frames 6 to 15 of the session before the download: it holds the unit's
      // answer to ETS's A_IndividualAddressSerialNumber_Read, but not the request.
      const unitFrames = kind === "b7" ? r.unitFrames.filter((f) => f !== "176 broadcast 03dd008380a0253100000000") : r.unitFrames;
      expect([kind, r.unitFrames.length - unitFrames.length]).toEqual([kind, kind === "b7" ? 1 : 0]);
      expect([kind, r.simCons]).toEqual([kind, r.unitCons]);
      expect([kind, r.simFrames]).toEqual([kind, unitFrames]);
      expect([kind, heldWrites(sim, text, sim.deviceIa)]).toEqual([kind, []]);
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
    const r = await replay(sim, text, { tool: "Busforge", device: sim.deviceIa, interfaceIa: MDT_BE02001.interfaceIa, clock: (at) => { clock = at; }, from: Date.parse("2026-11-19T17:29:36.366Z") });
    expect(r.simCons).toEqual(r.unitCons);
    expect(r.simFrames).toEqual(r.unitFrames);
    // The T_Disconnect right after the restart is the one frame not acknowledged; the address read before the
    // restart is answered, the one after it not.
    expect(r.unit.filter((f) => f.dir === ">>").map((f) => `${f.tpdu} ${f.con}`).filter((f) => f.endsWith("NEG") || f.startsWith("0100"))).toEqual(["0100 OK", "81 NEG", "0100 OK"]);
    expect(r.unitFrames.filter((f) => f.includes("broadcast"))).toEqual(["188 broadcast 0140"]);
    expect(sim.refusals).toEqual([]);
  });

  test("Busforge's full download of the defaults into a fresh unit: refused where Busforge reads back a write into a segment that is loading, which no capture of the unit shows", async () => {
    const sim = newSimUnit(MDT_BE02001);
    const { outcome } = await busforgeFullDownload(MDT_BE02001, sim, { ia: "1.1.56", params: new Map(), links: [] });
    expect(outcome).toEqual({ error: "DEVICE_NOT_ANSWERING: no reliable response (device not answering)" });
    expect(sim.refusals).toEqual(["sim-refused A_Memory_Read 1 at 0x4000: into the segment of object 1 while it is in load state 2, where no capture shows the unit answer a read"]);
  });
});

// ETS's full download of the Gira Tastsensor 3 Komfort, its partial form (the unit holds the application), into a
// simulated unit from the state its collection before it shows.
corpusDescribe("the simulated Gira Tastsensor 3 Komfort", () => {
  test("answers every request of ETS's full download as the unit did, and confirms each on the line as its interface did", async () => {
    let clock = 0;
    const sim = newSimUnit(GIRA_TS3, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
    const text = captureText("gira-m0008-ets-fulldownload.log");
    const r = await replay(sim, text, { tool: "ETS", device: sim.deviceIa, interfaceIa: GIRA_TS3.interfaceIa, clock: (at) => { clock = at; } });
    expect(r.unitFrames.length).toBeGreaterThan(0);
    expect(r.simCons).toEqual(r.unitCons);
    expect(r.simFrames).toEqual(r.unitFrames);
    expect(heldWrites(sim, text, sim.deviceIa)).toEqual([]);
    expect(sim.refusals).toEqual([]);
  });

  test("Busforge's full download of the captured configuration into a fresh unit: refused where Busforge reads back a write into a segment that is loading, which no capture of the unit shows", async () => {
    const sim = newSimUnit(GIRA_TS3);
    const { links, params } = giraM0008Configuration(parseAppConfig(catalogueXml(GIRA_TS3.catalogue)));
    const { outcome } = await busforgeFullDownload(GIRA_TS3, sim, { ia: "1.1.1", params, links });
    expect(outcome).toEqual({ error: "DEVICE_NOT_ANSWERING: no reliable response (device not answering)" });
    expect(sim.refusals).toEqual(["sim-refused A_Memory_Read 1 at 0x4000: into the segment of object 1 while it is in load state 2, where no capture shows the unit answer a read"]);
  });
});

// Busforge's full download of a configuration into `sim`, through the KNXnet/IP server ETS connects to and the
// logging proxy the captures are taken with, with the server's own download task: its result or its error's code
// and message, and the proxy's log once the session ended (its DISCONNECT_REQ).
async function busforgeFullDownload(spec: SimUnitSpec, sim: SimUnit, config: { ia: string; params: Map<string, string>; links: { comObjNum: number; gaRaws: number[] }[] }) {
  const dir = tempDir("busforge-sim-unit-");
  const port = await freePort();
  const server = new KnxIpServer({ transport: sim, maxApdu: spec.interfaceMaxApdu, port });
  const log = join(dir, "capture.log");
  const proxy = startProxy({ port: 0, bridgeHost: "127.0.0.1", bridgePort: port, log, tool: "Busforge" });
  try {
    await server.start();
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const proxyPort = (proxy.address() as { port: number }).port;
    const connection: Connection = { id: "sim", name: "sim", type: "ip", host: "127.0.0.1", port: proxyPort, ipTransport: "tcp", usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0 };
    const outcome = await downloadDeviceFull({ projectId: "p", deviceId: "d", ia: config.ia, appXml: catalogueXml(spec.catalogue), dataDir: dir, connection, params: config.params, links: config.links, comObjectOverrides: new Map(), dryRun: false })
      .then((result) => ({ result }), (e: unknown) => ({ error: e instanceof Error ? `${(e as { code?: string }).code ?? e.name}: ${e.message}` : String(e) }));
    // The session ends with its T_Disconnect after the result.
    for (let i = 0; !readFileSync(log, "utf8").includes("DISCONNECT_REQ"); i++) {
      if (i === 100) throw new Error("the session did not end within 10 s of the download's outcome");
      await new Promise((r) => setTimeout(r, 100));
    }
    return { outcome, log: readFileSync(log, "utf8") };
  } finally {
    proxy.close();
    await server.stop();
    removeTempDir(dir);
  }
}

// A download's frames in four parts: the session before the first load-state write, the bracket from it to the
// A_Restart, the probes after it until the next T_Connect, and the verification from there. Sequence numbers
// are left out: a request added before the bracket shifts them.
function phases(fs: Frame[]): { open: Frame[]; bracket: Frame[]; probes: Frame[]; verify: Frame[] } {
  const bare = fs.map((f) => ({ ...f, tpdu: Buffer.from([Buffer.from(f.tpdu, "hex")[0] & 0xc3]).toString("hex") + f.tpdu.slice(2) }));
  const start = bare.findIndex((f) => f.dir === ">>" && /^43d7..05/.test(f.tpdu));
  const restart = bare.findIndex((f) => f.dir === ">>" && /^4380/.test(f.tpdu));
  const reconnect = bare.findIndex((f, i) => i > restart && f.dir === ">>" && f.tpdu === "80");
  if (start < 0 || restart < start || reconnect < restart) throw new Error("the download has no bracket, restart and reconnection");
  return { open: bare.slice(0, start), bracket: bare.slice(start, restart + 1), probes: bare.slice(restart + 1, reconnect), verify: bare.slice(reconnect) };
}

// A bracket that writes the three tables before the parameter segment, with the parameter segment's run moved
// before the tables: from its first PID 7 read to the program id's write (object 4 PID 13), the tables' from the
// com-object table's PID 7 read to it.
function parameterSegmentFirst(fs: Frame[]): Frame[] {
  const req = (from: number, re: RegExp) => fs.findIndex((f, i) => i >= from && f.dir === ">>" && re.test(f.tpdu));
  const tables = req(0, /^43d503071001$/), parameters = req(tables, /^43d504071001$/), programId = req(parameters, /^43d7040d/);
  if (tables < 0 || parameters < 0 || programId < 0) throw new Error("the bracket has no table run, parameter segment run and program id");
  return [...fs.slice(0, tables), ...fs.slice(parameters, programId), ...fs.slice(tables, parameters), ...fs.slice(programId)];
}

// A port for the KNXnet/IP server, which takes a port number for its UDP socket and TCP listener alike.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
  });
}
