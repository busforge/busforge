import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { appProgramId, loadKnxproj, readAppProgram } from "../packages/project/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { iaToNum } from "../packages/knx/src/index.ts";
import { captureText, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { capturedOnLoadedUnit, deviceConfiguration, deviceRows, parseCapture } from "./etsdiff.ts";
import { compareRuns, etsOutcome, judge, listRows, loadedImageCheck, readRow, runRow, runState, simRefusals, type RowConfiguration } from "./ets-sweep.ts";

// Each row runs Busforge's download into a simulated unit on the wall clock (tools/sim-unit.test.ts: about
// 15 s alone, twenty times that under a loaded full check).
setDefaultTimeout(300_000);

const TOOL = 0x11ff, DEV = 0x110a;
// One capture line as tools/knxproxy.ts logs it: a KNXnet/IP TUNNELLING_REQUEST carrying a cEMI L_Data frame.
function line(dir: "ETS->BRIDGE" | "BRIDGE->ETS", tpdu: string, code = dir === "ETS->BRIDGE" ? 0x11 : 0x29): string {
  const t = Buffer.from(tpdu, "hex");
  const [src, dst] = dir === "ETS->BRIDGE" ? [TOOL, DEV] : [DEV, TOOL];
  const cemi = Buffer.concat([Buffer.from([code, 0x00, 0xb0, 0x60, src >> 8, src & 0xff, dst >> 8, dst & 0xff, t.length - 1]), t]);
  const frame = Buffer.concat([Buffer.from([0x06, 0x10, 0x04, 0x20, 0x00, 10 + cemi.length, 0x04, 0x01, 0x00, 0x00]), cemi]);
  return `2026-01-01T00:00:00.000Z ${dir} TUNNELLING_REQ  | ${frame.toString("hex")}`;
}
// The interface's confirmation of a request to the unit, positive or negative, as the proxy logs it.
function con(tpdu: string, neg = false): string {
  const t = Buffer.from(tpdu, "hex");
  const cemi = Buffer.concat([Buffer.from([0x2e, 0x00, 0xb0, 0x60, TOOL >> 8, TOOL & 0xff, DEV >> 8, DEV & 0xff, t.length - 1]), t]);
  const frame = Buffer.concat([Buffer.from([0x06, 0x10, 0x04, 0x20, 0x00, 10 + cemi.length, 0x04, 0x01, 0x00, 0x00]), cemi]);
  return `2026-01-01T00:00:00.000Z BRIDGE->ETS TUNNELLING_REQ${neg ? " CON-NEG" : ""}  | ${frame.toString("hex")}`;
}
const capture = (...lines: string[]) => lines.join("\n");

describe("a sweep row's run", () => {
  test("replays the requests to the unit, a repetition once, and keeps what the unit last reported", () => {
    const s = runState(capture(
      line("ETS->BRIDGE", "80"),
      line("ETS->BRIDGE", "43d70405100104"), // unload LSM 4
      line("ETS->BRIDGE", "43d70405100104"), // its repetition: not executed
      line("BRIDGE->ETS", "43d60405100100"),
      line("ETS->BRIDGE", "4684400001020304"), // A_Memory_Write 4 at 0x4000
      line("ETS->BRIDGE", "4a8240000a0b"), // A_Memory_Write 2 at 0x4000: the later write wins
      line("ETS->BRIDGE", "4fd504071001"), // a read: recorded, not compared
      line("BRIDGE->ETS", "4fd60407100100004000"),
      line("ETS->BRIDGE", "53d7000e100105"),
      line("ETS->BRIDGE", "5780"), // the basic restart
      line("ETS->BRIDGE", "4300"), // on the connection the restart ended: not taken
    ), "ETS", DEV, "MV-07B0");
    expect([...s.memory]).toEqual([[0x4000, 0x0a], [0x4001, 0x0b], [0x4002, 0x03], [0x4003, 0x04]]);
    expect([...s.loadControls]).toEqual([[4, ["04"]]]);
    expect([...s.properties]).toEqual([["0/14", ["1@1 05"]]]);
    expect([...s.loadStates]).toEqual([[4, 0]]);
    expect([...s.tableReferences]).toEqual([[4, "00004000"]]);
    expect(s.restarts).toEqual(["0380"]);
    expect([...s.reads]).toEqual(["A_PropertyValue_Read 04071001"]);
    expect([s.writes, s.other, s.functionCalls, s.notTaken]).toEqual([5, [], [], ["outside a connection: 4300"]]);
  });

  test("leaves out what the unit did not take: a frame the line confirmed negatively, a numbered one outside a connection; a restart it takes unconfirmed", () => {
    const s = runState(capture(
      line("ETS->BRIDGE", "4281400001"), // numbered, before any T_Connect
      line("ETS->BRIDGE", "80"), con("80"),
      line("ETS->BRIDGE", "4281400002"), con("4281400002", true), // not acknowledged on the line
      line("ETS->BRIDGE", "4281400003"), con("4281400003"), // its repetition, taken
      line("ETS->BRIDGE", "4780"), con("4780", true), // the restart, unacknowledged as the unit does it
      line("ETS->BRIDGE", "4b81400004"), // on the connection the restart ended
    ), "ETS", DEV, "MV-07B0");
    expect([...s.memory]).toEqual([[0x4000, 0x03]]);
    expect(s.restarts).toEqual(["0380"]);
    expect(s.notTaken).toEqual(["outside a connection: 4281400001", "not confirmed: 4281400002", "outside a connection: 4b81400004"]);
  });

  test("takes a memory-mapped load-state machine's control at 0x0104 and its state from 46825 + the machine", () => {
    const s = runState(capture(
      line("ETS->BRIDGE", "80"),
      line("ETS->BRIDGE", "42810104" + "31"), // LSM 3: load
      line("BRIDGE->ETS", "4641b6ec" + "02"), // its state byte (46825 + 3 = 0xB6EC): loading
    ), "ETS", DEV, "MV-0701");
    expect([[...s.loadControls], [...s.memory], [...s.loadStates]]).toEqual([[[3, ["31"]]], [], [[3, 2]]]);
    // A machine past the four the masks name, where the run controls it.
    const five = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "42810104" + "51"), line("BRIDGE->ETS", "4641b6ee" + "02")), "ETS", DEV, "MV-0701");
    expect([...five.loadStates]).toEqual([[5, 2]]);
  });

  test("takes a T_Connect on the open connection as nothing: a repetition after it is still not executed", () => {
    const s = runState(capture(
      line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "43d70405100104"),
      line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "43d70405100104"),
      line("ETS->BRIDGE", "81"), line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "43d70405100101"),
    ), "ETS", DEV, "MV-07B0");
    expect([...s.loadControls]).toEqual([[4, ["04", "01"]]]);
  });

  test("an allocation with fill sets its segment over the writes before it, not over those after it", () => {
    // Allocate 4 octets of object 4 with fill 00; the unit reports the segment at 0x4000.
    const run = (writeFirst: boolean) => runState(capture(
      line("ETS->BRIDGE", "80"),
      ...(writeFirst ? [line("ETS->BRIDGE", "428140" + "00aa")] : []),
      line("ETS->BRIDGE", "47d704051001030b000000040100"),
      line("ETS->BRIDGE", "4bd504071001"),
      line("BRIDGE->ETS", "43d60407100100004000"),
      ...(writeFirst ? [] : [line("ETS->BRIDGE", "4e8140" + "00aa")]),
    ), "ETS", DEV, "MV-07B0");
    expect([...run(true).memory]).toEqual([[0x4000, 0x00], [0x4001, 0x00], [0x4002, 0x00], [0x4003, 0x00]]);
    expect([...run(false).memory]).toEqual([[0x4000, 0xaa], [0x4001, 0x00], [0x4002, 0x00], [0x4003, 0x00]]);
    expect(compareRuns(run(true), run(false))[0]).toBe("memory 0x4000: ETS 00, Busforge aa");
    // Without the table reference the fill cannot be placed: the run is read, its comparison refused.
    const unplaced = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "43d704051001030b000000040100")), "ETS", DEV, "MV-07B0");
    expect(unplaced.unplaced).toEqual(["object 4 allocated with fill 00, at no table reference the run shows"]);
    expect(() => compareRuns(unplaced, run(true))).toThrow(/ETS's run cannot be compared: object 4 allocated with fill 00/);
  });

  test("names every difference both ways, a byte only one side wrote among them", () => {
    const ets = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4284400001020304"), line("BRIDGE->ETS", "43d60405100101")), "ETS", DEV, "MV-07B0");
    // Busforge: two of the four octets, a key write and a master reset (erase code 1, channel 0).
    const bf = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "428240000102"), line("ETS->BRIDGE", "47d3ff00000000"), line("ETS->BRIDGE", "4b810100")), "ETS", DEV, "MV-07B0");
    expect(compareRuns(ets, ets)).toEqual([]);
    expect(compareRuns(ets, bf)).toEqual([
      "memory 0x4002-0x4003: ETS 0304, Busforge ----",
      "load state of object 4 at the end: ETS 1, Busforge not shown",
      "restart: ETS none, Busforge 03810100",
      "other services: ETS none, Busforge A_Key_Write ff00000000",
    ]);
    // Property writes keep their order across overlapping elements.
    const props = (...w: string[]) => runState(capture(line("ETS->BRIDGE", "80"), ...w.map((x, i) => line("ETS->BRIDGE", Buffer.from([0x43 | (i << 2)]).toString("hex") + x))), "ETS", DEV, "MV-07B0");
    expect(compareRuns(props("d7003c2001aabb", "d7003c1002cc"), props("d7003c1002cc", "d7003c2001aabb"))).toEqual(["property write 0/60: ETS 2@1 aabb, 1@2 cc, Busforge 1@2 cc, 2@1 aabb"]);
    // A long run is cut in the text, but two runs that differ past the cut still read differently.
    const long = (last: string) => runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4298" + "4000" + "00".repeat(23) + last)), "ETS", DEV, "MV-07B0");
    const [a, b] = [compareRuns(long("01"), runState("", "ETS", DEV, "MV-07B0"))[0], compareRuns(long("02"), runState("", "ETS", DEV, "MV-07B0"))[0]];
    expect(a).toMatch(/^memory 0x4000-0x4017: ETS 0{32}\.\.\. \(24 octets, sha256 [0-9a-f]{16}\), Busforge -{32}\.\.\. \(24 octets, sha256 [0-9a-f]{16}\)$/);
    expect(a).not.toBe(b);
    // The same octets by another memory service.
    const user = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "42c2" + "02" + "4000" + "0102")), "ETS", DEV, "MV-07B0");
    const plain = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4282" + "4000" + "0102")), "ETS", DEV, "MV-07B0");
    expect(compareRuns(plain, user)).toEqual(["memory service 0x4000-0x4001: ETS A_Memory_Write, Busforge A_UserMemory_Write"]);
  });
});

const LOG = (connect: string, done = true) => [
  "2026-01-01 08:00:00,000 [1] INFO  Knx.Ets.ViewModel.OnlineOperations.Model.BusConnectionService - Connect(192.168.1.1:3671)",
  "2026-01-01 08:00:01,000 [1] INFO  Knx.Ets.ViewModel.OnlineOperations.Download.DownloadManager - StartLoadDevice(Application) 1.1.20 Unit",
  `2026-01-01 08:00:02,000 [8] INFO  Falcon.KnxIp.TCP - Connect(${connect})`,
  "2026-01-01 08:00:03,000 [1] INFO  Knx.Ets.Hawk.LoadDeviceTask - Begin LoadApplicationProgram 1.1.20 (LoadApplicationProgram)",
  // The project's earlier state, written as the task begins.
  "2026-01-01 08:00:04,000 [1] INFO  Knx.Ets.Sdk.DataProvider.ProjectData - UpdateProgramingState: Adr=True, Cfg=True, App=True, Par=True, Grp=True",
  "2026-01-01 08:00:08,000 [5] INFO  Knx.Ets.Hawk.Impl.LoadProcedure - Executing: <LdCtrlDisconnect />",
  ...(done ? ["2026-01-01 08:00:09,000 [1] INFO  Knx.Ets.Sdk.DataProvider.ProjectData - UpdateProgramingState: Adr=True, Cfg=True, App=True, Par=True, Grp=True"] : []),
  "2026-01-01 08:00:10,000 [5] INFO  Knx.Ets.Hawk.LoadDeviceTask - End LoadApplicationProgram 1.1.20 (LoadApplicationProgram)",
].join("\n");

describe("a sweep row's verdict", () => {
  test("ETS's side from ETS6.log: the download connected to the simulator alone and ETS recorded it loaded", () => {
    expect(etsOutcome(LOG("10.0.0.5:3701"), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "completed" });
    expect(etsOutcome(LOG("10.0.0.5:3671"), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "driver-failed", why: "the download connected to 10.0.0.5:3671, not only to the simulator at 10.0.0.5:3701" });
    expect(etsOutcome(LOG("10.0.0.5:3701", false), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "ets-failed", why: "ETS did not record the address, configuration, application, parameters and group addresses as loaded after the download's steps" });
    expect(etsOutcome(LOG("10.0.0.5:3701").replace("Cfg=True, App=True, Par=True, Grp=True\n2026-01-01 08:00:10", "Cfg=True, App=False, Par=False, Grp=False\n2026-01-01 08:00:10"), "1.1.20", "10.0.0.5:3701").kind).toBe("ets-failed");
    expect(etsOutcome(LOG("10.0.0.5:3701"), "1.1.2", "10.0.0.5:3701").kind).toBe("driver-failed");
    expect(etsOutcome(`${LOG("10.0.0.5:3701")}\n${LOG("10.0.0.5:3701")}`, "1.1.20", "10.0.0.5:3701").kind).toBe("driver-failed");
  });

  test("the simulator's refusals among its lines", () => {
    expect(simRefusals("2026-01-01T00:00:00.000Z connected to 1.1.100\n2026-01-01T00:00:01.000Z sim-refused A_Memory_Write 1 at 0x4000: outside an allocated segment\n")).toEqual(["sim-refused A_Memory_Write 1 at 0x4000: outside an allocated segment"]);
  });

  test("one verdict, in order: the driver, ETS's side, the simulator, Busforge's refusal, the comparison", () => {
    const ok = { outcome: { kind: "completed" } as const, refusals: [] };
    const bf = { refusals: [], refused: null, writes: 3 };
    const none = () => [];
    expect(judge({ outcome: { kind: "driver-failed", why: "w" }, refusals: ["sim-refused x"] }, bf, none)).toEqual({ verdict: "driver-failed", why: "w" });
    expect(judge({ ...ok, refusals: ["sim-refused x"] }, bf, none)).toEqual({ verdict: "busforge-only", ets: "the simulator refused ETS: sim-refused x", busforgeWrites: 3 });
    expect(judge({ ...ok, refusals: ["sim-refused x"] }, { ...bf, writes: 0 }, none)).toEqual({ verdict: "sim-refused", run: "ETS", refusals: ["sim-refused x"], busforge: "Busforge wrote nothing" });
    expect(judge({ outcome: { kind: "ets-failed", why: "e" }, refusals: [] }, bf, none)).toEqual({ verdict: "busforge-only", ets: "e", busforgeWrites: 3 });
    expect(judge({ outcome: { kind: "ets-failed", why: "e" }, refusals: [] }, { ...bf, writes: 0 }, none)).toEqual({ verdict: "ets-failed", why: "e", busforge: "Busforge wrote nothing" });
    // Where ETS failed, Busforge's refusal after its writes and the simulator's refusal of Busforge stay named.
    expect(judge({ outcome: { kind: "ets-failed", why: "e" }, refusals: [] }, { ...bf, refused: { code: "C", message: "m" } }, none)).toEqual({ verdict: "busforge-only", ets: "e", busforgeWrites: 3, busforgeRefused: "C" });
    expect(judge({ outcome: { kind: "ets-failed", why: "e" }, refusals: [] }, { ...bf, refusals: ["sim-refused y"] }, none)).toEqual({ verdict: "ets-failed", why: "e", busforge: "the simulator refused Busforge: sim-refused y" });
    expect(judge(ok, { ...bf, refusals: ["sim-refused y"] }, none)).toEqual({ verdict: "sim-refused", run: "Busforge", refusals: ["sim-refused y"] });
    expect(judge(ok, { ...bf, refused: { code: "C", message: "m" } }, none)).toEqual({ verdict: "refused", code: "C", message: "m" });
    expect(judge(ok, bf, none)).toEqual({ verdict: "identical" });
    expect(judge(ok, bf, () => ["d"])).toEqual({ verdict: "differs", differences: ["d"] });
  });
});

// Busforge's current plan against every ETS row in the corpus. A row's explained.json names its verdict and
// every difference with its cause; a new difference fails, and so does an explained one that is gone.
corpusDescribe("the ETS sweep rows", () => {
  const rows = listRows();
  test("the corpus holds rows", () => {
    expect(rows.length).toBeGreaterThan(0);
  });
  for (const id of rows) {
    test(`${id}: Busforge's download into a fresh simulated unit has the verdict and the differences explained`, async () => {
      const row = readRow(id);
      const r = await runRow(row);
      const found = r.verdict.verdict === "differs" ? r.verdict.differences : [];
      expect({ verdict: r.verdict.verdict, differences: found }).toEqual({ verdict: row.explained.verdict, differences: row.explained.differences.map((d) => d.difference) });
      expect(row.explained.differences.every((d) => d.cause.trim().length > 0)).toBe(true);
    });
  }

  // The second check on an export the corpus holds without a password: the bench project, saved after ETS's
  // full download of the GVS AMMA (tools/ets-records.test.ts).
  test("Busforge's images against ETS's LoadedImage of a device in an export", () => {
    const bytes = readFileSync(corpusPath("captures/bench-ets-project-params-edited-after-download.knxproj"));
    const project = loadKnxproj(bytes, undefined, "bench");
    const amma = project.devices.find((d) => appProgramId(d.appRef) === "M-0085_A-0072-30-69AA")!;
    const appXml = readAppProgram(bytes, amma.appRef)!;
    const c = deviceConfiguration(parseAppConfig(appXml), deviceRows(project, amma.id));
    const conf: RowConfiguration = { ia: amma.ia, params: [...c.params], links: c.links, moduleInstances: c.instances, comObjectOverrides: [...c.comObjectOverrides] };
    // Whether the unit held the application, from the capture of that download.
    const held = capturedOnLoadedUnit(parseCapture(captureText("gvs-amma-ets-fulldownload-defaults.log"), iaToNum(amma.ia)));
    expect(loadedImageCheck(bytes, appXml, conf, held)).toEqual({ state: "equal", bytes: 3882 });
    expect(loadedImageCheck(bytes, appXml, { ...conf, ia: "15.15.250" }, held)).toEqual({ state: "not compared", why: "the export holds no device 15.15.250" });
  });
});
