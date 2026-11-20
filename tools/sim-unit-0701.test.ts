import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { KnxIpServer, cemiLData, parseCemiLData, withSource } from "../packages/knx/src/index.ts";
import { decodeGroupTablesMv0705, type CollectPackage } from "../packages/product/src/index.ts";
import { downloadDeviceFull } from "../apps/server/src/deviceprofile.ts";
import type { Connection } from "../apps/server/src/db/connections.ts";
import { captureText, catalogueXml, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { memWriteOf } from "./etsdiff.ts";
import { startProxy } from "./knxproxy.ts";
import { SimUnit0701, type SimUnit0701Model } from "./sim-unit-0701.ts";
import { framePairs, replayCapture, replayDifferences, type ReplayStep } from "./sim-unit-replay.ts";
import { ABB_USU42, THEBEN_METEODATA_140S, newSimUnit, type SimUnitSpec } from "./sim-units.ts";
import type { SimProperty } from "./sim-unit.ts";
import { removeTempDir, tempDir } from "./test-temp.ts";

// Busforge's downloads below run on the wall clock (the unit's line timing, the restart proof's windows).
setDefaultTimeout(300_000);

const TOOL = 0x11ff, DEV = 0x110a;
const p = (...elements: string[]): SimProperty => ({ elements: elements.map((e) => Buffer.from(e, "hex")), countKnown: true });
// The APCI of an APDU; -1 for a transport-layer control frame.
const apciOf = (t: Buffer) => (t.length < 2 ? -1 : ((t[0] & 0x03) << 8) | t[1]);
// The 11-octet load control of `lsm`'s `event`, its further octets `rest`.
const control = (lsm: number, event: number, rest = "") => ((lsm << 4) | event).toString(16).padStart(2, "0") + rest.padEnd(20, "0");
const read = (n: number, at: number) => `02${n.toString(16).padStart(2, "0")}${at.toString(16).padStart(4, "0")}`;
const write = (at: number, data: string) => `02${(0x80 | (data.length / 2)).toString(16)}${at.toString(16).padStart(4, "0")}${data}`;

// A unit whose load-state machines 1 and 3 are loaded, machine 1 with the 4-octet segment 0x4000 the
// collection read, machine 3 with 0x4800, and the octet 0x4800 a download marker it clears.
function unit(mm: Partial<SimUnit0701Model["memoryMapped"]> = {}) {
  const model: SimUnit0701Model = {
    ia: DEV, mask: 0x0701, maxApdu: 15,
    objects: new Map([[0, new Map([[14, p("00")]])], [1, new Map([[5, p("01")], [7, p("4000")]])], [3, new Map([[5, p("01")]])]]),
    descriptions: new Map(),
    memory: new Map([[0x4000, 0x02], [0x4001, 0x11], [0x4002, 0x0a], [0x4003, 0x09], [0x4800, 0x00]]),
    states: new Map([[1, 1], [3, 1]]),
    appSegments: new Map([[1, [{ at: 0x4000, size: 4 }]], [3, [{ at: 0x4800, size: 1 }]]]),
    memoryMapped: { maxApdu: 15, additional: ["absolute-segment", "task-segment"], tableReferenceFollows: true, addressTableCountOnDeclaration: 0x01, clearedByRestart: new Map([[0x4800, 0x00]]), ...mm },
    authorize: new Map(), restart: { acknowledged: true, linkDownMs: 0, deadConnection: "nothing" }, link: { ackMs: 0, nakMs: 0 },
  };
  const sim = new SimUnit0701(model, TOOL);
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
  return { sim, req, connect: () => send(Buffer.from([0x80])) };
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
    expect(await req(write(0x0104, control(1, 3, "0000400004")))).toEqual([]);
    expect(await req(read(4, 0x4000))).toEqual(["44400001110a09"]);
    expect(await req(write(0x4000, "02110a"))).toEqual([]);
    expect(await req(read(3, 0x4000))).toEqual(["43400002110a"]);
    expect(await req(write(0x0104, control(1, 2)))).toEqual([]);
    expect(await req(read(1, 0xb6ea))).toEqual(["41b6ea01"]);
    // Its table reference at the address declared, the one collected.
    expect(await req("03d501071001")).toEqual(["d6010710014000"]);
    expect(sim.refusals).toEqual(["sim-refused A_Memory_Read 1 at 0x4000: the collection did not read 0x4000; a collect read of A_Memory_Read 1 at 0x4000 closes it"]);
    expect(sim.read(0x4000, 4)?.toString("hex")).toBe("02110a09");
    expect(sim.loadState(1)).toBe(1);
  });

  test("refuses what no capture shows, without an answer", async () => {
    const { sim, req, connect } = unit({ tableReferenceFollows: false });
    await connect();
    expect(await req(read(2, 0xb6ea))).toEqual([]);
    expect(await req(read(1, 0xb6eb))).toEqual([]);
    expect(await req(read(1, 0x5000))).toEqual([]);
    expect(await req("03d70105100104")).toEqual([]);
    expect(await req(write(0x4000, "03"))).toEqual([]);
    expect(await req(write(0x0104, control(3, 3, "02")))).toEqual([]);
    expect(await req(write(0x0104, control(3, 1)))).toEqual([]);
    expect(await req(write(0x0104, control(3, 3, "04")))).toEqual([]);
    expect(await req(write(0x5000, "00"))).toEqual([]);
    expect(await req("03d503051001")).toEqual([]);
    expect(await req(write(0x0104, control(1, 4)))).toEqual([]);
    expect(await req("03d501071001")).toEqual([]);
    expect(await req("0380")).toEqual([]);
    expect(sim.refusals).toEqual([
      "sim-refused A_Memory_Read 2 at 0xb6ea: a read of the load states other than one state octet, which the unit answers otherwise than their single reads",
      "sim-refused A_Memory_Read 1 at 0xb6eb: the state of load-state machine 2 is not known; the collection did not read object 2 PID 5",
      "sim-refused A_Memory_Read 1 at 0x5000: the collection did not read 0x5000; a collect read of A_Memory_Read 1 at 0x5000 closes it",
      "sim-refused A_PropertyValue_Write 1/5 04: the unit's load controls go to memory 0x0104, a PID 5 write is not shown",
      "sim-refused A_Memory_Write 1 at 0x4000 03: into a segment of load-state machine 1 in state 1",
      "sim-refused A_Memory_Write 11 at 0x104 3302000000000000000000: an additional load control in state 1",
      "sim-refused A_Memory_Write 11 at 0x104 3304000000000000000000: additional load control 4, which the unit's captures do not show it taking",
      "sim-refused A_Memory_Write 1 at 0x5000 00: outside every segment a load-state machine holds",
      "sim-refused A_PropertyValue_Read 3/5 after a load event of its machine at 0x0104: whether the unit's PID 5 follows its state there is not shown",
      "sim-refused A_PropertyValue_Read 1/7 after a load event of its machine: what the unit reports there then is not shown",
      "sim-refused A_Restart: with load-state machine 3 loading; what the unit holds after that is not shown",
    ]);
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
});

// ---- the units against their captures ----

const iaNum = (s: string) => { const [a, l, d] = s.split(".").map(Number); return (a << 12) | (l << 8) | d; };
const collectionOf = (path: string) => JSON.parse(readFileSync(corpusPath(path), "utf8")) as CollectPackage;
const corpusText = (path: string) => readFileSync(corpusPath(path), "utf8");

// The unit as `collection` shows it, every request of `captures` replayed into it in order on the captures' clock.
async function replay(spec: SimUnitSpec, collection: string, captures: string[], device: number) {
  let clock = 0;
  const sim = newSimUnit(spec, { now: () => clock }, { link: { ackMs: 0, nakMs: 0 } }, collection) as SimUnit0701;
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

const memoryWriteOf = (tpdu: string) => { const t = Buffer.from(tpdu, "hex"); return t.length >= 2 ? memWriteOf(t, apciOf(t)) : null; };

// The differences of a replay that what the unit held before the download explains, left out: a frame the unit
// and the simulator both sent as the A_Memory_Response to the same read, every octet they differ in one that the
// tool writes later in the same download. What is left (any other frame, any confirmation) is unexplained.
function unexplainedByEarlierMemory(steps: ReplayStep[]): string[] {
  const response = (f: string | undefined) => { const t = f ? Buffer.from(f.split(" ")[1], "hex") : null; return t && t.length > 4 && (apciOf(t) & 0x3c0) === 0x240 ? t : null; };
  const writtenAfter = (step: number) => new Set(steps.slice(step + 1).flatMap((x) => { const w = memoryWriteOf(x.request); return w ? Array.from(w.data, (_, k) => w.addr + k) : []; }));
  const cons = steps.flatMap((s, i) => (s.unitCon === s.simCon ? [] : [`request ${i} ${s.request}: confirmed ${s.unitCon} by the unit's interface, ${s.simCon} by the simulator`]));
  return [...cons, ...framePairs(steps).flatMap((f, k) => {
    if (f.unit === f.sim) return [];
    const u = response(f.unit), m = response(f.sim), later = writtenAfter(f.unitStep);
    const explained = u && m && f.unit!.split(" ")[0] === f.sim!.split(" ")[0] && u.length === m.length && u.readUInt16BE(2) === m.readUInt16BE(2)
      && [...u.subarray(4)].every((b, i) => b === m[4 + i] || later.has(u.readUInt16BE(2) + i));
    return explained ? [] : [`frame ${k}: the unit sent ${f.unit ?? "nothing"}, the simulator ${f.sim ?? "nothing"}`];
  })];
}

// The memory writes of a tool's requests to the unit in a capture, without the load controls at 0x0104, as
// `address:data`.
function memoryWrites(text: string, tool: string, device: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/\| ([0-9a-fA-F]+)\s*$/);
    if (!m || !line.includes(`${tool}->BRIDGE TUNNELLING_REQ`)) continue;
    const f = Buffer.from(m[1], "hex"), l = parseCemiLData(f.subarray(f[0] + f[f[0]]));
    if (l.isGroup || l.dst !== device) continue;
    const w = memoryWriteOf(l.tpdu.toString("hex"));
    if (w && w.addr !== 0x0104) out.push(`${w.addr.toString(16)}:${w.data.toString("hex")}`);
  }
  return out;
}

// Busforge's full download through KnxIpServer and the logging proxy the captures are taken with, as the
// server's download task runs it, into a unit as `collection` shows it.
async function busforgeDownload(spec: SimUnitSpec, collection: string, project: { ia: string; params: Map<string, string>; links: { comObjNum: number; gaRaws: number[] }[] }) {
  const dir = tempDir("busforge-sim-0701-");
  const sim = newSimUnit(spec, {}, {}, collection) as SimUnit0701;
  const port = await freePort();
  const server = new KnxIpServer({ transport: sim, maxApdu: spec.interfaceMaxApdu, port });
  const log = join(dir, "capture.log");
  const proxy = startProxy({ port: 0, bridgeHost: "127.0.0.1", bridgePort: port, log, tool: "Busforge" });
  try {
    await server.start();
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const proxyPort = (proxy.address() as { port: number }).port;
    const connection: Connection = { id: "sim", name: "sim", type: "ip", host: "127.0.0.1", port: proxyPort, ipTransport: "tcp", usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0 };
    const result = await downloadDeviceFull({ projectId: "p", deviceId: "d", ia: project.ia, appXml: catalogueXml(spec.catalogue), dataDir: dir, connection, params: project.params, links: project.links, comObjectOverrides: new Map(), dryRun: false });
    for (let i = 0; !readFileSync(log, "utf8").includes("DISCONNECT_REQ"); i++) {
      if (i === 100) throw new Error("the session did not end within 10 s of the download's result");
      await new Promise((r) => setTimeout(r, 100));
    }
    return { sim, result, capture: readFileSync(log, "utf8") };
  } finally {
    proxy.close();
    await server.stop();
    removeTempDir(dir);
  }
}

const ABB = iaNum("1.1.201");
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
  // defaults, no link) into the unit as the collection before that download shows it: the partial form, read and
  // compared, verified; on the wire exactly ETS's memory writes, and the unit left as ETS's download left it.
  test("takes Busforge's full download of the defaults through the KNXnet/IP server: ETS's writes, ETS's end state", async () => {
    const collection = `${FRESH}/collect-1.1.201-before.json`, ets = `${FRESH}/e1-abb-fresh-app-download.log`;
    const { sim, result, capture } = await busforgeDownload(ABB_USU42, collection, { ia: "1.1.201", params: new Map(), links: [] });
    expect(sim.refusals).toEqual([]);
    expect(result).toMatchObject({ kind: "flashed", verified: true, imageBytes: 229, diffBytes: 19 });
    expect(memoryWrites(capture, "Busforge", ABB)).toEqual(["4000:01", "4200:00", "4407:db", "440f:db", "6d01:0114030a031e0001020000", "6d0c:00000000"]);
    expect(memoryWrites(capture, "Busforge", ABB)).toEqual(memoryWrites(corpusText(ets), "ETS", ABB));
    expect(differingOctets(sim, (await replay(ABB_USU42, collection, [ets], ABB)).sim)).toEqual([]);
  });
});

const METEODATA = iaNum("1.1.24");

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
  test("takes Busforge's full download of the configuration ETS downloaded through the KNXnet/IP server", async () => {
    const mem = collectedMemory(collectionOf(THEBEN_METEODATA_140S.collection));
    const bytes = (at: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => mem.get(at + i)!));
    const addr = bytes(0x4000, 1 + 2 * mem.get(0x4000)!);
    const assoc = bytes(0x4000 + addr.length, 1 + 2 * mem.get(0x4000 + addr.length)!);
    const params = new Map((JSON.parse(captureText("meteodata-140s-config.json")) as { params: [string, string][] }).params);
    const { sim, result, capture } = await busforgeDownload(THEBEN_METEODATA_140S, THEBEN_METEODATA_140S.collection, { ia: "1.1.24", params, links: decodeGroupTablesMv0705(addr, assoc) });
    expect(sim.refusals).toEqual([]);
    expect(result).toMatchObject({ kind: "flashed", verified: true, imageBytes: 1893, diffBytes: 2 });
    // The address table's count, which the unit reset at the declaration, and the download marker.
    expect(memoryWrites(capture, "Busforge", METEODATA)).toEqual(["4000:14", "4800:aa"]);
    expect(memoryWrites(capture, "Busforge", METEODATA)).toEqual(memoryWrites(captureText("meteodata-140s-ets-fulldownload.log"), "ETS", METEODATA));
    const ets = await replay(THEBEN_METEODATA_140S, THEBEN_METEODATA_140S.collection, ["captures/meteodata-140s-ets-fulldownload.log"], METEODATA);
    expect(differingOctets(sim, ets.sim)).toEqual([]);
  });
});

// The octets two simulated units hold otherwise, or that only one of them knows.
function differingOctets(a: SimUnit0701, b: SimUnit0701): string[] {
  const [ma, mb] = [a.memorySnapshot(), b.memorySnapshot()];
  return [...new Set([...ma.keys(), ...mb.keys()])].filter((at) => ma.get(at) !== mb.get(at)).sort((x, y) => x - y)
    .map((at) => `${at.toString(16)}: ${ma.get(at)?.toString(16) ?? "unknown"} / ${mb.get(at)?.toString(16) ?? "unknown"}`);
}

// A port for the KNXnet/IP server, which takes a port number for its UDP socket and TCP listener alike.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
  });
}
