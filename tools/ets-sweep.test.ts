import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { appProgramId, loadKnxproj, readAppProgram } from "../packages/project/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { iaToNum } from "../packages/knx/src/index.ts";
import { storeZip } from "../packages/project/test/ziputil.ts";
import { captureText, corpusPath, corpusRoot } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { capturedOnLoadedUnit, deviceConfiguration, deviceRows, dialogueDifferences, parseCapture } from "./etsdiff.ts";
import { causes, compareRuns, configuredApplication, etsBranches, etsOutcome, expected, inCorpus, judge, judged, listRows, loadedImageCheck, MANIFEST, MANIFEST_FORMAT, movedSince, readRow, refusalsAfterRestart, rejudge, ROW_FILES, runState, simRefusals, SWEEP_DIR, updateManifest, verdictDetail, writeRejudged, type EtsOutcome, type Explained, type Manifest, type ManifestRow, type RowConfiguration, type RowSpec, type Verdict, withCause } from "./ets-sweep.ts";
import { ROW_WORKERS, RowPool } from "./ets-sweep-workers.ts";
import { mismatchLines } from "./sim-unit-product.ts";
import { tempDir } from "./test-temp.ts";

// Each row runs Busforge's download into a simulated unit on the wall clock (tools/sim-unit.test.ts: about
// 15 s alone, twenty times that under a loaded full check), counted from when a worker takes the row.
const ROW_TIMEOUT_MS = 300_000;
setDefaultTimeout(ROW_TIMEOUT_MS);

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

// Hardware with a PEI program, in the form ETS writes its Hardware2Program id (both programs' numbers, each with its
// OEM part): synthetic ids, in the shape such catalogue rows take.
describe("the application a row's configuration runs", () => {
  const H2P = "M-0083_H-PEI.2F1-0-O0007_HP-4201-13-6B9E-O0007-4201-23-00B3-O0007";
  const APP = "M-0083_A-4201-13-6B9E-O0007", PEI = "M-0083_A-4201-23-00B3-O0007";
  const program = (id: string, type: string) => `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083"><ApplicationPrograms><ApplicationProgram Id="${id}" ProgramType="${type}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="${id}"><Static/></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const exportOf = (types: Record<string, string>) => storeZip({
    "M-0083/Hardware.xml": `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083"><Hardware><Hardware Id="M-0083_H-PEI.2F1-0-O0007"><Hardware2Programs><Hardware2Program Id="${H2P}" MediumTypes="MT-0"><ApplicationProgramRef RefId="${APP}"/><ApplicationProgramRef RefId="${PEI}"/></Hardware2Program></Hardware2Programs></Hardware></Hardware></Manufacturer></ManufacturerData></KNX>`,
    ...Object.fromEntries(Object.entries(types).map(([id, type]) => [`M-0083/${id}.xml`, program(id, type)])),
  });
  test("on PEI hardware: the export's application program, not the id read as one", () => {
    expect(appProgramId(H2P)).toBe("M-0083_A-4201-13-6B9E-O0007-4201-23-00B3-O0007");
    expect(configuredApplication(H2P, exportOf({ [APP]: "ApplicationProgram", [PEI]: "PeiProgram" }))).toBe(APP);
  });
  test("none where the product data do not say which program is the application", () => {
    expect(configuredApplication(H2P, exportOf({ [APP]: "ApplicationProgram", [PEI]: "ApplicationProgram" }))).toBe("");
  });
  test("the id's own reading on one-program hardware, and for a row without an export", () => {
    expect(configuredApplication("M-0083_H-1_HP-00B6-32-9642", exportOf({ [APP]: "ApplicationProgram", [PEI]: "PeiProgram" }))).toBe("M-0083_A-00B6-32-9642");
    expect(configuredApplication("M-0083_H-1_HP-00B6-32-9642", undefined)).toBe("M-0083_A-00B6-32-9642");
  });
});

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

  test("counts where ETS read before it wrote on MV-0701 as the unit took the frames: a repetition once, a write outside a connection none", () => {
    const branches = etsBranches("", capture(
      line("ETS->BRIDGE", "80"),
      line("ETS->BRIDGE", "42024000"), // A_Memory_Read 2 at 0x4000
      line("BRIDGE->ETS", "42424000aabb"), // its answer
      line("BRIDGE->ETS", "42424000aabb"), // the unit's repetition of it
      line("ETS->BRIDGE", "c2"),
      line("ETS->BRIDGE", "468240000102"), // A_Memory_Write 2 at 0x4000
      line("ETS->BRIDGE", "468240000102"), // its repetition: not executed
      line("ETS->BRIDGE", "81"),
      line("ETS->BRIDGE", "4a8240000102"), // numbered, outside a connection: not taken
    ), DEV, "MV-0701");
    expect(branches).toEqual([{ on: "read-before-write", answer: "the unit answered ETS 2 octets of its memory before ETS wrote there; ETS then wrote 2 of them and left 0 as the unit answered them", evidence: ["1 memory answers of the unit, 1 memory writes of ETS the line took"] }]);
  });

  test("records PreferPartialDownloadIfApplicationLoaded in etsBranches, with fallback, differential fallback, and device-window scoping", () => {
    const tried = "2026-11-27 16:45:20,206 [57] INFO  Knx.Ets.Hawk.LoadDeviceTask - Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded";
    const fallback = "2026-11-21 08:23:19,738 [38] INFO  Knx.Ets.Hawk.LoadDeviceTask - Partial download not possible because application program not loaded: load status=3";
    const differentApp = "2026-11-28 03:02:11,635 [34] INFO  Knx.Ets.Hawk.LoadDeviceTask - Partial download not possible because different application program: 72 9071 20 instead of 197 0366 11";
    const diffFallback = "2026-11-27 16:30:29,000 [48] WARN  Knx.Ets.Hawk.LoadDeviceTask - Differential Image Stamp does not match, falling back to partial download";
    expect(etsBranches("", "", DEV, "MV-07B0")).toEqual([]);
    expect(etsBranches(tried, "", DEV, "MV-07B0")).toEqual([{
      on: "prefer-partial",
      answer: "ETS tried partial/differential download because of PreferPartialDownloadIfApplicationLoaded",
      evidence: ["INFO  Knx.Ets.Hawk.LoadDeviceTask - Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded"],
    }]);
    expect(etsBranches(`${tried}\n${fallback}`, "", DEV, "MV-07B0")).toEqual([{
      on: "prefer-partial",
      answer: "ETS tried partial/differential download because of PreferPartialDownloadIfApplicationLoaded, then fell back (Partial download not possible because application program not loaded: load status=3)",
      evidence: [
        "INFO  Knx.Ets.Hawk.LoadDeviceTask - Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded",
        "INFO  Knx.Ets.Hawk.LoadDeviceTask - Partial download not possible because application program not loaded: load status=3",
      ],
    }]);
    expect(etsBranches(`${tried}\n${differentApp}`, "", DEV, "MV-07B0")).toEqual([{
      on: "prefer-partial",
      answer: "ETS tried partial/differential download because of PreferPartialDownloadIfApplicationLoaded, then fell back (Partial download not possible because different application program: 72 9071 20 instead of 197 0366 11)",
      evidence: [
        "INFO  Knx.Ets.Hawk.LoadDeviceTask - Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded",
        "INFO  Knx.Ets.Hawk.LoadDeviceTask - Partial download not possible because different application program: 72 9071 20 instead of 197 0366 11",
      ],
    }]);
    expect(etsBranches(`${tried}\n${diffFallback}`, "", DEV, "MV-07B0")).toEqual([{
      on: "prefer-partial",
      answer: "ETS tried partial/differential download because of PreferPartialDownloadIfApplicationLoaded (Differential Image Stamp does not match, falling back to partial download)",
      evidence: [
        "INFO  Knx.Ets.Hawk.LoadDeviceTask - Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded",
        "WARN  Knx.Ets.Hawk.LoadDeviceTask - Differential Image Stamp does not match, falling back to partial download",
      ],
    }]);
    // Standalone Partial download not possible without Trying partial... is still reported.
    expect(etsBranches(fallback, "", DEV, "MV-07B0")).toEqual([{
      on: "prefer-partial",
      answer: "ETS reported partial download not possible (Partial download not possible because application program not loaded: load status=3)",
      evidence: ["INFO  Knx.Ets.Hawk.LoadDeviceTask - Partial download not possible because application program not loaded: load status=3"],
    }]);
    // A fallback logged during a later download of another device (1.1.11) is not attributed to DEV (1.1.10).
    const twoDevices = [
      "2026-11-27 16:45:19,000 [1] INFO  Knx.Ets.ViewModel.OnlineOperations.Download.DownloadManager - StartLoadDevice(Application) 1.1.10 UnitA",
      tried,
      "2026-11-27 16:45:25,000 [1] INFO  Knx.Ets.Hawk.LoadDeviceTask - End LoadApplicationProgram 1.1.10 (LoadApplicationProgram)",
      "2026-11-27 16:45:26,000 [1] INFO  Knx.Ets.ViewModel.OnlineOperations.Download.DownloadManager - StartLoadDevice(Application) 1.1.11 UnitB",
      tried,
      fallback,
      "2026-11-27 16:45:30,000 [1] INFO  Knx.Ets.Hawk.LoadDeviceTask - End LoadApplicationProgram 1.1.11 (LoadApplicationProgram)",
    ].join("\n");
    expect(etsBranches(twoDevices, "", DEV, "MV-07B0")).toEqual([{
      on: "prefer-partial",
      answer: "ETS tried partial/differential download because of PreferPartialDownloadIfApplicationLoaded",
      evidence: ["INFO  Knx.Ets.Hawk.LoadDeviceTask - Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded"],
    }]);
  });

  test("records a function property's state read as a read and compares its command", () => {
    const s = runState(capture(
      line("ETS->BRIDGE", "01d500110010330000"), // A_FunctionPropertyExtState_Read of the security mode (17/1/51)
      line("ETS->BRIDGE", "80"),
      line("ETS->BRIDGE", "42c8113300"), // A_FunctionPropertyState_Read
      line("ETS->BRIDGE", "46c7113301"), // A_FunctionPropertyCommand
    ), "ETS", DEV, "MV-07B0");
    expect([...s.reads]).toEqual(["A_FunctionPropertyExtState_Read 00110010330000", "A_FunctionPropertyState_Read 113300"]);
    expect([s.functionCalls, s.writes]).toEqual([["A_FunctionPropertyCommand 113301"], 1]);
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

  test("takes a state the unit reported to one run only for that run's read, not for a difference", () => {
    const ets = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "43d505051001"), line("BRIDGE->ETS", "43d60505100100")), "ETS", DEV, "MV-07B0");
    const bf = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "43d504071001"), line("BRIDGE->ETS", "43d60407100100005000")), "ETS", DEV, "MV-07B0");
    expect([[...ets.loadStates], [...bf.tableReferences]]).toEqual([[[5, 0]], [[4, "00005000"]]]);
    expect(compareRuns(ets, bf)).toEqual([]);
    const other = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "43d505051001"), line("BRIDGE->ETS", "43d60505100101")), "ETS", DEV, "MV-07B0");
    expect(compareRuns(ets, other)).toEqual(["load state of object 5 at the end: ETS 0, Busforge 1"]);
  });

  test("names every difference both ways, a byte only one side wrote among them", () => {
    const ets = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4284400001020304"), line("BRIDGE->ETS", "43d60405100101")), "ETS", DEV, "MV-07B0");
    // Busforge: two of the four octets, a key write and a master reset (erase code 1, channel 0).
    const bf = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "428240000102"), line("ETS->BRIDGE", "47d3ff00000000"), line("ETS->BRIDGE", "4b810100")), "ETS", DEV, "MV-07B0");
    expect(compareRuns(ets, ets)).toEqual([]);
    expect(compareRuns(ets, bf)).toEqual([
      "memory 0x4002-0x4003: ETS 0304, Busforge ----",
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

describe("a refusal after the restart", () => {
  const NOT_SHOWN = "whether the unit acknowledges a frame then is not shown";
  const DEAD = "what the unit answers it is not shown";
  // ETS's session: a write, the restart, its T_Disconnect; then Busforge-like probes on the ended connection.
  const run = (...extra: string[]) => runState(capture(
    line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4282400001"), line("ETS->BRIDGE", "4780"), ...extra,
  ), "ETS", DEV, "MV-07B0");
  const lines = (...l: string[]) => ["connected to 1.1.255", ...l].join("\n");

  test("leaves the comparison whole: a T_Disconnect, a read and a read on the ended connection, after the last change", () => {
    const sim = lines("restart", `2026-01-01T00:00:01.000Z sim-refused 81 1275 ms after the restart: ${NOT_SHOWN}`, `sim-refused 4b00 0 ms after the restart: ${NOT_SHOWN}`, `sim-refused numbered frame 4b00 from 1.1.255 on the connection the restart ended: ${DEAD}`);
    const r = refusalsAfterRestart(sim, run(line("ETS->BRIDGE", "81"), con("81", true)));
    expect(r).toEqual({ after: [`sim-refused 81 1275 ms after the restart: ${NOT_SHOWN}`, `sim-refused 4b00 0 ms after the restart: ${NOT_SHOWN}`, `sim-refused numbered frame 4b00 from 1.1.255 on the connection the restart ended: ${DEAD}`], others: [] });
    // A T_Connect the line confirmed negatively after the restart (a restart proof opening a probe's connection).
    const connect = `sim-refused 80 3002 ms after the restart: ${NOT_SHOWN}`;
    const proof = runState(capture(
      line("ETS->BRIDGE", "80"), con("80"), line("ETS->BRIDGE", "4282400001"), con("4282400001"), line("ETS->BRIDGE", "4780"), con("4780"),
      line("ETS->BRIDGE", "80"), con("80", true),
    ), "ETS", DEV, "MV-07B0");
    expect(refusalsAfterRestart(lines("restart", connect), proof)).toEqual({ after: [connect], others: [] });
    // (b) alone: the T_Connect refused by the simulator, confirmed on the line, nothing left untaken.
    const confirmed = runState(capture(line("ETS->BRIDGE", "80"), con("80"), line("ETS->BRIDGE", "4282400001"), con("4282400001"), line("ETS->BRIDGE", "4780"), con("4780"), line("ETS->BRIDGE", "80"), con("80")), "ETS", DEV, "MV-07B0");
    expect(refusalsAfterRestart(lines("restart", connect), confirmed)).toEqual({ after: [connect], others: [] });
    // (c) alone: the untaken T_Connect is no write or load request; the refusal is the T_Disconnect.
    const disconnect = `sim-refused 81 1275 ms after the restart: ${NOT_SHOWN}`;
    expect(refusalsAfterRestart(lines("restart", disconnect), proof)).toEqual({ after: [disconnect], others: [] });
  });

  test("does not: a refusal before the restart, of a write, in a run without a restart or that changed the unit after it, or that the unit did not take a write of", () => {
    const before = `sim-refused 4282400001 from 1.1.255: outside an allocated segment`;
    expect(refusalsAfterRestart(lines(before, "restart"), run()).others).toEqual([before]);
    const write = `sim-refused 4b82400001 10 ms after the restart: ${NOT_SHOWN}`;
    expect(refusalsAfterRestart(lines("restart", write), run()).others).toEqual([write]);
    const deadWrite = `sim-refused numbered frame 4b82400001 from 1.1.255 on the connection the restart ended: ${DEAD}`;
    expect(refusalsAfterRestart(lines("restart", deadWrite), run()).others).toEqual([deadWrite]);
    const otherForm = "sim-refused A_Restart: how the unit takes a basic restart is not shown";
    expect(refusalsAfterRestart(lines("restart", otherForm), run()).others).toEqual([otherForm]);
    const disconnect = `sim-refused 81 10 ms after the restart: ${NOT_SHOWN}`;
    // A T_Connect after the restart, with a write on the connection it opened: the run changed the unit after it.
    const connect = `sim-refused 80 3002 ms after the restart: ${NOT_SHOWN}`;
    expect(refusalsAfterRestart(lines("restart", connect), run(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4282400002"))).others).toEqual([connect]);
    expect(refusalsAfterRestart(lines(disconnect), run()).others).toEqual([disconnect]);
    // A write after the restart, on a new connection.
    expect(refusalsAfterRestart(lines("restart", disconnect), run(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4282400002"))).others).toEqual([disconnect]);
    // A write the line confirmed negatively: the unit did not take it.
    const neg = runState(capture(line("ETS->BRIDGE", "80"), line("ETS->BRIDGE", "4282400001"), con("4282400001", true), line("ETS->BRIDGE", "4680"), con("4680")), "ETS", DEV, "MV-07B0");
    expect(refusalsAfterRestart(lines("restart", disconnect), neg).others).toEqual([disconnect]);
  });
});

describe("a sweep row's verdict", () => {
  test("ETS's side from ETS6.log: the download connected to the simulator alone and ETS recorded it loaded", () => {
    expect(etsOutcome(LOG("10.0.0.5:3701"), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "completed" });
    expect(etsOutcome(LOG("10.0.0.5:3671"), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "driver-failed", why: "the download connected to 10.0.0.5:3671, not only to the simulator at 10.0.0.5:3701" });
    expect(etsOutcome(LOG("10.0.0.5:3701", false), "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "ets-failed", why: "ETS did not record the address, configuration, application, parameters and group addresses as loaded after the download's steps" });
    expect(etsOutcome(LOG("10.0.0.5:3701").replace("Cfg=True, App=True, Par=True, Grp=True\n2026-01-01 08:00:10", "Cfg=True, App=False, Par=False, Grp=False\n2026-01-01 08:00:10"), "1.1.20", "10.0.0.5:3701").kind).toBe("ets-failed");
    expect(etsOutcome(LOG("10.0.0.5:3701"), "1.1.2", "10.0.0.5:3701").kind).toBe("driver-failed");
    expect(etsOutcome(`${LOG("10.0.0.5:3701")}\n${LOG("10.0.0.5:3701")}`, "1.1.20", "10.0.0.5:3701").kind).toBe("driver-failed");
  });

  test("ETS's side from ETS6.log: a load task that failed ends at its exception, and ETS's reconnects after it are not the download's", () => {
    // As ETS 6.4.1 logs a download whose interface went away mid-way (the simulator stopped), shortened.
    const failed = [
      "2026-01-01 08:00:01,000 [1] INFO  Knx.Ets.ViewModel.OnlineOperations.Download.DownloadManager - StartLoadDevice(Application) 1.1.20 Unit",
      "2026-01-01 08:00:02,000 [5] INFO  Falcon.KnxIp.TCP - Connect(10.0.0.5:3701)",
      "2026-01-01 08:00:03,000 [1] INFO  Knx.Ets.Hawk.LoadDeviceTask - Begin LoadApplicationProgram 1.1.20 (LoadApplicationProgram)",
      "2026-01-01 08:00:04,000 [1] INFO  Knx.Ets.Sdk.DataProvider.ProjectData - UpdateProgramingState: Adr=True, Cfg=False, App=False, Par=False, Grp=False",
      "2026-01-01 08:00:05,000 [5] WARN  Falcon.KnxIp.TCP - tcp:10.0.0.5:3701 SocketException in ReadCompleted, exiting: Unable to read data from the transport connection: Connection reset by peer.",
      "2026-01-01 08:00:20,000 [40] WARN  Falcon.Device - [co 1.1.20 LoadApplicationProgram] Error on try#1... retrying: Verbindungsqualität mit 1.1.20 ist zu schlecht für eine stabile Verbindung",
      "2026-01-01 08:00:30,000 [44] WARN  Knx.Ets.Hawk.LoadDeviceTask - Knx.Ets.Hawk.DeviceManagementException: Verbindungsqualität mit 1.1.20 ist zu schlecht für eine stabile Verbindung ---> Knx.Falcon.CommunicationException: Verbindungsqualität mit 1.1.20 ist zu schlecht für eine stabile Verbindung",
      "2026-01-01 08:00:30,001 [1] ERROR Knx.Ets.ViewModel.OnlineOperations.Download.HawkPendingOperation - Error during executing OnStateChanged method of object Knx.Ets.Hawk.LoadDeviceTask",
      "2026-01-01 08:00:45,000 [20] INFO  Falcon.KnxIp.TCP - Connect(192.168.1.1:3671)",
    ].join("\n");
    expect(etsOutcome(failed, "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "ets-failed", why: "ETS's load task failed: Knx.Ets.Hawk.DeviceManagementException: Verbindungsqualität mit 1.1.20 ist zu schlecht für eine stabile Verbindung" });
    // A warning of the task that is no exception (ETS goes on and ends the task) is not its failure.
    const warned = LOG("10.0.0.5:3701").replace("\n2026-01-01 08:00:08,000", "\n2026-01-01 08:00:05,000 [5] WARN  Knx.Ets.Hawk.LoadDeviceTask - Differential Image Stamp does not match, falling back to partial download\n2026-01-01 08:00:08,000");
    expect(warned).toContain("Differential Image Stamp");
    expect(etsOutcome(warned, "1.1.20", "10.0.0.5:3701")).toEqual({ kind: "completed" });
    // A connection elsewhere during the failed task still makes the row the driver's failure.
    expect(etsOutcome(failed.replace("Connect(10.0.0.5:3701)", "Connect(10.0.0.5:3711)"), "1.1.20", "10.0.0.5:3701").kind).toBe("driver-failed");
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

  test("a refusal's detail, its time after the restart left out, is held to explained.json: a refusal of another cause fails", () => {
    const timing: Verdict = { verdict: "sim-refused", run: "Busforge", refusals: ["sim-refused 80 3002 ms after the restart: whether the unit acknowledges a frame then is not shown"] };
    const pinned: Explained = { verdict: "sim-refused", differences: [], detail: verdictDetail(timing) };
    expect(pinned.detail).toEqual({ run: "Busforge", refusals: ["sim-refused 80 <n> ms after the restart: whether the unit acknowledges a frame then is not shown"] });
    // The same refusal at another time is the row's verdict; one of another cause, or of the other run, is not.
    expect(judged({ ...timing, refusals: [timing.refusals[0].replace("3002", "3017")] })).toEqual(expected(pinned));
    expect(judged({ ...timing, refusals: ["sim-refused A_PropertyValue_Read 2/7 of 1 from 1 after a load event of its machine: what the unit reports there then is not shown"] })).not.toEqual(expected(pinned));
    expect(judged({ ...timing, run: "ETS" })).not.toEqual(expected(pinned));
    // An explained.json that names the verdict alone does not hold a refusal.
    expect(judged(timing)).not.toEqual(expected({ verdict: "sim-refused", differences: [] }));
    expect([verdictDetail({ verdict: "identical" }), verdictDetail({ verdict: "differs", differences: ["d"] })]).toEqual([undefined, undefined]);
    expect(verdictDetail({ verdict: "refused", code: "C", message: "m" })).toEqual({ code: "C", message: "m" });
  });
});

describe("rejudging a row (--rejudge)", () => {
  const ID = "M-0000_A-0000-00-0000/defaults";
  // A row's manifest entry as manifestRow gives it after a rerun that found `found` (and the calibration positions
  // `positions`): the causes are looked up in the row's explained.json `old`.
  const entry = (old: Explained, verdict: ManifestRow["verdict"], found: string[], extra: Partial<ManifestRow> & { positions?: string[] } = {}): ManifestRow => {
    const { positions, ...rest } = extra;
    const differences = causes(verdict === "differs" ? { verdict, differences: found } : { verdict: "identical" }, old);
    return {
      application: "M-0000_A-0000-00-0000", variant: "defaults", unit: "u", product: "p", mask: "MV-07B0", manufacturer: "M-0000", etsBuild: "ETS",
      verdict, first: differences[0]?.difference ?? null, cause: differences[0]?.cause ?? null, differences,
      reads: { onlyEts: [], onlyBusforge: [] }, notTaken: { ets: [], busforge: [] }, loadedImage: { state: "no export" },
      calibration: positions === undefined ? null : { capture: "c.log", differences: positions.map((p) => withCause(p, old.calibration)) },
      refusalsAfterRestart: [], files: [],
      ...rest,
    };
  };
  const manifest = (...rows: ManifestRow[]): Manifest => ({ format: MANIFEST_FORMAT, busforgeRevision: null, rows });
  const olds = (old: Explained) => new Map([[ID, old]]);
  const explainedAt = (root: string) => join(root, SWEEP_DIR, ID, ROW_FILES.explained);
  const manifestAt = (root: string) => JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as Manifest;

  test("an unchanged row: explained.json is not written, the manifest is, the exit is 0", () => {
    const root = tempDir("ets-sweep-rejudge-");
    const old: Explained = { verdict: "differs", differences: [{ difference: "memory 0x4000: ETS 01, Busforge 02", cause: "c" }] };
    const now = entry(old, "differs", ["memory 0x4000: ETS 01, Busforge 02"]);
    expect(rejudge(old, now)).toEqual({ explained: old, moved: false, unexplained: [], gone: [] });
    const { report, exit } = writeRejudged(root, [now], olds(old), manifest(now), updateManifest(manifest(now), [now], [ID]));
    expect(exit).toBe(0);
    expect(existsSync(explainedAt(root))).toBe(false);
    expect(manifestAt(root).rows).toEqual([now]);
    expect(report).toContain("  nothing moved since the manifest (notes.md stays)");
    // A calibrated row without positions keeps the form its explained.json has; so does a refused row whose verdict stays.
    const identical: Explained = { verdict: "identical", differences: [] };
    expect(rejudge(identical, entry(identical, "identical", [], { positions: [] }))).toEqual({ explained: identical, moved: false, unexplained: [], gone: [] });
    const refused: Explained = { verdict: "sim-refused", differences: [] };
    expect(rejudge(refused, entry(refused, "sim-refused", [], { first: "sim-refused x" }))).toEqual({ explained: refused, moved: false, unexplained: [], gone: [] });
  });

  test("a moved verdict and a moved list of differences: the differences that stay keep their causes", () => {
    const root = tempDir("ets-sweep-rejudge-");
    // sim-refused before, identical now (a refusal rule of the comparison changed).
    const refused: Explained = { verdict: "sim-refused", differences: [] };
    const before = entry(refused, "sim-refused", [], { first: "sim-refused 81 33 ms after the restart: x", cause: "the simulator refused ETS" });
    const identical = entry(refused, "identical", [], { refusalsAfterRestart: [{ run: "ETS", refusal: "sim-refused 81 33 ms after the restart: x" }] });
    expect(rejudge(refused, identical)).toEqual({ explained: { verdict: "identical", differences: [] }, moved: true, unexplained: [], gone: [] });
    const { report, exit } = writeRejudged(root, [identical], olds(refused), manifest(before), updateManifest(manifest(before), [identical], [ID]));
    expect(exit).toBe(0);
    expect(JSON.parse(readFileSync(explainedAt(root), "utf8"))).toEqual({ verdict: "identical", differences: [] });
    expect(report).toEqual(expect.arrayContaining([
      "    verdict: sim-refused -> identical",
      "    first: sim-refused 81 33 ms after the restart: x -> none",
      "    refusal after the restart new: ETS: sim-refused 81 33 ms after the restart: x",
    ]));
    // A refusal whose time after the restart alone moved (Busforge's run is on the wall clock), and a repeated item.
    const at = (ms: number, notTaken: string[]) => entry(refused, "sim-refused", [], { first: `sim-refused 80 ${ms} ms after the restart: x`, refusalsAfterRestart: [{ run: "Busforge", refusal: `sim-refused 80 ${ms} ms after the restart: x` }], notTaken: { ets: [], busforge: notTaken } });
    expect(movedSince(at(3002, ["outside a connection: 4300"]), at(3003, ["outside a connection: 4300", "outside a connection: 4300"]))).toEqual([
      "first: only its time after the restart moved",
      "refusals after the restart: only their times after the restart moved",
      "not taken by the unit, Busforge 1 -> 2 times: outside a connection: 4300",
    ]);
    // Two explained differences, one of them gone (named with the cause it had); a calibration position that stays.
    const two: Explained = { verdict: "differs", differences: [{ difference: "d1", cause: "c1" }, { difference: "d2", cause: "c2" }], calibration: [{ difference: "p1", cause: "k1" }] };
    expect(rejudge(two, entry(two, "differs", ["d1"], { positions: ["p1"] }))).toEqual({
      explained: { verdict: "differs", differences: [{ difference: "d1", cause: "c1" }], calibration: [{ difference: "p1", cause: "k1" }] }, moved: true, unexplained: [], gone: ["difference: d2\n      cause it had: c2"],
    });
  });

  test("a new difference: cause null, the exit 1 naming it, no cause written", () => {
    const root = tempDir("ets-sweep-rejudge-");
    const old: Explained = { verdict: "differs", differences: [{ difference: "d1", cause: "c1" }] };
    const now = entry(old, "differs", ["d1", "d3"], { positions: ["p2"] });
    const { report, exit } = writeRejudged(root, [now], olds(old), manifest(entry(old, "differs", ["d1"])), updateManifest(null, [now], [ID]));
    expect(exit).toBe(1);
    expect(JSON.parse(readFileSync(explainedAt(root), "utf8"))).toEqual({ verdict: "differs", differences: [{ difference: "d1", cause: "c1" }, { difference: "d3", cause: null }], calibration: [{ difference: "p2", cause: null }] });
    expect(report.slice(-3)).toEqual(["2 unexplained (a difference in explained.json, a verdict in notes.md):", `  ${ID}: difference: d3`, `  ${ID}: calibration: p2`]);
    expect(report).toEqual(expect.arrayContaining(["    difference new: d3", "    calibration position new: p2"]));
    // An empty cause explains nothing either, as the corpus test holds it.
    const blank: Explained = { verdict: "differs", differences: [{ difference: "d1", cause: " " }] };
    expect(rejudge(blank, entry(blank, "differs", ["d1"])).unexplained).toEqual(["difference: d1"]);
  });

  test("a refusal of another cause where the verdict stays: its detail written, the exit 1 naming it", () => {
    const root = tempDir("ets-sweep-rejudge-");
    const was = { run: "Busforge", refusals: ["sim-refused x"] }, now = { run: "Busforge", refusals: ["sim-refused y"] };
    const old: Explained = { verdict: "sim-refused", differences: [], detail: was };
    const m = entry(old, "sim-refused", [], { first: "sim-refused y", detail: now });
    expect(rejudge(old, m)).toEqual({ explained: { verdict: "sim-refused", differences: [], detail: now }, moved: true, unexplained: [`sim-refused: its detail moved: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`], gone: [] });
    const { exit } = writeRejudged(root, [m], olds(old), manifest(entry(old, "sim-refused", [], { first: "sim-refused x", detail: was })), updateManifest(null, [m], [ID]));
    expect([exit, JSON.parse(readFileSync(explainedAt(root), "utf8"))]).toEqual([1, { verdict: "sim-refused", differences: [], detail: now }]);
    // The same detail stays unwritten.
    expect(rejudge({ ...old, detail: now }, m).moved).toBe(false);
    // And notes.md hears of it.
    expect(movedSince(entry(old, "sim-refused", [], { first: "sim-refused y", detail: was }), m)).toEqual([`detail: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`]);
    expect(verdictDetail({ verdict: "sim-refused", run: "Busforge", refusals: ["sim-refused broadcast 0100 from 1.1.255 while the unit restarts (412 ms): whether it answers is not known"] })).toEqual({ run: "Busforge", refusals: ["sim-refused broadcast 0100 from 1.1.255 while the unit restarts (<n> ms): whether it answers is not known"] });
  });

  test("a verdict moved to a refusal or a failure: the exit 1, the dropped causes named", () => {
    const root = tempDir("ets-sweep-rejudge-");
    const old: Explained = { verdict: "differs", differences: [{ difference: "d1", cause: "c1" }] };
    const now = entry(old, "sim-refused", [], { first: "sim-refused 4282400001: outside an allocated segment" });
    const { report, exit } = writeRejudged(root, [now], olds(old), manifest(entry(old, "differs", ["d1"])), updateManifest(null, [now], [ID]));
    expect(exit).toBe(1);
    expect(JSON.parse(readFileSync(explainedAt(root), "utf8"))).toEqual({ verdict: "sim-refused", differences: [] });
    expect(report).toEqual(expect.arrayContaining([
      "  NOT EXPLAINED: verdict: differs -> sim-refused: sim-refused 4282400001: outside an allocated segment",
      "  gone: difference: d1\n      cause it had: c1",
    ]));
  });
});

// Busforge's current plan against every ETS row in the corpus. A row's explained.json names its verdict and
// every difference with its cause; a new difference fails, and so does an explained one that is gone.
// Where --rejudge and --keep may write: nothing here writes into the corpus, the alias lies in a test directory.
corpusDescribe("a rejudge's output outside the corpus", () => {
  test("a directory in the corpus is refused, also by a name that begins with two dots and behind a symlink", () => {
    const root = corpusRoot()!;
    expect([inCorpus(root), inCorpus(join(root, "captures", "new")), inCorpus(join(root, "..rejudge"))]).toEqual([true, true, true]);
    expect([inCorpus(join(root, "..", "elsewhere")), inCorpus(tempDir("ets-sweep-out-"))]).toEqual([false, false]);
    const alias = join(tempDir("ets-sweep-alias-"), "corpus");
    symlinkSync(root, alias);
    expect(inCorpus(join(alias, "new", "deeper"))).toBe(true);
  });
});

corpusDescribe("the ETS sweep rows", () => {
  const rows = listRows();
  test("the corpus holds rows", () => {
    expect(rows.length).toBeGreaterThan(0);
  });
  // The rows run side by side in worker threads (tools/ets-sweep-workers.ts), each test's row as the test runs. A row
  // waits for a worker as long as the rows before it take: its test's time is the row's own limit, which the pool
  // counts from when a worker takes it, for each round of rows before it.
  let pool: RowPool | undefined;
  afterAll(() => pool?.close());
  const waiting = ROW_TIMEOUT_MS * Math.ceil(rows.length / ROW_WORKERS) + 60_000;
  for (const id of rows) {
    test.concurrent(`${id}: Busforge's download into a fresh simulated unit has the verdict, the differences and a refusal's detail explained`, async () => {
      const row = readRow(id);
      const { verdict } = await (pool ??= new RowPool(ROW_WORKERS, { rowTimeoutMs: ROW_TIMEOUT_MS })).judge(id);
      expect(judged(verdict)).toEqual(expected(row.explained));
      expect(row.explained.differences.filter((d) => !d.cause?.trim()).map((d) => d.difference)).toEqual([]);
    }, waiting);
  }

  // A calibrated row: ETS's dialogue with the simulated unit against its dialogue with the real unit at the same
  // configuration, position by position; every position that differs is explained. An uncalibrated row explains none.
  for (const id of rows) {
    test(`${id}: ETS's frames into the simulated unit equal its frames into the real unit but for the explained positions`, () => {
      const row = readRow(id);
      if (row.spec.calibration === undefined) { expect(row.explained.calibration).toBeUndefined(); return; }
      const real = readFileSync(corpusPath(row.spec.calibration), "utf8");
      const found = dialogueDifferences(real, readFileSync(join(row.dir, ROW_FILES.ets), "utf8"), iaToNum(row.conf.ia), "ETS", row.spec.calibrationFrom);
      expect(found).toEqual((row.explained.calibration ?? []).map((d) => d.difference));
      expect((row.explained.calibration ?? []).filter((d) => !d.cause?.trim()).map((d) => d.difference)).toEqual([]);
    });
  }

  // The second check on an export the corpus holds without a password: the bench project, saved after ETS's
  // full download of the GVS AMMA (tools/ets-records.test.ts).
  test("Busforge's images against ETS's LoadedImage of a device in an export", () => {
    const bytes = readFileSync(corpusPath("captures/bench-ets-project-params-edited-after-download.knxproj"));
    const project = loadKnxproj(bytes, undefined, "bench");
    const amma = project.devices.find((d) => d.appProgramId === "M-0085_A-0072-30-69AA")!;
    const appXml = readAppProgram(bytes, amma.appRef)!;
    const c = deviceConfiguration(parseAppConfig(appXml), deviceRows(project, amma.id));
    const conf: RowConfiguration = { ia: amma.ia, params: [...c.params], links: c.links, moduleInstances: c.instances, comObjectOverrides: [...c.comObjectOverrides] };
    // Whether the unit held the application, from the capture of that download.
    const held = capturedOnLoadedUnit(parseCapture(captureText("gvs-amma-ets-fulldownload-defaults.log"), iaToNum(amma.ia)));
    expect(loadedImageCheck(project, appXml, conf, held)).toEqual({ state: "equal", bytes: 3882 });
    expect(loadedImageCheck(project, appXml, { ...conf, ia: "15.15.250" }, held)).toEqual({ state: "not compared", why: "the export holds no device 15.15.250" });
  });
});

// A row's driver checks (`checks/<name>/` in the row, tools/ets-driver.ts): ETS's runs the driver was made to repeat
// or to fail (the simulator stopped mid-download, another interface, a wrong identity), each with the outcome its
// real ETS6.log must give (expected.json), the dialogue a repeat must share with the row's, and the mismatch lines
// ETS logged where it refused the identity.
interface CheckExpectation { outcome: EtsOutcome; dialogueAsRow?: boolean; mismatches?: [string, string, string][] }
corpusDescribe("the driver's checks of a row against ETS's real logs", () => {
  for (const id of listRows()) {
    const dir = corpusPath(`${SWEEP_DIR}/${id}/checks`);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      test(`${id}, ${name}: ETS6.log gives the expected outcome`, () => {
        const row = readRow(id);
        const at = (f: string) => join(dir, name, f);
        const want = JSON.parse(readFileSync(at("expected.json"), "utf8")) as CheckExpectation;
        const check = JSON.parse(readFileSync(at(ROW_FILES.row), "utf8")) as RowSpec;
        const log = readFileSync(at(ROW_FILES.ets6log));
        expect(etsOutcome(log.toString("latin1"), row.conf.ia, check.simulator)).toEqual(want.outcome);
        if (want.dialogueAsRow) expect(dialogueDifferences(readFileSync(join(row.dir, ROW_FILES.ets), "utf8"), readFileSync(at(ROW_FILES.ets), "utf8"), iaToNum(row.conf.ia))).toEqual([]);
        expect(mismatchLines(log).map((m) => [`${m.object}/${m.pid}`, m.device.toString("hex"), m.required.toString("hex")])).toEqual(want.mismatches ?? []);
      });
    }
  }
});
