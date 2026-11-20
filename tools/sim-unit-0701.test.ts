import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { cemiLData, iaToNum, parseCemiLData, withSource } from "../packages/knx/src/index.ts";
import { decodeGroupTablesMv0705, type CollectPackage } from "../packages/product/src/index.ts";
import { captureText, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { busforgeIntoSim } from "./ets-sweep.ts";
import { captureLData, memWriteOf } from "./etsdiff.ts";
import { SimUnit0701, type SimUnit0701Model } from "./sim-unit-0701.ts";
import { confirmationDifferences, framePairs, replayCapture, replayDifferences, type ReplayStep } from "./sim-unit-replay.ts";
import type { SimProperty, SimUnit } from "./sim-unit.ts";
import { ABB_USU42, THEBEN_METEODATA_140S, newSimUnit0701, type SimUnitSpec } from "./sim-units.ts";

// Busforge's downloads below run on the wall clock (the unit's line timing, the restart proof's windows).
setDefaultTimeout(300_000);

const TOOL = 0x11ff, DEV = 0x110a, PROGRAM = "0048140c14";
const p = (...elements: string[]): SimProperty => ({ elements: elements.map((e) => Buffer.from(e, "hex")), countKnown: true });
// The APCI of an APDU; -1 for a transport-layer control frame.
const apciOf = (t: Buffer) => (t.length < 2 ? -1 : ((t[0] & 0x03) << 8) | t[1]);
const hex = (n: number, octets: number) => n.toString(16).padStart(2 * octets, "0");
// The 11-octet load control of `lsm`'s `event`, its further octets `rest`.
const control = (lsm: number, event: number, rest = "") => hex((lsm << 4) | event, 1) + rest.padEnd(20, "0");
const absSegment = (lsm: number, at: number, size: number, memType = 3) => control(lsm, 3, `0000${hex(at, 2)}${hex(size, 2)}ff${hex(memType, 1)}0000`);
const taskSegment = (lsm: number, at: number, pei = 0, program = PROGRAM) => control(lsm, 3, `0200${hex(at, 2)}${hex(pei, 1)}${program}`);
const read = (n: number, at: number) => `02${hex(n, 1)}${hex(at, 2)}`;
const write = (at: number, data: string) => `02${hex(0x80 | (data.length / 2), 1)}${hex(at, 2)}${data}`;

// A unit whose load-state machines 1 and 3 are loaded: machine 1 with the 4-octet segment 0x4000 the
// collection read, machine 3 with 0x4800 and a RAM segment 0x1c00; the octet 0x4800 a download marker it clears.
function unit(over: { mm?: Partial<SimUnit0701Model["memoryMapped"]>; deviceControl?: string; restart?: SimUnit0701Model["restart"] } = {}) {
  let clock = 0;
  const model: SimUnit0701Model = {
    ia: DEV, mask: 0x0701, maxApdu: 15,
    objects: new Map([[0, new Map([[14, p(over.deviceControl ?? "00")]])], [1, new Map([[5, p("01")], [7, p("4000")]])], [3, new Map([[5, p("01")], [13, p(PROGRAM)]])]]),
    descriptions: new Map(),
    memory: new Map([[0x4000, 0x02], [0x4001, 0x11], [0x4002, 0x0a], [0x4003, 0x09], [0x4800, 0x00]]),
    states: new Map([[1, 1], [3, 1]]),
    appSegments: new Map([[1, [{ at: 0x4000, size: 4, memType: 3 }]], [3, [{ at: 0x4800, size: 1, memType: 3 }, { at: 0x1c00, size: 2, memType: 2 }]]]),
    programId: Buffer.from(PROGRAM, "hex"),
    memoryMapped: { maxApdu: 15, additional: ["absolute-segment", "task-segment"], peiType: 0, tableReferenceFollows: true, addressTableCountOnDeclaration: 0x01, clearedByRestart: new Map([[0x4800, 0x00]]), ...over.mm },
    authorize: new Map(), restart: over.restart ?? { acknowledged: true, linkDownMs: 0, deadConnection: "nothing" }, link: { ackMs: 0, nakMs: 0 },
  };
  const sim = new SimUnit0701(model, TOOL, { now: () => clock });
  const frames: string[] = [];
  sim.onRawCemi = (c) => frames.push(parseCemiLData(c).tpdu.toString("hex"));
  const send = (tpdu: Buffer) => sim.sendCemi(withSource(cemiLData(0, DEV, tpdu), TOOL));
  let seq = 0;
  // One numbered request: the unit's answers but its T_Ack, without their first octet, each acknowledged in turn.
  const req = async (apdu: string) => {
    const t = Buffer.from(apdu, "hex"); t[0] |= 0x40 | (seq << 2);
    const before = frames.length;
    await send(t);
    await new Promise((r) => setTimeout(r, 5));
    const answers = frames.slice(before).filter((f) => f.length > 2);
    for (const a of answers) await send(Buffer.from([0xc2 | (Buffer.from(a, "hex")[0] & 0x3c)]));
    seq = (seq + 1) & 0x0f;
    return answers.map((f) => f.slice(2));
  };
  return { sim, req, send, connect: () => send(Buffer.from([0x80])), at: (ms: number) => { clock = ms; } };
}

describe("a simulated memory-mapped System 7 unit", () => {
  test("runs its load-state machines over 0x0104, answers each state by its octet, and takes writes into a loading machine's segment", async () => {
    const { sim, req, connect } = unit();
    await connect();
    expect(await req(read(1, 0xb6ea))).toEqual(["41b6ea01"]);
    expect(await req(read(4, 0x4000))).toEqual(["44400002110a09"]);
    expect(await req(write(0x0104, control(1, 4)))).toEqual([]);
    expect(await req(read(1, 0xb6ea))).toEqual(["41b6ea00"]);
    // The address table's count is not known from the unload until the declaration.
    expect(await req(read(1, 0x4000))).toEqual([]);
    expect(await req(write(0x0104, control(1, 1)))).toEqual([]);
    expect(await req(read(1, 0xb6ea))).toEqual(["41b6ea02"]);
    expect(await req(write(0x0104, absSegment(1, 0x4000, 4)))).toEqual([]);
    expect(await req(read(4, 0x4000))).toEqual(["44400001110a09"]);
    expect(await req(write(0x4000, "02110a"))).toEqual([]);
    expect(await req(read(3, 0x4000))).toEqual(["43400002110a"]);
    expect(await req(write(0x0104, taskSegment(1, 0x4000)))).toEqual([]);
    expect(await req(write(0x0104, control(1, 2)))).toEqual([]);
    expect(await req(read(1, 0xb6ea))).toEqual(["41b6ea01"]);
    // Its table reference at the address declared, the one collected.
    expect(await req("03d501071001")).toEqual(["d6010710014000"]);
    expect(sim.refusals).toEqual(["sim-refused A_Memory_Read 1 at 0x4000: the collection did not read 0x4000; a collect read of A_Memory_Read 1 at 0x4000 closes it"]);
    expect(sim.read(0x4000, 4)?.toString("hex")).toBe("02110a09");
    expect(sim.loadState(1)).toBe(1);
  });

  test("a unit that keeps its address table's count answers it after the declaration as it held it", async () => {
    const { sim, req, connect } = unit({ mm: { addressTableCountOnDeclaration: null } });
    await connect();
    for (const c of [control(1, 4), control(1, 1), absSegment(1, 0x4000, 4)]) await req(write(0x0104, c));
    expect(await req(read(1, 0x4000))).toEqual(["41400002"]);
    expect(sim.refusals).toEqual([]);
  });

  test("refuses what no capture shows, without an answer", async () => {
    const { sim, req, connect } = unit({ mm: { tableReferenceFollows: false } });
    await connect();
    const requests = [
      read(2, 0xb6ea), read(1, 0xb6eb), read(1, 0x5000), read(2, 0xffff), read(1, 0x0108),
      "03d70105100104", "03d7030d1001" + PROGRAM,
      write(0x4000, "03"), write(0x0106, "00"),
      write(0x0104, control(3, 3, "02")),
      write(0x0104, control(3, 1)), write(0x0104, control(3, 3, "04")), write(0x5000, "00"), write(0x1c00, "00"),
      write(0x0104, control(3, 3, "0001")), write(0x0104, absSegment(3, 0xfff0, 0x20)), write(0x0104, absSegment(3, 0x4000, 2)), write(0x0104, absSegment(3, 0x5000, 0)),
      write(0x0104, taskSegment(3, 0x4800, 0, "0002a00113")), write(0x0104, taskSegment(3, 0x4800, 0x80)), write(0x0104, taskSegment(3, 0x6000)),
      "03d503051001", "03d5000e1001",
      write(0x0104, control(1, 4)), "03d501071001", write(0x0104, control(1, 1)), write(0x0104, control(1, 2)),
      "0380",
    ];
    for (const r of requests) expect([r, await req(r)]).toEqual([r, []]);
    expect(sim.refusals).toEqual([
      "sim-refused A_Memory_Read 2 at 0xb6ea: a read of the load states other than one state octet, which the unit answers otherwise than their single reads",
      "sim-refused A_Memory_Read 1 at 0xb6eb: the state of load-state machine 2 is not known; the collection did not read object 2 PID 5",
      "sim-refused A_Memory_Read 1 at 0x5000: the collection did not read 0x5000; a collect read of A_Memory_Read 1 at 0x5000 closes it",
      "sim-refused A_Memory_Read 2 at 0xffff: past the reach of the memory services",
      "sim-refused A_Memory_Read 1 at 0x108: overlaps 0x104+12, a location the master data marks unreadable (read access None)",
      "sim-refused A_PropertyValue_Write 1/5 04: no property write is shown on this unit; its load controls go to memory 0x0104",
      `sim-refused A_PropertyValue_Write 3/13 ${PROGRAM}: no property write is shown on this unit`,
      "sim-refused A_Memory_Write 1 at 0x4000 03: into a segment of load-state machine 1 in state 1",
      "sim-refused A_Memory_Write 1 at 0x106 00: the load control at 0x0104 takes 11 octets at once",
      "sim-refused A_Memory_Write 11 at 0x104 3302000000000000000000: an additional load control in state 1",
      "sim-refused A_Memory_Write 11 at 0x104 3304000000000000000000: additional load control 4, which the unit's captures do not show it taking",
      "sim-refused A_Memory_Write 1 at 0x5000 00: outside every segment a load-state machine holds",
      "sim-refused A_Memory_Write 1 at 0x1c00 00: into a segment of memory type 2, which no capture shows written",
      "sim-refused A_Memory_Write 11 at 0x104 3300010000000000000000: a third octet other than 00",
      "sim-refused A_Memory_Write 11 at 0x104 330000fff00020ff030000: a segment of 32 octets at 0xfff0, which the memory services do not reach whole",
      "sim-refused A_Memory_Write 11 at 0x104 33000040000002ff030000: a segment reaching into one of load-state machine 1",
      "sim-refused A_Memory_Write 11 at 0x104 33000050000000ff030000: a segment of 0 octets at 0x5000, which the memory services do not reach whole",
      `sim-refused A_Memory_Write 11 at 0x104 3302004800000002a00113: the application 0002a00113, the unit holds ${PROGRAM}; what it does with another one is not shown`,
      `sim-refused A_Memory_Write 11 at 0x104 330200480080${PROGRAM}: PEI type 80, the unit's captures carry 0`,
      `sim-refused A_Memory_Write 11 at 0x104 330200600000${PROGRAM}: at 0x6000, outside the machine's segments`,
      "sim-refused A_PropertyValue_Read 3/5 after a load event of its machine at 0x0104: whether the unit's PID 5 follows its state there is not shown",
      "sim-refused A_PropertyValue_Read 0/14 after a load event or a restart: no capture of this mask reads the device control then",
      "sim-refused A_PropertyValue_Read 1/7 after a load event of its machine: what the unit reports there then is not shown",
      "sim-refused A_Memory_Write 11 at 0x104 1200000000000000000000: load completed after the unload without an absolute segment and the task segment declared, which every capture declares first",
      "sim-refused A_Restart: with load-state machine 1, 3 loading; what the unit holds after that is not shown",
    ]);
  });

  test("refuses a write in verify mode", async () => {
    const { sim, req, connect } = unit({ deviceControl: "04" });
    await connect();
    await req(write(0x0104, control(3, 1)));
    expect(sim.refusals).toEqual(["sim-refused A_Memory_Write 11 at 0x104 3100000000000000000000 in verify mode: how the unit answers a write then is not shown"]);
  });

  test("clears a download marker a download wrote at the restart that follows, and reads it as written before", async () => {
    const { sim, req, connect } = unit();
    await connect();
    await req(write(0x0104, control(3, 1)));
    await req(write(0x4800, "aa"));
    expect(await req(read(1, 0x4800))).toEqual(["414800aa"]);
    await req(write(0x0104, control(3, 2)));
    await req("0380");
    expect(sim.read(0x4800, 1)?.toString("hex")).toBe("00");
    expect(sim.refusals).toEqual([]);
  });

  test("after the restart: a frame in the gap its captures leave is refused and not acknowledged, one past it acknowledged", async () => {
    const { sim, req, send, connect, at } = unit({ restart: { acknowledged: true, linkDownMs: 40, linkUpMs: 1000, deadConnection: "nothing" } });
    await connect();
    await req("0380");
    const con = (ms: number) => { at(ms); return send(Buffer.from([0x80])).then(() => "OK", () => "NEG"); };
    expect(await con(10)).toBe("NEG");
    expect(await con(500)).toBe("NEG");
    expect(await con(1000)).toBe("OK");
    expect(sim.refusals).toEqual(["sim-refused 80 500 ms after the restart: whether the unit acknowledges a frame then is not shown"]);
  });
});

// ---- the units against their captures ----

const collectionOf = (path: string) => JSON.parse(readFileSync(corpusPath(path), "utf8")) as CollectPackage;
const corpusText = (path: string) => readFileSync(corpusPath(path), "utf8");
const as0701 = (sim: SimUnit) => { if (!(sim instanceof SimUnit0701)) throw new Error("not a memory-mapped System 7 unit"); return sim; };

// The unit as `collection` shows it, every request of `captures` replayed into it in order on the captures' clock.
async function replay(spec: SimUnitSpec, collection: string, captures: string[], device: number) {
  let clock = 0;
  const sim = newSimUnit0701(spec, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } }, collection);
  const runs: { capture: string; steps: ReplayStep[] }[] = [];
  for (const capture of captures) runs.push({ capture, steps: await replayCapture(sim, corpusText(capture), { tool: "ETS", device, interfaceIa: spec.interfaceIa, clock: (ms) => { clock = ms; } }) });
  return { sim, runs };
}

// The memory a collection read, octet by octet, without the load states.
function collectedMemory(c: CollectPackage): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of c.records) {
    const at = (r.target as { address?: number }).address;
    if (r.space !== "memory" || r.outcome !== "bytes" || at === undefined || !r.bytes) continue;
    Buffer.from(r.bytes, "hex").forEach((b, i) => { if (at + i < 0xb6ea || at + i > 0xb6ed) out.set(at + i, b); });
  }
  return out;
}

const memoryWriteOf = (t: Buffer) => (t.length >= 2 ? memWriteOf(t, apciOf(t)) : null);

// The differences of a replay that what the unit held before the download explains, left out: a frame the unit
// and the simulator both sent as the A_Memory_Response to the same read (the same transport and application
// header, the same address), every octet they differ in one that the tool writes later in the same download.
// What is left (any other frame, any confirmation) is unexplained.
function unexplainedByEarlierMemory(steps: ReplayStep[]): string[] {
  const response = (f: string | undefined) => { const t = f ? Buffer.from(f.split(" ")[1], "hex") : null; return t && t.length > 4 && (apciOf(t) & 0x3c0) === 0x240 ? t : null; };
  const writtenAfter = (step: number) => new Set(steps.slice(step + 1).flatMap((x) => { const w = memoryWriteOf(Buffer.from(x.request, "hex")); return w ? Array.from(w.data, (_, k) => w.addr + k) : []; }));
  return [...confirmationDifferences(steps), ...framePairs(steps).flatMap((f, k) => {
    if (f.unit === f.sim) return [];
    const u = response(f.unit), m = response(f.sim), later = writtenAfter(f.unitStep);
    const explained = u && m && f.unit!.split(" ")[0] === f.sim!.split(" ")[0] && u.length === m.length && u.subarray(0, 4).equals(m.subarray(0, 4))
      && [...u.subarray(4)].every((b, i) => b === m[4 + i] || later.has(u.readUInt16BE(2) + i));
    return explained ? [] : [`frame ${k}: the unit sent ${f.unit ?? "nothing"}, the simulator ${f.sim ?? "nothing"}`];
  })];
}

// The memory writes of a tool's requests to the unit in a capture, without the load controls at 0x0104, as
// `address:data`.
function memoryWrites(text: string, tool: string, device: number): string[] {
  return [...captureLData(text, tool)].flatMap((fr) => {
    const w = fr.fromTool && !fr.group && fr.code === 0x11 && fr.dst === device ? memoryWriteOf(fr.tpdu) : null;
    return w && w.addr !== 0x0104 ? [`${w.addr.toString(16)}:${w.data.toString("hex")}`] : [];
  });
}

// The octets two simulated units hold otherwise, or that only one of them knows.
function differingOctets(a: SimUnit0701, b: SimUnit0701): string[] {
  const [ma, mb] = [a.memorySnapshot(), b.memorySnapshot()];
  return [...new Set([...ma.keys(), ...mb.keys()])].filter((at) => ma.get(at) !== mb.get(at)).sort((x, y) => x - y)
    .map((at) => `${at.toString(16)}: ${ma.get(at)?.toString(16) ?? "unknown"} / ${mb.get(at)?.toString(16) ?? "unknown"}`);
}

const ABB = iaToNum("1.1.201");
const COUNTER = "internal/captures/abb-counter-2026-11-20", FRESH = "internal/captures/abb-fresh-2026-11-20";

corpusDescribe("the simulated ABB US/U 4.2", () => {
  // ETS 6's counter download and the download that undid it, in the order they ran on the bench unit, into one
  // simulated unit from its collection before them; the collection after them is what the unit then held.
  test("answers every request of ETS's counter download and its undo as the unit did, and holds after them what the unit's collection read", async () => {
    const { sim, runs } = await replay(ABB_USU42, ABB_USU42.collection, ["captures/abb-usu-4.2-ets-counter-download.log", `${COUNTER}/e2-abb-restore-download.log`], ABB);
    for (const r of runs) expect([r.capture, r.steps.length > 100, replayDifferences(r.steps)]).toEqual([r.capture, true, []]);
    expect(sim.refusals).toEqual([]);
    const after = collectedMemory(collectionOf(`${COUNTER}/collect-1.1.201-after-ets-restore.json`));
    expect(after.size).toBeGreaterThan(9000);
    expect([...after].filter(([a, b]) => sim.read(a, 1)?.[0] !== b).map(([a, b]) => `${a.toString(16)}: unit ${b.toString(16)}, simulator ${sim.read(a, 1)?.toString("hex")}`)).toEqual([]);
  });

  // ETS's application download from a freshly opened project (at its defaults, no link), and the one three days
  // after the unit's earliest collection: the partial form, read-compare.
  test("answers every request of ETS's two application downloads onto the loaded unit as the unit did", async () => {
    for (const [collection, capture] of [[`${FRESH}/collect-1.1.201-before.json`, `${FRESH}/e1-abb-fresh-app-download.log`], ["internal/captures/cap-1004/abb-plain.json", "captures/abb-usu-4.2-ets-fulldownload-loaded.log"]]) {
      const { sim, runs } = await replay(ABB_USU42, collection, [capture], ABB);
      expect([capture, runs[0].steps.length > 100, replayDifferences(runs[0].steps), sim.refusals]).toEqual([capture, true, [], []]);
    }
  });

  // ETS's full download at the project's defaults and its partial download a day later, the first ETS downloads of
  // the unit: no collection shows what it held before them, so they run on its earliest collection, taken after
  // both. The unit's and the simulator's answers differ only where ETS reads memory it then writes: what the unit
  // held there before.
  test("answers ETS's first full download and partial download as the unit did, but for octets ETS read and then overwrote", async () => {
    for (const capture of ["captures/abb-usu-4.2-ets-fulldownload-defaults.log", "captures/abb-usu-4.2-ets-partial-links.log"]) {
      const { sim, runs } = await replay(ABB_USU42, "internal/captures/cap-1004/abb-plain.json", [capture], ABB);
      expect([capture, replayDifferences(runs[0].steps).length > 0, unexplainedByEarlierMemory(runs[0].steps), sim.refusals]).toEqual([capture, true, [], []]);
    }
  });

  // Busforge's full download of the configuration of ETS's fresh application download (the project at its
  // defaults, no link), into the unit as its collection shows it, which holds the memory the collection before
  // ETS's download read: the partial form, read and compared, verified; on the wire exactly ETS's memory writes,
  // and the unit left as ETS's download left it.
  test("takes Busforge's full download of the defaults through the KNXnet/IP server: ETS's writes, ETS's end state", async () => {
    const before = `${FRESH}/collect-1.1.201-before.json`, ets = `${FRESH}/e1-abb-fresh-app-download.log`;
    expect([...collectedMemory(collectionOf(before))]).toEqual([...collectedMemory(collectionOf(ABB_USU42.collection))]);
    const { sim, result, capture, refusals } = await busforgeIntoSim(ABB_USU42, { ia: "1.1.201", params: [], links: [] });
    expect(refusals).toEqual([]);
    expect(result).toMatchObject({ kind: "flashed", verified: true, imageBytes: 229, diffBytes: 19 });
    expect(memoryWrites(capture, "Busforge", ABB)).toEqual(["4000:01", "4200:00", "4407:db", "440f:db", "6d01:0114030a031e0001020000", "6d0c:00000000"]);
    expect(memoryWrites(capture, "Busforge", ABB)).toEqual(memoryWrites(corpusText(ets), "ETS", ABB));
    expect(differingOctets(as0701(sim), (await replay(ABB_USU42, before, [ets], ABB)).sim)).toEqual([]);
  });
});

const METEODATA = iaToNum("1.1.24");

corpusDescribe("the simulated Theben Meteodata 140 S", () => {
  // ETS 6's four downloads of the house unit, in the order they ran, into one simulated unit from its collection
  // before them: the full download, the parameter download, the link and the revert.
  test("answers every request of ETS's four downloads as the unit did", async () => {
    const captures = ["fulldownload", "partial-params", "partial-links", "partial-revert"].map((k) => `captures/meteodata-140s-ets-${k}.log`);
    const { sim, runs } = await replay(THEBEN_METEODATA_140S, THEBEN_METEODATA_140S.collection, captures, METEODATA);
    for (const r of runs) expect([r.capture, r.steps.length > 100, replayDifferences(r.steps)]).toEqual([r.capture, true, []]);
    // The full download's memory reads.
    expect(runs[0].steps.filter((s) => (apciOf(Buffer.from(s.request, "hex")) & 0x3c0) === 0x200).length).toBe(191);
    expect(sim.refusals).toEqual([]);
  });

  // Busforge's full download of the configuration ETS downloaded: the parameter values the house project's export
  // holds for the unit (captures/meteodata-140s-config.json), the links its tables held before ETS's downloads.
  test("takes Busforge's full download of the configuration ETS downloaded through the KNXnet/IP server: ETS's writes, ETS's end state", async () => {
    const mem = collectedMemory(collectionOf(THEBEN_METEODATA_140S.collection));
    const bytes = (at: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => mem.get(at + i)!));
    const addr = bytes(0x4000, 1 + 2 * mem.get(0x4000)!);
    const assoc = bytes(0x4000 + addr.length, 1 + 2 * mem.get(0x4000 + addr.length)!);
    const params = (JSON.parse(captureText("meteodata-140s-config.json")) as { params: [string, string][] }).params;
    const { sim, result, capture, refusals } = await busforgeIntoSim(THEBEN_METEODATA_140S, { ia: "1.1.24", params, links: decodeGroupTablesMv0705(addr, assoc) });
    expect(refusals).toEqual([]);
    expect(result).toMatchObject({ kind: "flashed", verified: true, imageBytes: 1893, diffBytes: 2 });
    // The address table's count, which the unit reset at the declaration, and the download marker.
    expect(memoryWrites(capture, "Busforge", METEODATA)).toEqual(["4000:14", "4800:aa"]);
    expect(memoryWrites(capture, "Busforge", METEODATA)).toEqual(memoryWrites(captureText("meteodata-140s-ets-fulldownload.log"), "ETS", METEODATA));
    const ets = await replay(THEBEN_METEODATA_140S, THEBEN_METEODATA_140S.collection, ["captures/meteodata-140s-ets-fulldownload.log"], METEODATA);
    expect(differingOctets(as0701(sim), ets.sim)).toEqual([]);
  });
});
