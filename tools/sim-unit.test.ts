import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { cemiLData, crc16CcittFalse, parseCemiLData, withSource, type PropertyDescription } from "../packages/knx/src/index.ts";
import { buildDeviceConfig, parseAppConfig, placeComObjOverrides, type ComObjInstanceOverride, type ModuleInstance } from "../packages/product/src/index.ts";
import { captureText, catalogueXml } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { captureLData, memWriteOf, parseTunnelFrame } from "./etsdiff.ts";
import { busforgeIntoSim, type RowConfiguration } from "./ets-sweep.ts";
import { SimUnit, type SimProperty, type SimUnitModel } from "./sim-unit.ts";
import { GVS_AMMA, JUNG_400021SE, MEANWELL_KNX40E, OPENKNX_RAUMCONTROLLER, THEBEN_DALI_GATEWAY, THEBEN_MIX2_HMG6T, newSimUnit, type SimUnitSpec } from "./sim-units.ts";

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
    unloadStopsApplication: true, descriptionIndex: "property", clearsAfterRestart: [],
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

  test("answers a confirmed restart and restarts once the answer is acknowledged; its line after it as shown, refused where nothing is shown", async () => {
    let clock = 0;
    const { sim, send, line } = unit({ restart: { basic: null, line: [{ atMs: 20, up: false }, { atMs: 40, up: false }, { atMs: 100, up: true }], deadConnection: null, confirmedRestartSeconds: 1 } }, { now: () => clock });
    await send("80");
    // A basic restart is refused where it is not shown.
    expect(await send("4380")).toEqual(["c2"]);
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
      unloadStopsApplication: null,
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
// The cEMI frame of a capture line's KNXnet/IP frame.
const cemiOf = (line: string) => { const f = Buffer.from(line.match(/\| ([0-9a-fA-F]+)\s*$/)![1], "hex"); return f.subarray(f[0] + f[f[0]]); };
// The L_Data frames of a capture between the tool and the unit: the tool's requests with the interface's
// confirmation, the unit's frames to the interface with their first control field.
function frames(text: string, tool: string, device: number): Frame[] {
  const out: Frame[] = [];
  const pending: Frame[] = [];
  for (const fr of captureLData(text, tool)) {
    if (fr.group) continue;
    if (fr.fromTool && fr.code === 0x11 && fr.dst === device) { const f: Frame = { dir: ">>", tpdu: fr.tpdu.toString("hex") }; out.push(f); pending.push(f); }
    else if (!fr.fromTool && fr.code === 0x2e && fr.dst === device) { const f = pending.shift(); if (f) f.con = fr.line.includes("CON-NEG") ? "NEG" : "OK"; }
    else if (!fr.fromTool && fr.code === 0x29 && fr.src === device) { const c = cemiOf(fr.line); out.push({ dir: "<<", tpdu: fr.tpdu.toString("hex"), ctrl: c[2 + c[1]], to: fr.dst }); }
  }
  return out;
}

// ETS's requests to the unit in a capture, each with when it was sent and the interface's confirmation, and the
// unit's frames. A frame from 0.0.0 goes out from the tunnel's address, as the interface sends it: the one its
// CONNECT_RES assigned, or `tunnel` where the capture holds the device's frames only. The requests at the end of a
// capture that ends before the interface confirmed them are counted, not returned.
function etsRequests(text: string, device: number, tunnel: number): { requests: { cemi: Buffer; at: number; con: "OK" | "NEG" }[]; unconfirmed: number; unit: Frame[] } {
  const requests: { cemi: Buffer; at: number; con?: "OK" | "NEG" }[] = [];
  for (const line of text.split("\n")) {
    const res = line.match(/CONNECT_RES\s+\| ([0-9a-f]+)\s*$/);
    const crd = res ? Buffer.from(res[1], "hex") : null;
    // A CONNECT_RES with status 0 carries the tunnel's address at the end of its CRD.
    if (crd && crd.length >= 20 && crd[7] === 0) tunnel = crd.readUInt16BE(18);
    const m = line.match(/\| ([0-9a-fA-F]+)\s*$/);
    const fr = m && line.includes("ETS->BRIDGE TUNNELLING_REQ") ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group || fr.code !== 0x11 || fr.dst !== device) continue;
    const cemi = Buffer.from(cemiOf(line));
    if (cemi.readUInt16BE(4) === 0) cemi.writeUInt16BE(tunnel, 4);
    requests.push({ cemi, at: Date.parse(line.split(" ")[0]) });
  }
  const unit = frames(text, "ETS", device);
  const cons = unit.filter((f) => f.dir === ">>").map((f) => f.con);
  cons.forEach((con, i) => { requests[i].con = con; });
  const confirmed = requests.findIndex((r) => r.con === undefined);
  const n = confirmed < 0 ? requests.length : confirmed;
  if (requests.slice(n).some((r) => r.con !== undefined)) throw new Error("a request inside the capture holds no confirmation");
  return { requests: requests.slice(0, n) as { cemi: Buffer; at: number; con: "OK" | "NEG" }[], unconfirmed: requests.length - n, unit };
}

// The frame type of a long frame is the interface's to report: Busforge's bench bridge at 1.1.100 reports the
// extended frames a unit sends, the house's KNXnet/IP interface a standard one; the priority is the unit's on both.
const BENCH_BRIDGE_IA = 0x1164;

// Each unit's ETS captures in the order they ran on it, from the state its collection shows (with what its
// captures show different, sim-units.ts), and the requests at their ends the interface confirmed after the
// capture ended: ETS's last T_Disconnect after the confirmed restart of the MIX 2's full and links downloads and of
// the GVS AMMA's download.
const CALIBRATIONS: { spec: SimUnitSpec; captures: string[]; unconfirmed?: Record<string, number> }[] = [
  { spec: MEANWELL_KNX40E, captures: ["links", "params", "revert", "fulldownload", "partial-maxtemp-on", "partial-maxtemp-off"].map((k) => `meanwell-ets-${k}.log`) },
  { spec: THEBEN_DALI_GATEWAY, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert", "unload", "fulldownload-real"].map((k) => `dali-ets-${k}.log`) },
  { spec: OPENKNX_RAUMCONTROLLER, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `openknx-ets-${k}.log`) },
  {
    spec: THEBEN_MIX2_HMG6T, captures: ["fulldownload", "partial-params", "partial-links", "partial-revert", "partial-diag-on", "partial-diag-off"].map((k) => `mix2-hmg6t-ets-${k}.log`),
    unconfirmed: { "mix2-hmg6t-ets-fulldownload.log": 1, "mix2-hmg6t-ets-partial-links.log": 1 },
  },
  { spec: JUNG_400021SE, captures: ["jung-400021se-ets-fulldownload.log"] },
  { spec: GVS_AMMA, captures: ["gvs-amma-ets-fulldownload-defaults.log"], unconfirmed: { "gvs-amma-ets-fulldownload-defaults.log": 1 } },
];

for (const { spec, captures, unconfirmed = {} } of CALIBRATIONS) {
  corpusDescribe(`the simulated ${spec.name} against ETS's captures`, () => {
    // Each request as ETS sent it into one simulated unit, from the state its collection shows; the restart and
    // the connection timeout run on the capture's clock.
    test("answers every request as the unit did, and confirms each on the line as its interface did", async () => {
      let clock = 0;
      const sim = newSimUnit(spec, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } });
      const answered: string[] = [];
      sim.onRawCemi = (c) => answered.push(`${c[2 + c[1]]} ${parseCemiLData(c).tpdu.toString("hex")}`);
      for (const capture of captures) {
        const { requests, unconfirmed: open, unit } = etsRequests(captureText(capture), sim.deviceIa, spec.interfaceIa);
        expect([capture, open]).toEqual([capture, unconfirmed[capture] ?? 0]);
        const simFrames: string[] = [], simCons: string[] = [];
        for (const r of requests) {
          clock = r.at;
          answered.length = 0;
          simCons.push(await sim.sendCemi(r.cemi).then(() => "OK", () => "NEG"));
          await new Promise((res) => setTimeout(res, 2));
          simFrames.push(...answered);
        }
        const viaBridge = unit.find((f) => f.dir === "<<")!.to === BENCH_BRIDGE_IA;
        const shown = (ctrl: number, tpdu: string) => `${viaBridge ? ctrl : ctrl & 0x0c} ${tpdu}`;
        const unitFrames = unit.filter((f) => f.dir === "<<").map((f) => shown(f.ctrl!, f.tpdu));
        expect([capture, unitFrames.length > 0]).toEqual([capture, true]);
        expect([capture, simCons]).toEqual([capture, requests.map((r) => r.con)]);
        expect([capture, simFrames.map((f) => shown(Number(f.split(" ")[0]), f.split(" ")[1]))]).toEqual([capture, unitFrames]);
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

// ---- Busforge's own full download into each simulated unit ----

// What Busforge's restart proof sends that the unit's captures do not show the answer to, its wall-clock times left
// out: a frame in the time after the restart no capture shows the line in, and a probe on the connection the
// restart ended (ETS sends none there).
const NOT_SHOWN_AFTER_RESTART = "after the restart: whether the unit acknowledges a frame then is not shown";
const NOT_SHOWN_DEAD_CONNECTION = "on the connection the restart ended: what the unit answers it is not shown";
const refusalKind = (r: string) => [NOT_SHOWN_AFTER_RESTART, NOT_SHOWN_DEAD_CONNECTION].find((k) => r.endsWith(k)) ?? r;

// The configuration ETS downloaded in each unit's full-download capture (tools/etsdiff.test.ts, "System B full
// download: the bytes ETS writes, and no other", holds Busforge's image to it): the projects' configurations of the
// Theben and OpenKNX units, the application's defaults on the Jung and the GVS. `stamps` are the memory-control
// blocks Busforge read back to prove the download; `refusals` what of its restart proof no capture shows.
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
    spec: THEBEN_MIX2_HMG6T, config: () => {
      const fx = JSON.parse(captureText("mix2-hmg6t-config.json")) as { ia: string; params: [string, string][]; instances: ModuleInstance[]; links: { comObjNum: number; gaRaws: number[] }[]; overrides: { comObjRefId: string; attrs: Record<string, string> }[] };
      const cfg = parseAppConfig(catalogueXml(THEBEN_MIX2_HMG6T.catalogue));
      const overrides = placeComObjOverrides(cfg, buildDeviceConfig(cfg, new Map(fx.params), undefined, fx.instances), fx.overrides);
      return { ia: fx.ia, params: fx.params, links: fx.links, moduleInstances: fx.instances, comObjectOverrides: [...overrides] };
    },
    stamps: ["1:0000007200331460", "2:000001260033610f", "3:000001fe0033e64b", "4:0000066a0032284d", "4:000001690032304e"],
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
