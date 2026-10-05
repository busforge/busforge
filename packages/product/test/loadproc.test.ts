import { test, expect } from "bun:test";
import { listRealFixtures, readRealFixture } from "./real-catalogue.snapshot.ts";
import { corpusTest } from "../../../tools/corpus-test.ts";
import { parseLoadProcedures, flattenSteps, stepApplies, assessParStep, assessParCoverage, relParamFillByte, declaredMcbWrites, KNOWN_LD_VERBS, type LdStep } from "../src/loadproc.ts";
import { parseAppConfig } from "../src/appconfig.ts";
import { maskInfo } from "../src/masks.ts";

// Generality proof: parse the load procedure of EVERY real catalogue app program and
// assert the parser covers the full LdCtrl vocabulary present in the data, with no
// unknown verb slipping through (which would mean a device we cannot flash blind).

corpusTest("every real catalogue load procedure parses with a recognized style", () => {
  for (const f of listRealFixtures()) {
    const lp = parseLoadProcedures(readRealFixture(f));
    expect(["ProductProcedure", "MergedProcedure", "DefaultProcedure"]).toContain(lp.style);
    // Self-contained / merged styles must yield steps; DefaultProcedure carries none.
    if (lp.style === "DefaultProcedure") expect(lp.blocks.flatMap((b) => b.steps).length).toBe(0);
    else expect(lp.blocks.flatMap((b) => b.steps).length).toBeGreaterThan(0);
  }
});

corpusTest("no unknown LdCtrl verb appears across the whole real catalogue", () => {
  const allVerbs = new Set<string>();
  const allUnknown = new Set<string>();
  for (const f of listRealFixtures()) {
    const lp = parseLoadProcedures(readRealFixture(f));
    for (const v of lp.verbs) allVerbs.add(v);
    for (const v of lp.unknown) allUnknown.add(v);
  }
  // The full vocabulary the executor must cover is exactly what we declared as known.
  expect([...allUnknown].sort()).toEqual([]);
  for (const v of allVerbs) expect(KNOWN_LD_VERBS.has(v)).toBe(true);
  // And we actually exercise a meaningful slice of the vocabulary (guards a parser that
  // silently produces nothing). The catalogue spans both segment models + properties.
  for (const expected of ["LdCtrlAbsSegment", "LdCtrlRelSegment", "LdCtrlLoad", "LdCtrlLoadCompleted", "LdCtrlLoadImageProp", "LdCtrlWriteProp", "LdCtrlCompareProp", "LdCtrlRestart"]) {
    expect(allVerbs.has(expected)).toBe(true);
  }
});

corpusTest("ProductProcedure is a single self-contained block (M-0081, the proven device)", () => {
  const lp = parseLoadProcedures(readRealFixture("M-0081_A-FE01-11-75D9.xml.gz"));
  expect(lp.style).toBe("ProductProcedure");
  expect(lp.blocks.length).toBe(1);
  const verbs = lp.blocks[0].steps.map((s) => s.verb);
  expect(verbs[0]).toBe("LdCtrlConnect");
  expect(verbs).toContain("LdCtrlLoad");
  expect(verbs).toContain("LdCtrlAbsSegment");
  expect(verbs).toContain("LdCtrlLoadCompleted");
  expect(verbs).toContain("LdCtrlRestart");
  // our proven param segment AS-4200 (@16896) is declared as an LSM3 abs segment
  const abs = lp.blocks[0].steps.filter((s) => s.verb === "LdCtrlAbsSegment");
  expect(abs.some((s) => s.attrs.Address === "16896" && s.attrs.LsmIdx === "3")).toBe(true);
});

corpusTest("DefaultProcedure (legacy) is recorded as an explicit gap, not a crash", () => {
  const lp = parseLoadProcedures(readRealFixture("M-0083_A-0138-21-F18E-O0072.xml.gz"));
  expect(lp.style).toBe("DefaultProcedure");
  expect(lp.blocks).toEqual([]);
});

corpusTest("MergedProcedure operation selection (par vs full) picks different fragments", () => {
  const lp = parseLoadProcedures(readRealFixture("M-0162_A-0004-11-F245.xml.gz")); // PSU, relative
  expect(lp.style).toBe("MergedProcedure");
  const par = flattenSteps(lp, "par");
  const full = flattenSteps(lp, "full");
  // both downloads write the relative memory image
  expect(par.some((s) => s.verb === "LdCtrlWriteRelMem")).toBe(true);
  expect(full.some((s) => s.verb === "LdCtrlWriteRelMem")).toBe(true);
  // but the RelSegment allocate differs by AppliesTo
  expect(par.find((s) => s.verb === "LdCtrlRelSegment")?.attrs.AppliesTo).toBe("par");
  expect(full.find((s) => s.verb === "LdCtrlRelSegment")?.attrs.AppliesTo).toBe("full");
  // a "full,par" step applies to both; a step's filter is honored
  const both = { verb: "LdCtrlWriteRelMem", attrs: { AppliesTo: "full,par" } };
  expect(stepApplies(both, "par")).toBe(true);
  expect(stepApplies(both, "full")).toBe(true);
  expect(stepApplies({ verb: "X", attrs: { AppliesTo: "full" } }, "par")).toBe(false);
  expect(stepApplies({ verb: "X", attrs: {} }, "par")).toBe(true);
});

// ---- par-download step policy ----
// Every par-applicable step must carry an explicit disposition; anything unmodeled blocks
// the flash. This is the runtime guard behind LOAD_STEP_UNSUPPORTED.

const step = (verb: string, attrs: Record<string, string> = {}): LdStep => ({ verb, attrs });

// A minimal MergedProcedure whose full-download RelSegment for LSM 4 declares a given fill.
const procXml = (fillAttr: string) =>
  `<KNX><ManufacturerData><Manufacturer><ApplicationPrograms>` +
  `<ApplicationProgram LoadProcedureStyle="MergedProcedure"><Static><LoadProcedures>` +
  `<LoadProcedure MergeId="2"><LdCtrlRelSegment LsmIdx="4" Mode="0"${fillAttr} AppliesTo="full"/></LoadProcedure>` +
  `</LoadProcedures></Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("relParamFillByte reads the LSM-4 fill the full download must honor", () => {
  expect(relParamFillByte(parseLoadProcedures(procXml(` Fill="255"`)))).toBe(0xff);
  expect(relParamFillByte(parseLoadProcedures(procXml(` Fill="0"`)))).toBe(0);
  // No Fill attribute, and no relative allocation at all, both fall back to 0 (the historical value).
  expect(relParamFillByte(parseLoadProcedures(procXml("")))).toBe(0);
  expect(relParamFillByte(parseLoadProcedures("<KNX></KNX>"))).toBe(0);
});

test("the segment fill value is accepted (0 and 255), not blocked: the full download honors it", () => {
  // Fill=0 (zero the segment) always worked. Fill=255 (0xFF, erased-flash) is what the GVS AMMA
  // declares, and used to block the whole download; it is now executed, with the byte threaded into
  // the allocation and the sparse image write (relParamFillByte + planSystemBFullDownload).
  expect(assessParStep(step("LdCtrlRelSegment", { LsmIdx: "4", Mode: "0", Fill: "0" }), "relative").kind).toBe("executed");
  expect(assessParStep(step("LdCtrlRelSegment", { LsmIdx: "4", Mode: "0", Fill: "255" }), "relative").kind).toBe("executed");
});

test("par policy: unknown verbs and unmodeled steps block, never silently vanish", () => {
  expect(assessParStep(step("LdCtrlMadeUpVerb"), "absolute").kind).toBe("blocked");
  expect(assessParStep(step("LdCtrlMadeUpVerb"), "relative").kind).toBe("blocked");
  // MCB/load-image stamps: no hardware evidence on absolute devices -> blocked
  expect(assessParStep(step("LdCtrlLoadImageProp", { ObjIdx: "1", PropId: "27" }), "absolute").kind).toBe("blocked");
  // arbitrary property write (side effect unknown) blocks even on relative
  expect(assessParStep(step("LdCtrlWriteProp", { ObjIdx: "4", PropId: "5", InlineData: "01" }), "relative").kind).toBe("blocked");
  // wrong-model steps block
  expect(assessParStep(step("LdCtrlRelSegment", { LsmIdx: "4" }), "absolute").kind).toBe("blocked");
  expect(assessParStep(step("LdCtrlAbsSegment", { Address: "16896" }), "relative").kind).toBe("blocked");
  // a non-default allocation MODE is still unmodeled and blocks (the fill VALUE, by contrast, is
  // now honored end to end — see the separate test below)
  expect(assessParStep(step("LdCtrlRelSegment", { LsmIdx: "4", Mode: "1" }), "relative").kind).toBe("blocked");
  // CompareProp without inline data or with element addressing cannot be executed
  expect(assessParStep(step("LdCtrlCompareProp", { ObjIdx: "0", PropId: "78" }), "absolute").kind).toBe("blocked");
  expect(assessParStep(step("LdCtrlCompareProp", { ObjIdx: "0", PropId: "78", InlineData: "00", StartElement: "2" }), "absolute").kind).toBe("blocked");
  // malformed hex would silently truncate in Buffer.from(_, "hex") -> must block, not compare short
  expect(assessParStep(step("LdCtrlCompareProp", { ObjIdx: "0", PropId: "78", InlineData: "0000000002AAXY" }), "absolute").kind).toBe("blocked");
  expect(assessParStep(step("LdCtrlCompareProp", { ObjIdx: "0", PropId: "78", InlineData: "0000000002AA0" }), "absolute").kind).toBe("blocked");
  // the System B base bracket only drives object/LSM 4; steps on any other object would
  // be claimed "executed" while the flash never touches them -> must block
  expect(assessParStep(step("LdCtrlRelSegment", { LsmIdx: "5", Mode: "0" }), "relative").kind).toBe("blocked");
  expect(assessParStep(step("LdCtrlWriteRelMem", { ObjIdx: "5", Size: "100" }), "relative").kind).toBe("blocked");
  expect(assessParStep(step("LdCtrlLoad", { LsmIdx: "5" }), "relative").kind).toBe("blocked");
});

test("par policy: documented skips and executed steps", () => {
  // absolute: full-download bookkeeping is a justified skip (hw-evidenced M-0081)
  for (const v of ["LdCtrlUnload", "LdCtrlTaskSegment", "LdCtrlTaskCtrl1"]) {
    expect(assessParStep(step(v, { LsmIdx: "1" }), "absolute").kind).toBe("skipped");
  }
  // relative: the declared MCB regions are written after the par allocation too (declaredMcbWrites);
  // the image CRC is never sent by ETS
  expect(assessParStep(step("LdCtrlLoadImageProp", { ObjIdx: "4", PropId: "27" }), "relative").kind).toBe("skipped");
  expect(assessParStep(step("LdCtrlWriteProp", { ObjIdx: "4", PropId: "27", InlineData: "0000066A003200000000" }), "relative").kind).toBe("executed");
  expect(assessParStep(step("LdCtrlWriteProp", { ObjIdx: "4", PropId: "27", InlineData: "0000066A003200000001" }), "relative").kind).toBe("blocked");
  // the surgical write supersedes the declared bulk write
  expect(assessParStep(step("LdCtrlWriteAbsMem", { Address: "16896", Size: "4" }), "absolute").kind).toBe("executed");
  expect(assessParStep(step("LdCtrlWriteRelMem", { ObjIdx: "4", Size: "212" }), "relative").kind).toBe("executed");
  // session lifecycle is the caller's
  expect(assessParStep(step("LdCtrlConnect"), "absolute").kind).toBe("caller");
  expect(assessParStep(step("LdCtrlDisconnect"), "relative").kind).toBe("caller");
});

corpusTest("par policy: CompareProp becomes an executable pre-flight check", () => {
  const lp = parseLoadProcedures(readRealFixture("M-0083_A-00B4-32-3919.xml.gz"));
  const cov = assessParCoverage(lp, "absolute");
  expect(cov.blocked).toEqual([]);
  expect(cov.checks).toEqual([{ obj: 0, pid: 78, expect: Buffer.from("0000000002AA00000000", "hex") }]);
});

corpusTest("par policy over the whole real catalogue: M-0008 blocks (absolute LoadImageProp), everything else is fully dispositioned", () => {
  for (const f of listRealFixtures()) {
    const xml = readRealFixture(f);
    const model = maskInfo(parseAppConfig(xml).mask).memoryModel;
    if (model !== "absolute" && model !== "relative") continue;
    const cov = assessParCoverage(parseLoadProcedures(xml), model);
    if (f.startsWith("M-0008_")) {
      // the one honest gap: an absolute device demanding MCB/load-image stamps we cannot
      // compute yet. It must REFUSE (was: silently partial recipe reported as success).
      expect(cov.blocked.map((b) => b.verb)).toEqual(["LdCtrlLoadImageProp", "LdCtrlLoadImageProp", "LdCtrlLoadImageProp"]);
    } else {
      expect(cov.blocked).toEqual([]);
    }
    // no step may fall through without a disposition: blocked+skipped+checks+executed
    // is total by construction; this pins that the corpus stays fully assessed.
  }
});

corpusTest("the declared MCB entries of a System B full download, as ETS sends them", () => {
  // Theben MIX: two entries for the 2003-byte parameter segment. ETS sends the first 8 bytes of the
  // 10-byte InlineData (Jung 400021SE capture, 2026-09-25). Declared Verify="false": only the region
  // size has to come back in the echo.
  const lp = parseLoadProcedures(readRealFixture("M-0048_A-493B-21-B471.xml.gz"));
  expect(declaredMcbWrites(lp, 2003)).toEqual([
    { obj: 4, element: 1, data: Buffer.from("0000066A00320000", "hex"), echoPrefix: 4 },
    { obj: 4, element: 2, data: Buffer.from("0000016900320000", "hex"), echoPrefix: 4 },
  ]);
  expect(declaredMcbWrites(lp, 2003, "par")).toEqual(declaredMcbWrites(lp, 2003));
  expect(declaredMcbWrites(parseLoadProcedures(readRealFixture("M-0162_A-0004-11-F245.xml.gz")), 212)).toEqual([]);
});

corpusTest("declared MCB entries that cannot be written faithfully are refused, not adapted", () => {
  const lp = parseLoadProcedures(readRealFixture("M-0048_A-493B-21-B471.xml.gz"));
  // regions that do not cover the parameter segment
  expect(() => declaredMcbWrites(lp, 2004)).toThrow("cover 2003 bytes");
  const one = (attrs: Record<string, string>) => ({ ...lp, blocks: [{ mergeId: 1, steps: [step("LdCtrlWriteProp", { ObjIdx: "4", PropId: "27", InlineData: "0000000A003200000000", ...attrs })] }] });
  expect(declaredMcbWrites(one({}), 10)).toHaveLength(1);
  expect(() => declaredMcbWrites(one({ InlineData: "0000000A003200000001" }), 10)).toThrow("beyond the 8-byte");
  expect(() => declaredMcbWrites(one({ InlineData: "0000000A00" }), 10)).toThrow("shorter than");
  expect(() => declaredMcbWrites(one({ ObjIdx: "3" }), 10)).toThrow("object 3");
  expect(() => declaredMcbWrites(one({ StartElement: "0" }), 10)).toThrow("element index");
  expect(() => declaredMcbWrites(one({ Count: "2" }), 10)).toThrow("more than one");
});
