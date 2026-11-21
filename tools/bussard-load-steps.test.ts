import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { KnxDevice, iaToNum, runLoadPlan, type LoadPlan } from "../packages/knx/src/index.ts";
import { parseAppConfig, parseLoadProcedures, classify, initialValues, absoluteFullStepRefusal, isMemoryMappedLsm } from "../packages/product/src/index.ts";
import { BUSSARD_LOAD_STEP_PRODUCTS, BUSSARD_SYNTHETIC_TESTED, bussardApplication, bussardCapture, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { DownloadSim, captureFrames, type DownloadFrame, type DownloadSimOpts, type SimProperty } from "./download-sim.ts";
import { memoryImage, parseCapture } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";

// bussard's ETS 6.4.1 full downloads (MIT, Tom Bocklisch; the corpus's captures/external/bussard-synthetic/README.md)
// of products whose load procedures declare a step ETS runs and Busforge refused before: a pause (LdCtrlDelay), a
// master reset (LdCtrlMasterReset), the task pointers (LdCtrlTaskPtr, LdCtrlTaskCtrl2), a property write inside a
// load bracket (LdCtrlWriteProp), a RAM segment only the procedure declares. Busforge's full download of each runs
// against a unit that answers as the device simulator in the capture answered ETS (download-sim.ts), and the frames
// it sends are held to ETS's. They show what ETS sends, never what a device does with it.

const DEVICE = iaToNum("1.1.1");
const application = (product: string) => {
  const entry = [...BUSSARD_LOAD_STEP_PRODUCTS, ...BUSSARD_SYNTHETIC_TESTED].find(([p]) => p === product);
  if (!entry) throw new Error(`${product} is in neither list of tested products`);
  return readFileSync(corpusPath(bussardApplication(product, entry[1])), "utf8");
};
const pcap = (product: string) => readFileSync(corpusPath(bussardCapture(product, "defaults")));
const etsFrames = (product: string) => captureFrames(pcap(product), DEVICE);

// What the simulator in the captures answered to the maximum APDU length (PID 56): 66 on MV-07B0, 15 on MV-0705, no
// such property on MV-0701; and the description of the property syn-s7-pid204 writes (object 3 PID 204: writable,
// PDT_GENERIC_05, two elements, access 0x30, at property index 5).
const MAX_APDU: Record<string, string> = { "MV-07B0": "0042", "MV-0705": "000f" };
const PID204: SimProperty = { elements: Buffer.alloc(0), description: { index: 5, type: 0x95, maxElements: 2, access: 0x30 } };

// Busforge's full download of `product` at the application's defaults, run against the simulated unit up to `until`
// (the plan's index; default: its closing restart, which the simulator does not take).
async function download(xml: string, opts: { until?: (plan: LoadPlan) => number; sim?: Partial<DownloadSimOpts> } = {}) {
  const cfg = parseAppConfig(xml);
  const mm = isMemoryMappedLsm(cfg.mask);
  const { plan } = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params: initialValues(cfg, "de-DE"), links: [], proc: parseLoadProcedures(xml), unitHoldsApplication: false });
  const props = new Map<string, SimProperty>([["3:204", PID204], ...(MAX_APDU[cfg.mask] ? [["0:56", { elements: Buffer.from(MAX_APDU[cfg.mask], "hex") }] as const] : [])]);
  const sim = new DownloadSim({ mask: cfg.mask.slice(3), memoryMappedLsms: mm, echoMemoryWrites: cfg.mask === "MV-07B0", properties: props, ...opts.sim });
  // The pause before the new connection after a master reset is ETS's second; its frames do not depend on it.
  const dev = new KnxDevice(sim, "1.1.1", undefined, { masterResetGapMs: 10 });
  dev.setExtendedMemoryServices(false);
  await dev.connect();
  const until = opts.until ? opts.until(plan) : plan.findLastIndex((s) => s.op === "restart");
  if (!opts.until) expect(until).toBe(plan.length - 1);
  await runLoadPlan(dev, plan.slice(0, until), { memMappedLsms: mm, readCompare: mm });
  expect(sim.refused).toEqual([]);
  return { cfg, plan, sim };
}

// The frames that drive the download, ETS's and Busforge's alike: the load controls (PID 5 writes, the 0x0104
// control), every other property write (the device control's, verify mode, included) and description read,
// A_Restart, T_Connect and T_Disconnect. Left out: reads and data writes (the memory images are compared on their
// own).
const controls = (frames: DownloadFrame[]): string[] => frames.filter((f) => f.from === "tool"
  && /^(connect|disconnect|028b0104|03d7|03d8|038)/.test(f.tpdu)).map((f) => f.tpdu);
// Every frame, both ways, from the first `from` frame to the first `to` frame after it (exclusive).
const window = (frames: DownloadFrame[], from: string, to: (f: DownloadFrame) => boolean): string[] => {
  const at = frames.findIndex((f) => f.from === "tool" && f.tpdu === from);
  if (at < 0) throw new Error(`no frame ${from}`);
  const end = frames.findIndex((f, i) => i > at && to(f));
  return frames.slice(at, end < 0 ? undefined : end).map((f) => `${f.from === "tool" ? ">" : "<"} ${f.tpdu}`);
};
const sortedMemory = (m: Map<number, number>) => [...m].sort((a, b) => a[0] - b[0]);
// The memory ETS wrote, without the 0x0104 load control of a memory-mapped mask.
const etsMemory = (product: string) => new Map([...memoryImage(parseCapture(pcapToLog(pcap(product)), DEVICE).writes)].filter(([a]) => a < 0x0104 || a > 0x010e));

corpusDescribe("bussard's synthetic captures: the System 7 load steps ETS runs, run by Busforge's full download", () => {
  for (const [product] of BUSSARD_LOAD_STEP_PRODUCTS) {
    test(`${product}: offered, and every load control and every byte as ETS sent them`, async () => {
      const xml = application(product);
      expect(classify(parseAppConfig(xml)).operationRefusals().fullDownload).toBeUndefined();
      const { sim } = await download(xml);
      const ets = etsFrames(product);
      // ETS closes with A_Restart and T_Disconnect: the restart the plan closes with, which the simulator does not take.
      expect(controls(ets).slice(-2)).toEqual(["0380", "disconnect"]);
      expect(controls(sim.frames)).toEqual(controls(ets).slice(0, -2));
      expect(sortedMemory(sim.memory)).toEqual(sortedMemory(etsMemory(product)));
    });
  }

  // LdCtrlDelay MilliSeconds="200" between LSM 3's LoadCompleted and the restart: nothing on the wire, 211 ms between
  // the last frame and A_Restart, where the same procedure without it (syn-s7-0701) takes a few milliseconds.
  test("syn-s7-delay: a pause before the restart, nothing on the wire", async () => {
    const gap = (product: string) => {
      const f = etsFrames(product), r = f.findIndex((x) => x.tpdu === "0380");
      return f[r].at! - f[r - 1].at!;
    };
    expect(gap("syn-s7-delay")).toBeGreaterThanOrEqual(200);
    expect(gap("syn-s7-delay")).toBeLessThan(300);
    expect(gap("syn-s7-0701")).toBeLessThan(50);
    const { plan } = await download(application("syn-s7-delay"));
    expect(plan.slice(-3).map((s) => s.op)).toEqual(["loadCompleted", "settle", "restart"]);
    expect(plan.at(-2)).toEqual({ op: "settle", ms: 200 });
  });

  test("syn-s7-taskptr: LdCtrlTaskPtr and LdCtrlTaskCtrl2 on PID 5 of LSM 3, in declared order", async () => {
    const lsm3 = (frames: DownloadFrame[]) => frames.filter((f) => f.from === "tool" && f.tpdu.startsWith("03d703051001030")).map((f) => f.tpdu.slice(12));
    const ets = lsm3(etsFrames("syn-s7-taskptr"));
    // AbsSegment RAM, stack, 0x4400, 0x4440; TaskSegment; TaskPtr; TaskCtrl1; TaskCtrl2.
    expect(ets.slice(-4)).toEqual(["030244000000fa281110", "03034410441444180000", "03044430010000000000", "0305441c440007004440"]);
    expect(lsm3((await download(application("syn-s7-taskptr"))).sim.frames)).toEqual(ets);
  });

  // LdCtrlWriteProp ObjIdx 3 PropId 204 Count 2 inside LSM 3's load: ETS reads the property's description, then
  // writes both 5-octet elements in one request, after the parameter segment's writes and before TaskSegment 3.
  test("syn-s7-pid204: the description read, then the two elements, where the procedure declares them", async () => {
    const step = (frames: DownloadFrame[]) => window(frames, "03d803cc00", (f) => f.from === "tool" && f.tpdu.startsWith("028b0104"));
    const ets = step(etsFrames("syn-s7-pid204"));
    expect(ets).toEqual(["> 03d803cc00", "< 03d903cc0595000230", "> 03d703cc200100004440000000448000", "< 03d603cc200100004440000000448000"]);
    expect(step((await download(application("syn-s7-pid204"))).sim.frames)).toEqual(ets);
  });

  // LdCtrlMasterReset EraseCode 6, then 5, right after the connect: each the confirmed A_Restart with the erase code,
  // answered error 0; T_Disconnect; a new connection, the descriptor and PID 56; no authorization again.
  test("syn-s7-master-reset: each master reset and the new connection after it", async () => {
    const ets = etsFrames("syn-s7-master-reset"), { sim } = await download(application("syn-s7-master-reset"));
    for (const code of ["06", "05"]) {
      const reset = (frames: DownloadFrame[]) => window(frames, `0381${code}00`, (f) => f.from === "tool" && /^(0381|028b0104)/.test(f.tpdu) && f.tpdu !== `0381${code}00`);
      expect(reset(ets)).toEqual([`> 0381${code}00`, "< 03a1000000", "> disconnect", "> connect", "> 0300", "< 03400701", "> 03d500381001", "< 03d600380001"]);
      expect(reset(sim.frames)).toEqual(reset(ets));
    }
  });

  // syn-s7-0705 declares, inside LSM 3's load, a stack segment (SegType 1) in RAM that no segment of the application
  // defines: ETS declares it and neither writes nor reads it.
  test("syn-s7-0705: the RAM segment only the procedure declares is declared, nothing written to it", async () => {
    const decl = "03d70305100103010710003000020000";
    expect(controls(etsFrames("syn-s7-0705"))).toContain(decl);
    const { sim } = await download(application("syn-s7-0705"));
    expect(controls(sim.frames)).toContain(decl);
    expect(sim.frames.some((f) => /^02..07[1-3]/.test(f.tpdu))).toBe(false);
  });
});

corpusDescribe("bussard's synthetic captures: a master reset in a System B full download", () => {
  // MergeId 2: LdCtrlRelSegment LSM 4, then LdCtrlMasterReset EraseCode 1 (syn-master-reset) or 4 (-code4), no
  // AppliesTo. ETS sends it right after the parameter segment's allocation, before the tables' brackets, and
  // goes on on a new connection without allocating LSM 4 again.
  for (const [product, code] of [["syn-master-reset", "01"], ["syn-master-reset-code4", "04"]] as const) {
    test(`${product}: the full download is offered and sends it where ETS does; the parameter download stays refused`, async () => {
      const xml = application(product);
      const refused = classify(parseAppConfig(xml)).operationRefusals();
      expect(refused.fullDownload).toBeUndefined();
      expect(refused.flashParams).toEqual(expect.objectContaining({ code: "LOAD_STEP_UNSUPPORTED", message: expect.stringContaining("LdCtrlMasterReset") }));
      // Up to the first write: the brackets, the allocations and the master reset.
      const { sim } = await download(xml, { until: (plan) => plan.findIndex((s) => s.op === "writeSegment") });
      const ets = etsFrames(product);
      const fromAlloc = (frames: DownloadFrame[]) => {
        const c = controls(frames), at = c.findIndex((x) => x.startsWith("03d704051001030b"));
        return c.slice(at, c.indexOf("03d70305100101000000000000000000", at) + 1);
      };
      expect(fromAlloc(ets)).toEqual(["03d704051001030b0000010000000000", `0381${code}00`, "disconnect", "connect", "03d70305100101000000000000000000"]);
      expect(fromAlloc(sim.frames)).toEqual(fromAlloc(ets));
      const reset = (frames: DownloadFrame[]) => window(frames, `0381${code}00`, (f) => f.from === "tool" && f.tpdu.startsWith("03d7"));
      expect(reset(ets)).toEqual([`> 0381${code}00`, "< 03a1000000", "> disconnect", "> connect", "> 0300", "< 034007b0", "> 03d500381001", "< 03d6003810010042"]);
      // Verify mode follows the reset, right before the first memory write, in both.
      expect(reset(sim.frames)).toEqual(reset(ets));
    });
  }
});

corpusDescribe("bussard's synthetic captures: a load step where no capture shows it is refused", () => {
  const swap = (xml: string, from: string, to: string) => {
    expect(xml.split(from)).toHaveLength(2);
    return xml.replace(from, to);
  };
  const fullRefusal = (xml: string) => classify(parseAppConfig(xml)).operationRefusals().fullDownload;
  const declaredStep = (xml: string, memoryMapped: boolean) => absoluteFullStepRefusal(parseLoadProcedures(xml), "declared", memoryMapped);

  test("a master reset on a property-mapped mask, or after a load-state event", () => {
    const xml = application("syn-s7-master-reset");
    expect(declaredStep(xml, false)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("property-mapped") }));
    const late = swap(swap(xml, `<LdCtrlMasterReset EraseCode="5" ChannelNumber="0" />`, ""), `<LdCtrlUnload LsmIdx="3" />`, `<LdCtrlUnload LsmIdx="3" />\n<LdCtrlMasterReset EraseCode="5" ChannelNumber="0" />`);
    expect(fullRefusal(late)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("follows a load-state event") }));
    // A factory reset or an address reset, after which the unit no longer answers at its address, and another channel.
    for (const attrs of [`EraseCode="2" ChannelNumber="0"`, `EraseCode="3" ChannelNumber="0"`, `EraseCode="5" ChannelNumber="7"`, `EraseCode="5"`]) {
      const other = swap(xml, `<LdCtrlMasterReset EraseCode="5" ChannelNumber="0" />`, `<LdCtrlMasterReset ${attrs} />`);
      expect(fullRefusal(other)?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    }
  });

  test("a pause elsewhere than between the last LoadCompleted and the restart, or one as long as the connection timeout", () => {
    const xml = application("syn-s7-delay");
    const step = `<LdCtrlDelay MilliSeconds="200" />`;
    const early = swap(swap(xml, step, ""), `<LdCtrlLoad LsmIdx="1" />`, `${step}\n<LdCtrlLoad LsmIdx="1" />`);
    expect(fullRefusal(early)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("between the last LoadCompleted and the restart") }));
    expect(fullRefusal(swap(xml, step, `<LdCtrlDelay MilliSeconds="6000" />`))).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("connection timeout") }));
  });

  test("the task pointers on a memory-mapped mask, or outside their load bracket", () => {
    const xml = application("syn-s7-taskptr");
    expect(declaredStep(xml, true)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("memory-mapped") }));
    const step = `<LdCtrlTaskPtr LsmIdx="3" InitPtr="17424" SavePtr="17428" SerialPtr="17432" />`;
    const outside = swap(swap(xml, step, ""), `<LdCtrlLoad LsmIdx="3" />`, `${step}\n<LdCtrlLoad LsmIdx="3" />`);
    expect(fullRefusal(outside)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("outside its load-state machine's load bracket") }));
  });

  test("a property write inside another bracket, without inline data, or on a property-mapped mask", () => {
    const xml = application("syn-s7-pid204");
    const step = `<LdCtrlWriteProp ObjIdx="3" PropId="204" Count="2" Verify="false" InlineData="00004440000000448000" />`;
    const inLsm1 = swap(swap(xml, step, ""), `<LdCtrlTaskSegment LsmIdx="1" Address="16384" />`, `${step}\n<LdCtrlTaskSegment LsmIdx="1" Address="16384" />`);
    expect(fullRefusal(inLsm1)?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    expect(fullRefusal(swap(xml, ` InlineData="00004440000000448000"`, ""))).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("no InlineData") }));
    expect(declaredStep(xml, false)?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    // Another object than the bracket's, or a property the download drives itself.
    expect(fullRefusal(swap(xml, `ObjIdx="3" PropId="204"`, `ObjIdx="4" PropId="204"`))?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    expect(fullRefusal(swap(xml, `ObjIdx="3" PropId="204"`, `ObjIdx="3" PropId="27"`))?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    // A parameter placed in a property, which such a write would carry.
    const placed = swap(xml, `<Memory CodeSegment="M-00FA_A-2821-11-0000_AS-4440" Offset="0" BitOffset="0" />`, `<Property ObjectIndex="3" PropertyId="204" Offset="0" BitOffset="0" />`);
    expect(fullRefusal(placed)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("placed in a property") }));
  });

  // A write the route cannot carry is refused before the first unload, as every whole request of a plan is.
  test("a property write too long for a route through a coupler is refused before anything is sent", async () => {
    const sent: string[] = [];
    const dev = {
      assertFitsRoute: (n: number) => { if (n > 15) throw Object.assign(new Error("long frame"), { code: "COUPLER_ROUTE_LONG_FRAME" }); },
      writesConfirmed: async () => { sent.push("asked"); return false; },
      propWrite: async () => { sent.push("propWrite"); return Buffer.alloc(1); },
    } as unknown as KnxDevice;
    const plan: LoadPlan = [{ op: "unload", lsm: 1 }, { op: "declaredWriteProp", obj: 3, pid: 204, start: 1, count: 3, data: Buffer.alloc(15), verify: false }];
    expect(await runLoadPlan(dev, plan).then(() => null, (e: unknown) => e)).toEqual(expect.objectContaining({ code: "COUPLER_ROUTE_LONG_FRAME" }));
    expect(sent).toEqual([]);
  });

  test("a segment only the procedure declares that is not RAM, or a RAM one in an application asking for ETS's partial form", () => {
    const xml = application("syn-s7-0705");
    const rom = swap(xml, `SegType="1" Address="1808" Size="48" Access="0" MemType="2"`, `SegType="1" Address="1808" Size="48" Access="0" MemType="3"`);
    expect(fullRefusal(rom)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("at 1808") }));
    const partial = xml.includes("<Options ") ? swap(xml, "<Options ", `<Options PreferPartialDownloadIfApplicationLoaded="true" `) : swap(xml, "<Static>", `<Static>\n<Options PreferPartialDownloadIfApplicationLoaded="true" />`);
    expect(parseLoadProcedures(partial).preferPartialIfLoaded).toBe(true);
    expect(fullRefusal(partial)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("partial form") }));
  });

  test("a System B master reset anywhere but right after the parameter segment's allocation, or with the partial form", () => {
    const xml = application("syn-master-reset");
    const step = `<LdCtrlMasterReset EraseCode="1" ChannelNumber="0" />`;
    const later = swap(swap(xml, step, ""), `<LdCtrlWriteRelMem`, `${step}\n<LdCtrlWriteRelMem`);
    expect(fullRefusal(later)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("right after the parameter segment's allocation") }));
    const partial = swap(xml, "<Options ", `<Options PreferPartialDownloadIfApplicationLoaded="true" `);
    expect(fullRefusal(partial)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("partial form") }));
    expect(fullRefusal(swap(xml, step, `<LdCtrlMasterReset EraseCode="2" ChannelNumber="0" />`))?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    const secure = swap(xml, `<ApplicationProgram `, `<ApplicationProgram IsSecureEnabled="true" `);
    expect(fullRefusal(secure)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("Data Secure") }));
  });

  test("a master reset the unit refuses, does not answer, answers with a process time or comes back from with another mask, and a property it does not describe as the step writes it", async () => {
    const reset = application("syn-s7-master-reset");
    const failure = (run: Promise<unknown>) => run.then(() => null, (e: unknown) => e);
    expect(await failure(download(reset, { sim: { masterResetAnswer: Buffer.from([1, 0, 0]) } }))).toEqual(expect.objectContaining({ code: "RESTART_REFUSED" }));
    expect(await failure(download(reset, { sim: { masterResetAnswer: null } }))).toEqual(expect.objectContaining({ code: "DEVICE_NOT_ANSWERING" }));
    expect(await failure(download(reset, { sim: { masterResetAnswer: Buffer.from([0, 0, 2]) } }))).toEqual(expect.objectContaining({ code: "RESTART_REFUSED", message: expect.stringContaining("process time") }));
    expect(await failure(download(reset, { sim: { maskAfterMasterReset: "0705" } }))).toEqual(expect.objectContaining({ code: "MASK_MISMATCH" }));
    for (const description of [{ index: 5, type: 0x94, maxElements: 2, access: 0x30 }, { index: 5, type: 0x15, maxElements: 2, access: 0x30 }]) {
      const props = new Map([["3:204", { elements: Buffer.alloc(0), description }]]);
      expect(await failure(download(application("syn-s7-pid204"), { sim: { properties: props } }))).toEqual(expect.objectContaining({ code: "PROPERTY_WRITE_REFUSED" }));
    }
  });
});
