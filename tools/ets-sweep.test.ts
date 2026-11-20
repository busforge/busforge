import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { appProgramId, loadKnxproj, readAppProgram } from "../packages/project/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { deviceConfiguration, deviceRows } from "./etsdiff.ts";
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
      line("ETS->BRIDGE", "4300"), // after a restart on the dead connection: a read again
    ), "ETS", DEV, "MV-07B0");
    expect([...s.memory]).toEqual([[0x4000, 0x0a], [0x4001, 0x0b], [0x4002, 0x03], [0x4003, 0x04]]);
    expect([...s.loadControls]).toEqual([[4, ["04"]]]);
    expect([...s.properties]).toEqual([["0/14 1@1", ["05"]]]);
    expect([...s.loadStates]).toEqual([[4, 0]]);
    expect([...s.tableReferences]).toEqual([[4, "00004000"]]);
    expect(s.restarts).toEqual(["0380"]);
    expect([...s.reads]).toEqual(["A_PropertyValue_Read 04071001", "A_DeviceDescriptor_Read 00"]);
    expect([s.writes, s.other, s.functionCalls]).toEqual([5, [], []]);
  });

  test("takes a memory-mapped load-state machine's control at 0x0104 and its state from 46825 + the machine", () => {
    const s = runState(capture(
      line("ETS->BRIDGE", "80"),
      line("ETS->BRIDGE", "42810104" + "31"), // LSM 3: load
      line("BRIDGE->ETS", "4641b6ec" + "02"), // its state byte (46825 + 3 = 0xB6EC): loading
    ), "ETS", DEV, "MV-0701");
    expect([[...s.loadControls], [...s.memory], [...s.loadStates]]).toEqual([[[3, ["31"]]], [], [[3, 2]]]);
  });

  test("names every difference both ways, a byte only one side wrote among them", () => {
    const ets = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4284400001020304"), line("BRIDGE->ETS", "43d60405100101")), "ETS", DEV, "MV-07B0");
    // Busforge: two of the four octets, a master reset (erase code 1, channel 0) and a key write.
    const bf = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "428240000102"), line("ETS->BRIDGE", "47810100"), line("ETS->BRIDGE", "4bd3ff00000000")), "ETS", DEV, "MV-07B0");
    expect(compareRuns(ets, ets)).toEqual([]);
    expect(compareRuns(ets, bf)).toEqual([
      "memory 0x4002-0x4003: ETS 0304, Busforge ----",
      "load state of object 4 at the end: ETS 1, Busforge not shown",
      "restart: ETS none, Busforge 03810100",
      "other services: ETS none, Busforge A_Key_Write ff00000000",
    ]);
  });
});

const LOG = (connect: string, done = true) => [
  "2026-01-01 08:00:00,000 [1] INFO  Knx.Ets.ViewModel.OnlineOperations.Model.BusConnectionService - Connect(192.168.1.1:3671)",
  "2026-01-01 08:00:01,000 [1] INFO  Knx.Ets.ViewModel.OnlineOperations.Download.DownloadManager - StartLoadDevice(Application) 1.1.20 Unit",
  `2026-01-01 08:00:02,000 [8] INFO  Falcon.KnxIp.TCP - Connect(${connect})`,
  "2026-01-01 08:00:03,000 [1] INFO  Knx.Ets.Hawk.LoadDeviceTask - Begin LoadApplicationProgram 1.1.20 (LoadApplicationProgram)",
  ...(done ? ["2026-01-01 08:00:09,000 [1] INFO  Knx.Ets.Sdk.DataProvider.ProjectData - UpdateProgramingState: Adr=True, Cfg=True, App=True, Par=True, Grp=True"] : []),
  "2026-01-01 08:00:10,000 [5] INFO  Knx.Ets.Hawk.LoadDeviceTask - End LoadApplicationProgram 1.1.20 (LoadApplicationProgram)",
].join("\n");

describe("a sweep row's verdict", () => {
  test("ETS's side from ETS6.log: the download connected to the simulator alone and ETS recorded it loaded", () => {
    expect(etsOutcome(LOG("10.0.0.5:3701"), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "completed" });
    expect(etsOutcome(LOG("10.0.0.5:3671"), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "driver-failed", why: "the download connected to 10.0.0.5:3671, not only to the simulator at 10.0.0.5:3701" });
    expect(etsOutcome(LOG("10.0.0.5:3701", false), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "ets-failed", why: "ETS did not record the application, its parameters and group addresses as loaded" });
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
    expect(judge({ ...ok, refusals: ["sim-refused x"] }, { ...bf, writes: 0 }, none)).toEqual({ verdict: "sim-refused", run: "ETS", refusals: ["sim-refused x"] });
    expect(judge({ outcome: { kind: "ets-failed", why: "e" }, refusals: [] }, bf, none)).toEqual({ verdict: "busforge-only", ets: "e", busforgeWrites: 3 });
    expect(judge({ outcome: { kind: "ets-failed", why: "e" }, refusals: [] }, { ...bf, writes: 0 }, none)).toEqual({ verdict: "ets-failed", why: "e" });
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
    expect(loadedImageCheck(bytes, appXml, conf)).toEqual({ state: "equal", bytes: 3882 });
    expect(loadedImageCheck(bytes, appXml, { ...conf, ia: "15.15.250" })).toEqual({ state: "not compared", why: "the export holds no device 15.15.250" });
  });
});
