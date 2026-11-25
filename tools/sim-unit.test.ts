import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { cemiLData, cemiLDataGroup, crc16CcittFalse, parseCemiLData, withSource, type PropertyDescription } from "../packages/knx/src/index.ts";
import { buildDeviceConfig, parseAppConfig, placeComObjOverrides, type ComObjInstanceOverride, type ModuleInstance } from "../packages/product/src/index.ts";
import { flashDeviceParameters } from "../apps/server/src/deviceprofile.ts";
import { captureText, catalogueXml } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { captureLData, memWriteOf } from "./etsdiff.ts";
import { cemiOfLine, replayCapture, replayDifferences } from "./sim-unit-replay.ts";
import { busforgeIntoSim, busforgeSessionIntoSim, type RowConfiguration } from "./ets-sweep.ts";
import { SimUnit, type SimProperty, type SimUnitModel } from "./sim-unit.ts";
import { BENCH_BRIDGE, GVS_AMMA, JUNG_400021SE, MEANWELL_KNX40E, OPENKNX_RAUMCONTROLLER, THEBEN_DALI_GATEWAY, THEBEN_MIX2_HMG6T, THEBEN_MIX2_JMG4T, THEBEN_MIX2_RMG8T, newSimUnit, type SimUnitSpec } from "./sim-units.ts";

// The Busforge download below runs on the wall clock (the unit's line timing, the restart proof's 4 s window):
// about 15 s alone; twenty times that under a loaded full check (docs/testing.md, "Timeouts of heavy tests").
setDefaultTimeout(300_000);

const TOOL = 0x11ff, DEV = 0x110a;
const desc = (objectIndex: number, pid: number, propertyIndex: number, writable: boolean, pdt: number): PropertyDescription =>
  ({ objectIndex, pid, propertyIndex, writable, pdt, maxElements: 1, readLevel: 3, writeLevel: 3 });
const p = (...elements: string[]): SimProperty => ({ elements: elements.map((e) => Buffer.from(e, "hex")), countKnown: true });

// A unit with a device object and one application segment of four octets at 0x4000. `send` returns the
// unit's frames in answer; `ctrl` holds the first control field of each; `line` the interface's confirmation of
// the frame (OK or NEG) and the unit's frames in answer.
function unit(over: Partial<SimUnitModel> = {}, opts: ConstructorParameters<typeof SimUnit>[2] = {}): { sim: SimUnit; ctrl: number[]; send: (tpdu: string, from?: number, ctrl1?: number) => Promise<string[]>; line: (tpdu: string) => Promise<[string, string[]]> } {
  const segment = Buffer.from("01020304", "hex");
  const crc = crc16CcittFalse(segment);
  const model: SimUnitModel = {
    ia: DEV, mask: 0x07b0, maxApdu: 15,
    objects: new Map([
      [0, new Map([[14, p("00")], [56, p("000f")], [9, { elements: null, countKnown: true }]])],
      [4, new Map([[5, p("01")], [7, p("00004000")], [13, p("0000000000")], [27, p(`00000004${"00ff"}${crc.toString(16).padStart(4, "0")}`)]])],
    ]),
    descriptions: new Map([[0, [desc(0, 14, 2, true, 0x11), desc(0, 0, 3, false, 0)]]]),
    functionStates: new Map(),
    segments: new Map([[4, { at: 0x4000, size: 4, bytes: segment, mcbControl: Buffer.from("00ff", "hex") }]]),
    crc: "ccitt-false",
    authorize: new Map([["ffffffff", 0]]),
    restart: { basic: { acknowledged: true, tAck: "always" }, line: [{ atMs: 0, up: true }], deadConnection: "disconnect", confirmedRestartSeconds: null }, link: { ackMs: 0, nakMs: 0 },
    unloadStopsApplication: true, descriptionIndex: "property", clearsAfterRestart: [], shownWrites: new Map(), memoryExtendedRead: false, memoryExtendedWrite: false,
    programmingMode: null, serialNumberResponseTail: null,
    ...over,
  };
  const sim = new SimUnit(model, TOOL, opts);
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
  const line = async (tpdu: string): Promise<[string, string[]]> => {
    const before = frames.length;
    const con = await sim.sendCemi(withSource(cemiLData(0, DEV, Buffer.from(tpdu, "hex")), TOOL)).then(() => "OK", () => "NEG");
    await new Promise((r) => setTimeout(r, 5));
    return [con, frames.slice(before)];
  };
  return { sim, ctrl, send, line };
}

// Numbered requests on one connection: each request's answers without the unit's T_Ack, each acknowledged in turn.
function numbered(send: (tpdu: string) => Promise<string[]>): (apdu: string) => Promise<string[]> {
  let seq = 0;
  return async (apdu: string) => {
    const t = Buffer.from(apdu, "hex"); t[0] |= seq << 2;
    const answers = (await send(t.toString("hex"))).filter((f) => f.length > 2);
    for (const a of answers) await send(Buffer.from([0xc2 | (Buffer.from(a, "hex")[0] & 0x3c)]).toString("hex"));
    seq = (seq + 1) & 0x0f;
    return answers.map((f) => f.slice(2));
  };
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
    const restarting = unit({ restart: { basic: { acknowledged: true, tAck: "always" }, line: [{ atMs: 0, up: true }], deadConnection: "nothing", confirmedRestartSeconds: null } });
    await restarting.send("80");
    expect(await restarting.send("4380")).toEqual(["c2"]);
    expect(await restarting.send("4700")).toEqual([]);
    expect(await restarting.send("4300", 0x11fe)).toEqual(["81"]);
    expect(restarting.sim.refusals).toEqual([]);
    const { sim } = unit();
    const other = Buffer.from([0x11, 0x00, 0xb0, 0x60, TOOL >> 8, TOOL & 0xff, 0x11, 0x0b, 0x00, 0x80]);
    expect(await sim.sendCemi(other).then(() => "acknowledged", () => "not acknowledged")).toBe("not acknowledged");
  });

  test("times a confirmed restart's line from the T_Ack's arrival, however late the unit takes it", async () => {
    let clock = 0;
    const { sim, send, line } = unit({ restart: { basic: null, line: [{ atMs: 20, up: false }, { atMs: 40, up: true }], deadConnection: null, confirmedRestartSeconds: 1 }, link: { ackMs: 30, nakMs: 60 } }, { now: () => clock });
    await send("80");
    expect(await send("43810100")).toEqual(["c2", "43a1000001"]);
    clock = 1000;
    // The unit takes the T_Ack link.ackMs later; the clock has run on by 40 ms meanwhile.
    const ack = send("c2");
    setTimeout(() => { clock = 1040; }, 10);
    expect(await ack).toEqual([]);
    // 45 ms after the T_Ack arrived (35 ms after the unit took it): the line is up.
    clock = 1045;
    expect((await line("80"))[0]).toBe("OK");
    expect(sim.refusals).toEqual([]);
  });

  test("answers a confirmed restart and restarts once the answer is acknowledged; its line after it as shown, refused where nothing is shown", async () => {
    let clock = 0;
    const { sim, send, line } = unit({ restart: { basic: null, line: [{ atMs: 20, up: false }, { atMs: 40, up: false }, { atMs: 100, up: true }], deadConnection: null, confirmedRestartSeconds: 1 } }, { now: () => clock });
    await send("80");
    // A basic restart is refused where it is not shown, without a T_Ack.
    expect(await send("4380")).toEqual([]);
    expect(await send("4781")).toEqual(["c6"]);
    expect(await send("4b810100")).toEqual(["ca", "43a1000001"]);
    clock = 1000;
    expect(await send("c2")).toEqual([]);
    for (const [at, expected] of [[1010, "NEG"], [1030, "NEG"], [1050, "NEG"], [1100, "OK"]] as const) {
      clock = at;
      expect([at, (await line("4300"))[0]]).toEqual([at, expected]);
    }
    expect(sim.refusals).toEqual([
      "sim-refused A_Restart: how the unit takes a basic restart is not shown",
      "sim-refused A_Restart type 1 : only the basic restart and the confirmed restart (erase code 1, channel 0) on a connection are modelled",
      "sim-refused 4300 10 ms after the restart: whether the unit acknowledges a frame then is not shown",
      "sim-refused 4300 50 ms after the restart: whether the unit acknowledges a frame then is not shown",
      "sim-refused numbered frame 4300 from 1.1.255 on the connection the restart ended: what the unit answers it is not shown",
    ]);
  });

  test("writes a segment past 64 KB with A_MemoryExtended_Write, and reports a memory-control block in the blocks written while loading", async () => {
    const { sim, send } = unit({
      maxApdu: 55,
      objects: new Map([
        [0, new Map([[14, p("00")]])],
        [4, new Map([[5, p("01")], [7, p("00014000")], [27, p("000000030033aaaa", "000000010133bbbb")]])],
      ]),
      segments: new Map([[4, { at: 0x14000, size: 4, bytes: Buffer.from("01020304", "hex"), mcbControl: null }]]),
      unloadStopsApplication: null, memoryExtendedWrite: true,
    });
    await send("80");
    const req = numbered(send);
    expect(await req("43d70405100104000000000000000000")).toEqual(["d60405100100"]);
    // What the device control reports after the application's unload is not shown here.
    expect(await req("43d5000e1001")).toEqual([]);
    expect(await req("43d70405100101000000000000000000")).toEqual(["d60405100102"]);
    expect(await req("43d704051001030b0000000401000000")).toEqual(["d60405100102"]);
    expect(await req("43d7041b10010000000300320000")).toEqual(["d6041b10010000000300320000"]);
    expect(await req("43d7041b10020000000101330000")).toEqual(["d6041b10020000000101330000"]);
    expect(await req("41fb040140000a0b0c0d")).toEqual(["fc00014000"]);
    expect(await req("43d70405100102000000000000000000")).toEqual(["d60405100101"]);
    const crc = (hex: string) => crc16CcittFalse(Buffer.from(hex, "hex")).toString(16).padStart(4, "0");
    expect(await req("43d5041b2001")).toEqual([`d6041b2001${"00000003" + "0032" + crc("0a0b0c")}${"00000001" + "0133" + crc("0d")}`]);
    expect(sim.segment(4)?.bytes.toString("hex")).toBe("0a0b0c0d");
    expect(sim.refusals).toEqual(["sim-refused A_PropertyValue_Read 0/14 of 1 from 1 after the unload of the application: what the unit reports then is not shown"]);
  });

  test("answers the address broadcasts as far as its unit's captures show them; its restart ends programming mode, and the time and connection after it the captures do not show are refused", async () => {
    let clock = 0;
    const objects = new Map([[0, new Map([[14, p("00")], [11, p("000a45630b16")]])]]);
    const { sim, send } = unit({ objects, programmingMode: true, serialNumberResponseTail: Buffer.alloc(4), restart: { basic: { acknowledged: true, tAck: "never" }, line: [{ atMs: 0, up: false }, { atMs: 39, up: false }, { atMs: 1000, up: true }], deadConnection: null, confirmedRestartSeconds: null } }, { now: () => clock });
    const broadcasts: string[] = [];
    sim.onCemi = (_src, dst, tpdu, isGroup) => { if (isGroup) broadcasts.push(`${dst} ${tpdu.toString("hex")}`); };
    const broadcast = async (tpdu: string) => { await sim.sendCemi(cemiLDataGroup(TOOL, 0, Buffer.from(tpdu, "hex"))); await new Promise((r) => setTimeout(r, 5)); };
    await broadcast("0100");
    // The unit's serial number (object 0 PID 11), then another one.
    await broadcast("03dc000a45630b16");
    await broadcast("03dc000a45630b17");
    expect(broadcasts).toEqual(["0 0140", "0 03dd000a45630b1600000000"]);
    // Acknowledged on layer 2, no T_Ack; up to 39 ms nothing acknowledged, before 1000 ms refused.
    await send("80");
    expect(await send("4380")).toEqual([]);
    clock = 39;
    expect(await sim.sendCemi(withSource(cemiLData(0, DEV, Buffer.from("81", "hex")), TOOL)).then(() => "OK", () => "NEG")).toBe("NEG");
    clock = 999;
    expect(await sim.sendCemi(withSource(cemiLData(0, DEV, Buffer.from("80", "hex")), TOOL)).then(() => "OK", () => "NEG")).toBe("NEG");
    clock = 1000;
    expect(await send("4700")).toEqual([]);
    broadcasts.length = 0;
    await broadcast("0100");
    expect(broadcasts).toEqual([]);
    expect(sim.refusals).toEqual([
      "sim-refused 80 999 ms after the restart: whether the unit acknowledges a frame then is not shown",
      "sim-refused numbered frame 4700 from 1.1.255 on the connection the restart ended: what the unit answers it is not shown",
    ]);
    // A programming mode the captures do not show stays unknown after a restart.
    const { sim: unknown, send: sendUnknown } = unit();
    await sendUnknown("80");
    await sendUnknown("4380");
    await unknown.sendCemi(cemiLDataGroup(TOOL, 0, Buffer.from("0100", "hex")));
    expect(unknown.refusals).toEqual(["sim-refused A_IndividualAddress_Read 0100 from 1.1.255: whether the unit is in programming mode is not known"]);
  });

  test("leaves a frame longer than the interface carries unsent, and closes a connection idle for 6 s on its own clock", async () => {
    let clock = 0;
    const { sim, send, line } = unit({}, { now: () => clock, interfaceMaxApdu: 15 });
    await send("80");
    expect(await line("4281400000000000000000000000000000")).toEqual(["NEG", []]);
    clock = 6_000;
    expect(await send("4300")).toEqual(["81", "81"]);
    expect(sim.refusals).toEqual([]);
  });
});

// ---- each simulated unit against ETS's captures of the real unit ----

interface Frame { dir: ">>" | "<<"; tpdu: string; con?: "OK" | "NEG"; ctrl?: number; to?: number }
// The L_Data frames of a capture between the tool and the unit: the tool's requests with the interface's
// confirmation, the unit's frames to the interface with their first control field.
function frames(text: string, tool: string, device: number): Frame[] {
  const out: Frame[] = [];
  const pending: Frame[] = [];
  for (const fr of captureLData(text, tool)) {
    if (fr.group) continue;
    if (fr.fromTool && fr.code === 0x11 && fr.dst === device) { const f: Frame = { dir: ">>", tpdu: fr.tpdu.toString("hex") }; out.push(f); pending.push(f); }
    else if (!fr.fromTool && fr.code === 0x2e && fr.dst === device) { const f = pending.shift(); if (f) f.con = fr.line.includes("CON-NEG") ? "NEG" : "OK"; }
    else if (!fr.fromTool && fr.code === 0x29 && fr.src === device) { const c = cemiOfLine(fr.line); out.push({ dir: "<<", tpdu: fr.tpdu.toString("hex"), ctrl: c[2 + c[1]], to: fr.dst }); }
  }
  return out;
}

// The frame type of a long frame is the interface's to report: Busforge's bench bridge reports the extended frames a
// unit sends, the house's KNXnet/IP interface a standard one; the priority is the unit's on both. Where the unit's
// frames went elsewhere than to the bridge, a frame (`b0 434007b0`) is compared by its priority.
function framesAsReported(text: string, device: number): (frame: string) => string {
  const viaBridge = [...captureLData(text, "ETS")].some((fr) => !fr.fromTool && fr.code === 0x29 && fr.src === device && fr.dst === BENCH_BRIDGE.ia);
  return viaBridge ? (f) => f : (f) => f.replace(/^[0-9a-f]{2}/, (c) => (parseInt(c, 16) & 0x0c).toString(16).padStart(2, "0"));
}

// Each unit's ETS captures in the order they ran on it, from the state its collection shows (with what its
// captures show different, sim-units.ts) or the other collection of the unit named, and the requests at their ends
// the interface confirmed after the capture ended: ETS's last T_Disconnect after the confirmed restart of the MIX 2
// units' downloads and of the GVS AMMA's download, and ETS's T_Ack of the RMG 8 T's restart response at the end of
// its parameter download. Such requests are not sent, but for the captures in `sentUnconfirmed`, whose last
// request the unit took (the T_Ack: the next capture finds it restarted), where the simulator's confirmation of them
// is not compared and its frames are.
const CALIBRATIONS: { spec: SimUnitSpec; captures: string[]; collection?: string; unconfirmed?: Record<string, number>; sentUnconfirmed?: string[] }[] = [
  { spec: MEANWELL_KNX40E, captures: ["links", "params", "revert", "fulldownload", "partial-maxtemp-on", "partial-maxtemp-off"].map((k) => `meanwell-ets-${k}.log`) },
  { spec: THEBEN_DALI_GATEWAY, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert", "unload", "fulldownload-real"].map((k) => `dali-ets-${k}.log`) },
  { spec: OPENKNX_RAUMCONTROLLER, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `openknx-ets-${k}.log`) },
  {
    spec: THEBEN_MIX2_HMG6T, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert", "partial-diag-on", "partial-diag-off"].map((k) => `mix2-hmg6t-ets-${k}.log`),
    unconfirmed: { "mix2-hmg6t-ets-fulldownload.log": 1, "mix2-hmg6t-ets-partial-links.log": 1 },
  },
  { spec: JUNG_400021SE, captures: ["jung-400021se-ets-fulldownload.log"] },
  { spec: GVS_AMMA, captures: ["gvs-amma-ets-fulldownload-defaults.log"], unconfirmed: { "gvs-amma-ets-fulldownload-defaults.log": 1 } },
  {
    spec: THEBEN_MIX2_JMG4T, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `mix2-jmg4t-ets-${k}.log`),
    unconfirmed: { "mix2-jmg4t-ets-fulldownload.log": 1, "mix2-jmg4t-ets-partial-params.log": 1, "mix2-jmg4t-ets-partial-links.log": 1 },
  },
  {
    spec: THEBEN_MIX2_RMG8T, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `mix2-rmg8t-ets-${k}.log`),
    unconfirmed: { "mix2-rmg8t-ets-partial-params.log": 1, "mix2-rmg8t-ets-partial-links.log": 1 }, sentUnconfirmed: ["mix2-rmg8t-ets-partial-params.log"],
  },
  {
    spec: THEBEN_MIX2_RMG8T, collection: "internal/release-readiness/22-house/1.1.53/1.1.53-collect-vor-77.json", captures: ["partial-diag-on", "partial-diag-off"].map((k) => `mix2-rmg8t-ets-${k}.log`),
    unconfirmed: { "mix2-rmg8t-ets-partial-diag-off.log": 1 },
  },
];

for (const { spec, captures, collection, unconfirmed = {}, sentUnconfirmed = [] } of CALIBRATIONS) {
  corpusDescribe(`the simulated ${spec.name} against ETS's captures${collection ? ` from ${collection}` : ""}`, () => {
    // Each request as ETS sent it into one simulated unit, from the state its collection shows; the restart and
    // the connection timeout run on the capture's clock.
    test("answers every request as the unit did, and confirms each on the line as its interface did", async () => {
      let clock = 0;
      const sim = newSimUnit(spec, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } }, collection);
      for (const capture of captures) {
        const text = captureText(capture);
        const sent = sentUnconfirmed.includes(capture);
        const steps = await replayCapture(sim, text, { tool: "ETS", device: sim.deviceIa, interfaceIa: spec.interfaceIa, clock: (ms) => { clock = ms; }, skipUnconfirmedEnd: !sent });
        const shown = framesAsReported(text, sim.deviceIa);
        const reported = steps.map((s) => ({ ...s, unit: s.unit.map(shown), sim: s.sim.map(shown), simCon: sent && s.unitCon === undefined ? undefined : s.simCon }));
        expect([capture, steps.filter((s) => s.unitCon === undefined).length, steps.some((s) => s.unit.length > 0)]).toEqual([capture, unconfirmed[capture] ?? 0, true]);
        expect([capture, replayDifferences(reported, { context: 3 })]).toEqual([capture, []]);
      }
      expect(sim.refusals).toEqual([]);
    });
  });
}

const MEANWELL_DEVICE = 0x1114;

corpusDescribe("the simulated MEAN WELL KNX-40E-1280D", () => {
  // Busforge's full download through the KNXnet/IP server ETS connects to and the logging proxy the captures
  // are taken with: the server's own download task, the project's configuration of the unit. The capture of
  // the same download into the unit (captures/meanwell-busforge-fulldownload.log) holds the frames of the
  // build that took it, whose download into this simulator gives that capture frame for frame (the corpus's
  // internal/ets-sweep/spike.md); the differences of this build's frames are Busforge's own, named below.
  test("takes Busforge's full download through the KNXnet/IP server, every frame as the unit answered it", async () => {
    const fx = JSON.parse(captureText("meanwell-project.json")) as { ia: string; params: [string, string][]; links: { comObjNum: number; gaRaws: number[] }[] };
    const { result, capture, sim } = await busforgeIntoSim(MEANWELL_KNX40E, fx);
    const unitDownload = frames(captureText("meanwell-busforge-fulldownload.log"), "Busforge", MEANWELL_DEVICE);
    const simDownload = frames(capture, "Busforge", MEANWELL_DEVICE);
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
    // parameter segment's run (object 4's two PID 7 reads and the segment's memory writes) taken before the tables',
    // the device control aside.
    expect(withoutDeviceControl(simPhases.bracket)).toEqual(parameterSegmentFirst(withoutDeviceControl(unitPhases.bracket)));
    // The device control: the captured build switched verify mode on before the bracket and off at its end; this
    // build switches it on as ETS does, right after the parameter segment's PID 7 read before its first memory write,
    // and leaves it to the restart. The unit answers it as it answered ETS (meanwell-ets-fulldownload.log): 01 after the
    // unload, 05 to the write. Busforge reads and writes it as ETS does, nothing before or after.
    const control = (fs: Frame[]) => fs.filter((f) => f.tpdu.length > 2 && /^4[23]d[567]000e/.test(f.tpdu)).map((f) => f.tpdu.slice(2));
    const etsControl = frames(captureText("meanwell-ets-fulldownload.log"), "ETS", MEANWELL_DEVICE).map((f) => ({ ...f, tpdu: Buffer.from([Buffer.from(f.tpdu, "hex")[0] & 0xc3]).toString("hex") + f.tpdu.slice(2) }));
    expect(control(etsControl)).toEqual(["d5000e1001", "d6000e100101", "d7000e100105", "d6000e100105"]);
    expect(control(simPhases.bracket)).toEqual(control(etsControl));
    const firstWrite = simPhases.bracket.findIndex((f) => {
      const t = Buffer.from(f.tpdu, "hex");
      return f.dir === ">>" && t.length >= 2 && memWriteOf(t, ((t[0] & 0x03) << 8) | t[1]) !== null;
    });
    const controlAt = simPhases.bracket.findIndex((f) => f.dir === ">>" && f.tpdu === "43d5000e1001");
    expect(simPhases.bracket.slice(0, controlAt).findLast((f) => f.dir === ">>" && f.tpdu.length > 2)?.tpdu).toBe("43d504071001");
    expect(withoutDeviceControl(simPhases.bracket.slice(controlAt, firstWrite))).toEqual([]);
    expect(control(unitPhases.bracket)).toEqual(["d5000e1001", "d6000e100105", "d7000e100101", "d6000e100101", "d5000e1001", "d6000e100101"]);
    // Before it this build also reads the association table's element form (object 2's PID 23 description), and not the
    // device control.
    expect(control(simPhases.open)).toEqual([]);
    const simOpen = withoutDeviceControl(simPhases.open);
    const at = simOpen.findIndex((f) => f.dir === ">>" && f.tpdu === "43d8021700");
    expect(simOpen.slice(at, at + 4)).toEqual([{ dir: ">>", tpdu: "43d8021700", con: "OK" }, { dir: "<<", tpdu: "c2", ctrl: 0xb0, to: 0x1164 }, { dir: "<<", tpdu: "43d90217031400ffff", ctrl: 0xbc, to: 0x1164 }, { dir: ">>", tpdu: "c2", con: "OK" }]);
    expect(simOpen.toSpliced(at, 4)).toEqual(withoutDeviceControl(unitPhases.open));
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

  // Busforge's parameter flash into the unit its full download left, against ETS's parameter download into the unit
  // (meanwell-ets-params.log): the device control read and written back with bit 2 right before the first memory
  // write, the unit's answers as it answered ETS, and no memory read from there to the restart, as ETS reads none.
  test("takes Busforge's parameter flash with the device control as ETS's parameter download, no memory read back before the restart", async () => {
    const fx = JSON.parse(captureText("meanwell-project.json")) as { ia: string; params: [string, string][]; links: { comObjNum: number; gaRaws: number[] }[] };
    const { sim } = await busforgeIntoSim(MEANWELL_KNX40E, fx);
    const params = new Map(fx.params);
    const changed = new Map(params).set("M-0162_A-0004-11-F245_P-29_R-29", "1810"); // the maximum tracking time ETS's capture changes
    const { value: result, capture } = await busforgeSessionIntoSim(sim, MEANWELL_KNX40E, (connection, dataDir) => flashDeviceParameters({
      projectId: "sim", deviceId: "row", ia: fx.ia, appXml: catalogueXml(MEANWELL_KNX40E.catalogue), dataDir, connection,
      params: changed, baseParams: params, dryRun: false, neverProgrammed: false,
    }), () => true);
    expect(sim.refusals).toEqual([]);
    expect(result).toMatchObject({ kind: "flashed", verified: true });
    // From the first load-state write to the A_Restart, sequence numbers left out (ETS opens no connection after it).
    const bracket = (fs: Frame[]) => {
      const bare = fs.map((f) => ({ ...f, tpdu: Buffer.from([Buffer.from(f.tpdu, "hex")[0] & 0xc3]).toString("hex") + f.tpdu.slice(2) }));
      return bare.slice(bare.findIndex((f) => f.dir === ">>" && /^43d7..05/.test(f.tpdu)), bare.findIndex((f) => f.dir === ">>" && /^4380/.test(f.tpdu)) + 1);
    };
    const ours = bracket(frames(capture, "Busforge", MEANWELL_DEVICE));
    const ets = bracket(frames(captureText("meanwell-ets-params.log"), "ETS", MEANWELL_DEVICE));
    expect([ours.length > 0, ets.length > 0, ours.at(-1)?.tpdu, ets.at(-1)?.tpdu]).toEqual([true, true, "4380", "4380"]);
    const control = (fs: Frame[]) => fs.filter((f) => /^4[23]d[567]000e/.test(f.tpdu)).map((f) => f.tpdu.slice(2));
    const memoryWrite = (f: Frame) => { const t = Buffer.from(f.tpdu, "hex"); return f.dir === ">>" && t.length >= 2 && memWriteOf(t, ((t[0] & 0x03) << 8) | t[1]) !== null; };
    const memoryRead = (f: Frame) => { const t = Buffer.from(f.tpdu, "hex"); return f.dir === ">>" && t.length >= 4 && (((t[0] & 0x03) << 8) | (t[1] & 0xc0)) === 0x200; }; // A_Memory_Read
    expect(control(ets)).toEqual(["d5000e1001", "d6000e100101", "d7000e100105", "d6000e100105"]);
    expect(control(ours)).toEqual(control(ets));
    for (const [tool, fs] of [["ETS", ets], ["Busforge", ours]] as const) {
      const at = fs.findIndex(memoryWrite);
      const write = fs.findLastIndex((f) => f.dir === ">>" && f.tpdu === "43d7000e100105");
      expect([tool, write < at, fs.slice(at).filter(memoryRead)]).toEqual([tool, true, []]);
    }
  });
});

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

// Frames without the device-control exchanges (object 0 PID 14): each request, the unit's T_ACK, its answer, ours.
function withoutDeviceControl(fs: Frame[]): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < fs.length; i++) {
    if (!(fs[i].dir === ">>" && /^43d[57]000e/.test(fs[i].tpdu))) { out.push(fs[i]); continue; }
    const answer = fs.findIndex((f, j) => j > i && f.dir === "<<" && /^43d6000e/.test(f.tpdu));
    if (answer < 0 || fs.slice(i + 1, answer).some((f) => f.tpdu !== "c2") || fs[answer + 1]?.tpdu !== "c2") throw new Error(`a device-control request at frame ${i} without its answer and acknowledgements`);
    i = answer + 1;
  }
  return out;
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

// ---- Busforge's own full download into each simulated unit ----

// What Busforge's restart proof sends that the unit's captures do not show the answer to, its wall-clock times left
// out: a frame in the time after the restart no capture shows the line in, and a probe on the connection the
// restart ended (ETS sends none there).
const NOT_SHOWN_AFTER_RESTART = "after the restart: whether the unit acknowledges a frame then is not shown";
const NOT_SHOWN_DEAD_CONNECTION = "on the connection the restart ended: what the unit answers it is not shown";
const refusalKind = (r: string) => [NOT_SHOWN_AFTER_RESTART, NOT_SHOWN_DEAD_CONNECTION].find((k) => r.endsWith(k)) ?? r;

// The project's configuration of a Theben MIX 2 unit as its full-download capture shows it (`mix2-<unit>-config.json`).
function mix2Config(spec: SimUnitSpec, unit: string): RowConfiguration {
  const fx = JSON.parse(captureText(`mix2-${unit}-config.json`)) as { ia: string; params: [string, string][]; instances: ModuleInstance[]; links: { comObjNum: number; gaRaws: number[] }[]; overrides: { comObjRefId: string; attrs: Record<string, string> }[] };
  const cfg = parseAppConfig(catalogueXml(spec.catalogue));
  const overrides = placeComObjOverrides(cfg, buildDeviceConfig(cfg, new Map(fx.params), undefined, fx.instances), fx.overrides);
  return { ia: fx.ia, params: fx.params, links: fx.links, moduleInstances: fx.instances, comObjectOverrides: [...overrides] };
}

// The configuration ETS downloaded in each unit's full-download capture (tools/etsdiff.test.ts, "System B full
// download: the bytes ETS writes, and no other", holds Busforge's image to it): the projects' configurations of the
// Theben and OpenKNX units, the application's defaults on the Jung and the GVS. `stamps` are the memory-control
// blocks of the download's closing reads before the restart (its record, as ETS's LdCtrlLoadImageProp reads them);
// `refusals` what of its restart proof no capture shows.
const DOWNLOADS: { spec: SimUnitSpec; config: () => RowConfiguration; stamps: string[]; refusals: string[] }[] = [
  {
    spec: THEBEN_DALI_GATEWAY, config: () => {
      const fx = JSON.parse(captureText("dali-gateway-unit-fulldownload.json")) as { ia: string; params: [string, string][]; instances: ModuleInstance[]; links: { comObjNum: number; gaRaws: number[] }[]; overrides: [number, ComObjInstanceOverride][] };
      return { ia: fx.ia, params: fx.params, links: fx.links, moduleInstances: fx.instances, comObjectOverrides: fx.overrides };
    },
    stamps: ["1:000000700133ee28", "2:0000011a01333261", "3:00000a8001338da7", "4:00000c5000334f75"],
    refusals: [NOT_SHOWN_AFTER_RESTART, NOT_SHOWN_DEAD_CONNECTION],
  },
  {
    spec: OPENKNX_RAUMCONTROLLER, config: () => JSON.parse(captureText("openknx-config.json")) as RowConfiguration,
    stamps: ["4:0000546100ff0962"],
    refusals: [NOT_SHOWN_AFTER_RESTART, NOT_SHOWN_DEAD_CONNECTION],
  },
  {
    spec: THEBEN_MIX2_HMG6T, config: () => mix2Config(THEBEN_MIX2_HMG6T, "hmg6t"),
    stamps: ["1:0000007200331460", "2:000001260033610f", "3:000001fe0033e64b", "4:0000066a0032284d", "4:000001690032304e"],
    refusals: [],
  },
  {
    spec: THEBEN_MIX2_JMG4T, config: () => mix2Config(THEBEN_MIX2_JMG4T, "jmg4t"),
    stamps: ["1:0000002c0033766c", "2:0000005a00339bcd", "3:000001fe00337928", "4:0000066a003269b7", "4:000001690032304e"],
    refusals: [],
  },
  {
    spec: THEBEN_MIX2_RMG8T, config: () => mix2Config(THEBEN_MIX2_RMG8T, "rmg8t"),
    stamps: ["1:0000003c0033a2ac", "2:000000760033306f", "3:000001fe0033841d", "4:0000066a003276be", "4:000001690032304e"],
    refusals: [],
  },
  {
    spec: JUNG_400021SE, config: () => ({ ia: "1.1.204", params: [], links: [] }),
    stamps: ["1:00000002003384c0", "2:00000002003384c0", "3:00000a600033f25f", "4:00001e140033c73a", "4:000000010133dcbd"],
    refusals: [],
  },
  {
    spec: GVS_AMMA, config: () => ({ ia: "1.1.203", params: [], links: [] }),
    stamps: ["1:0000000200321d0f", "2:0000000200321d0f", "3:0000042a003233da", "4:00000b000032d5f7"],
    refusals: [NOT_SHOWN_AFTER_RESTART, NOT_SHOWN_DEAD_CONNECTION],
  },
];

for (const { spec, config, stamps, refusals } of DOWNLOADS) {
  corpusDescribe(`Busforge's full download into the simulated ${spec.name}`, () => {
    test("is taken and verified; what its restart proof meets that no capture shows is refused", async () => {
      const run = await busforgeIntoSim(spec, config());
      expect({ refused: run.refused, error: run.error }).toEqual({ refused: null, error: null });
      expect(run.result).toMatchObject({ kind: "flashed", verified: true });
      expect(run.result?.kind === "flashed" ? run.result.stamps?.map((s) => `${s.obj}:${s.hex}`) : run.result).toEqual(stamps);
      expect([...new Set(run.refusals.map(refusalKind))].sort()).toEqual([...refusals].sort());
    });
  });
}
