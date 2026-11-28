import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig, sameParamValue } from "../src/appconfig.ts";
import { toAppModel, unmappedParamRefs } from "../src/application.ts";
import { resolveModuleInstances } from "../src/modules.ts";
import { buildDeviceConfig, refuseUnreachedInstances } from "../src/config.ts";
import { comObjectTable } from "../src/comobjtable.ts";
import { buildAbsoluteSegmentTargets, buildRelativeSegmentTarget } from "../src/deviceimage.ts";
import { readRealFixture } from "./real-catalogue.snapshot.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The Theben M-0048_A-493B channel device (HMG/RMG/JMG heating actuators) is the
// reference for module/channel per-instance memory offsets. These tests pin the
// from-scratch allocator re-run and the resolved-offset placement against the real
// manufacturer application program (no personal data). The allocator arithmetic and
// offsets here were hardware-byte-verified against the real devices' memory read-back
// (67/67 instances reproduced the project 0.xml exactly); see docs/device-memory-model.md.
const APP = "M-0048_A-493B-21-B471";

corpusDescribe("module instances (Theben 493B channel device)", () => {
  const xml = readRealFixture(`${APP}.xml.gz`);
  const app = parseAppConfig(xml);

  test("parses allocators, module args and Repeat counts", () => {
    expect(app.hasModules).toBe(true);
    expect(app.allocators.size).toBeGreaterThan(0);
    // The HMG6T parameter-range allocator starts at 26 (the first channel's base offset).
    expect(app.allocators.get(`${APP}_L-49`)).toMatchObject({ start: 26 });
    // The HMG6T base-offset argument consumes 32 bytes per channel.
    const md7 = app.moduleDefs.get(`${APP}_MD-7`)!;
    expect(md7.args.find((a) => a.id === `${APP}_MD-7_A-1`)?.allocates).toBe(32);
  });

  test("from-scratch allocator re-run hands out ETS-identical per-instance base offsets", () => {
    // Configure the device as an HMG 6 T (P-57 = 6): the channel selector picks the
    // six-channel heating branch, whose Repeat instantiates six MD-7 modules.
    const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
    const instances = resolveModuleInstances(app, env);
    const hmg = instances.filter((i) => i.refId === "MD-7_M-19");
    expect(hmg).toHaveLength(6);
    // ParamOffsBase (A-1) = allocator start 26 + channel index * 32.
    const bases = hmg.map((i) => Number(i.args.find((a) => a.refId === "MD-7_A-1")!.value));
    expect(bases).toEqual([26, 58, 90, 122, 154, 186]);
    // Instance ids are 1-based per module node, matching the 0.xml convention.
    expect(hmg.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `MD-7_M-19_MI-${n}`));
  });

  test("materializes module params at offset = static + per-instance base", () => {
    const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
    const instances = resolveModuleInstances(app, env);
    const model = toAppModel(app, { instances });
    // MD-7_P-1 (Funktion des Kanals) sits at static offset 48 in the module, relative to
    // base argument A-1. Channel 1 (A-1 = 26) places it at 74; channel 2 (A-1 = 58) at 106.
    const ch1 = model.refs.get(`${APP}_MD-7_M-19_MI-1_P-1_R-1`);
    expect(ch1).toBeDefined();
    expect(model.params.get(ch1!.paramId)?.offset).toBe(48 + 26);
    const ch2 = model.refs.get(`${APP}_MD-7_M-19_MI-2_P-1_R-1`);
    expect(model.params.get(ch2!.paramId)?.offset).toBe(48 + 58);
  });

  test("toAppModel without instances stays free of module refs (byte-identical legacy projection)", () => {
    const model = toAppModel(app);
    for (const id of model.refs.keys()) expect(id).not.toContain("_MI-");
  });

  test("materialized module refs are placeable (no unmappedParamRefs refusal)", () => {
    // The flash path refuses when a stored value has no placeable ref. Before module
    // support every instance value (…_MI-…) was unmapped and a channel device was
    // refused; with the instances materialized those refs exist, so a stored module
    // value is no longer flagged. Verify against the device's own instance refs.
    const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
    const instances = resolveModuleInstances(app, env);
    const model = toAppModel(app, { instances });
    const storedModuleValues = new Map([...model.refs.keys()].filter((id) => id.includes("_MI-")).map((id) => [id, "0"]));
    expect(storedModuleValues.size).toBeGreaterThan(0);
    expect(unmappedParamRefs(model, storedModuleValues)).toEqual([]);
    // And without materialization those same refs would be refused.
    expect(unmappedParamRefs(toAppModel(app), storedModuleValues).length).toBe(storedModuleValues.size);
  });

  test("UI-exposed module params under an active channel config are all image-placeable", () => {
    // The corpus coverage lock (real-catalogue.test.ts) runs every fixture in its
    // DEFAULT config; the 493B instantiates no channels until P-57 picks a count, so its
    // module path needs an explicit active config. With six HMG channels selected, every
    // editable per-instance param the UI exposes (…_MI-…) must be placeable by the image
    // model, so the flash guard never fires for a module device. This is the channel-active
    // form of stage 3: it locks in that the config and image projections agree on the
    // module-instance refs ETS pins into a project 0.xml.
    const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
    const instances = resolveModuleInstances(app, env);
    const view = buildDeviceConfig(app, env, undefined, instances);
    const uiRefs = new Map<string, string>();
    for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") uiRefs.set(it.param.refId, "0");
    // The active channels really do expose per-instance params (else the test is vacuous).
    expect([...uiRefs.keys()].some((r) => r.includes("_MI-"))).toBe(true);
    const model = toAppModel(app, { instances });
    expect(unmappedParamRefs(model, uiRefs)).toEqual([]);
  });

  test("Merker-gated block is hidden until its real switch is set (assignment by placement)", () => {
    // The HMG6T Notprogramm block (P-55..P-58) is gated by an Access=None Merker (P-7)
    // that is only placed when its real switch P-6 = 1. With P-6 at its default 0, ETS
    // leaves those parameter bytes at 0; our resolver must do the same (the Merker reads
    // as unset, so the block's params are not active). Hardware-verified on an HMG 6 T.
    const instances = resolveModuleInstances(app, new Map([[`${APP}_P-57_R-57`, "6"]]));
    const mi1 = `${APP}_MD-7_M-19_MI-1`;
    const setpoint = `${mi1}_P-57_R-71`; // Maximale Stellgroesse im Notprogramm (default 40)

    // P-6 default (0): Notprogramm hidden, the setpoint is NOT in the active image set.
    const off = buildDeviceConfig(app, new Map([[`${APP}_P-57_R-57`, "6"]]), undefined, instances);
    expect(off.imageValues.has(setpoint)).toBe(false);

    // P-6 = 1 for channel 1: the Merker gets placed, the block activates, setpoint appears.
    const on = buildDeviceConfig(app, new Map([[`${APP}_P-57_R-57`, "6"], [`${mi1}_P-6_R-6`, "1"]]), undefined, instances);
    expect(on.imageValues.get(setpoint)).toBe("40");
  });
});

// Second-manufacturer module pin: the MDT M-0083_A-00B6 (the one MV-0705 module device
// in the corpus, absolute-segment memory; see docs/device-memory-model.md). Its module
// mechanics are the OPPOSITE corner to the Theben 493B: no <Repeat>, no allocator-bound
// args. The Dynamic declares fixed <Module> nodes, gated by a <choose>, and every
// instance binds its base arguments to LITERAL values (the catalogue ships the resolved
// allocation). All expectations below are hand-read from the fixture XML, with the
// arithmetic in the comments, so this pins the resolver/materializer against the
// source, not against its own output.
const MDT = "M-0083_A-00B6-32-9642";

corpusDescribe("module instances (MDT M-0083 MV-0705 device, literal-arg modules)", () => {
  const xml = readRealFixture(`${MDT}.xml.gz`);
  const app = parseAppConfig(xml);

  test("instance set follows the input-mode selector (hand-derived from the choose tree)", () => {
    // From the fixture XML: Channel "Inputs A-B" holds <choose ParamRefId="P-5_R-8">
    // (P-5 "Function Input A / B", PT-EingangType: 0 = not active, 2 = channels single,
    // 1 = channels grouped; parameter default Value="2", the ref adds no override) with
    //   <when test="2"> MD-2_M-2 (input A) + MD-2_M-3 (input B)
    //   <when test="1"> MD-1_M-1 (grouped A/B)
    // and no default <when>, so P-5 = 0 instantiates neither. Channel "Logic" holds
    // MD-3_M-49..M-52 (logic blocks 1-4) UNGATED, so those 4 exist in every config.
    const logic = ["MD-3_M-49_MI-1", "MD-3_M-50_MI-1", "MD-3_M-51_MI-1", "MD-3_M-52_MI-1"];
    // Default config: P-5 falls back to its parameter default 2 -> single inputs A + B.
    expect(resolveModuleInstances(app, new Map()).map((i) => i.id).sort())
      .toEqual(["MD-2_M-2_MI-1", "MD-2_M-3_MI-1", ...logic]);
    // Explicit selector value 1 -> the grouped module replaces the two single ones.
    expect(resolveModuleInstances(app, new Map([[`${MDT}_P-5_R-8`, "1"]])).map((i) => i.id).sort())
      .toEqual(["MD-1_M-1_MI-1", ...logic]);
    // Inputs off (0): no matching when, no default branch -> only the logic modules.
    expect(resolveModuleInstances(app, new Map([[`${MDT}_P-5_R-8`, "0"]])).map((i) => i.id).sort())
      .toEqual(logic);
  });

  test("per-instance base offsets are the literal arg bindings from the XML", () => {
    // Hand-read from the fixture (NumericArg Value attributes, no AllocatorRefId):
    //   MD-2_M-2 (input A): <NumericArg RefId="..._MD-2_A-2" Value="0"/>
    //   MD-2_M-3 (input B): <NumericArg RefId="..._MD-2_A-2" Value="46"/>
    // A-2 ("BaseMemOffs") declares Allocates="46", and the literals are exactly the
    // sequence an allocator would hand out (0, 0+46), i.e. 46 bytes of parameter
    // memory per input channel.
    const instances = resolveModuleInstances(app, new Map());
    const arg = (mi: string, ref: string) => instances.find((i) => i.id === mi)!.args.find((a) => a.refId === ref)!.value;
    expect(arg("MD-2_M-2_MI-1", "MD-2_A-2")).toBe("0");
    expect(arg("MD-2_M-3_MI-1", "MD-2_A-2")).toBe("46");
    // Logic blocks, same pattern: MD-3_A-1 ("ParamOffsBase") literals 0, 13, 26, 39
    // (13 bytes per logic block).
    expect(["M-49", "M-50", "M-51", "M-52"].map((m) => arg(`MD-3_${m}_MI-1`, "MD-3_A-1"))).toEqual(["0", "13", "26", "39"]);
  });

  test("materializes an absolute-segment module param at offset = static + literal base", () => {
    // MD-2_P-34 declares in the fixture XML:
    //   <Memory CodeSegment="..._AS-4468" Offset="13" BitOffset="0" BaseOffset="..._MD-2_A-2"/>
    // so its materialized segment-relative offset is static 13 + the instance's A-2:
    //   input A (M-2, A-2 = 0):  13 + 0  = 13
    //   input B (M-3, A-2 = 46): 13 + 46 = 59
    const instances = resolveModuleInstances(app, new Map());
    const model = toAppModel(app, { instances });
    const a = model.refs.get(`${MDT}_MD-2_M-2_MI-1_P-34_R-3`);
    expect(a).toBeDefined();
    expect(model.params.get(a!.paramId)?.offset).toBe(13 + 0);
    expect(model.params.get(a!.paramId)?.codeSegment).toBe(`${MDT}_AS-4468`);
    const b = model.refs.get(`${MDT}_MD-2_M-3_MI-1_P-34_R-3`);
    expect(b).toBeDefined();
    expect(model.params.get(b!.paramId)?.offset).toBe(13 + 46);
  });
});

corpusDescribe("unresolved module arguments refuse instead of guessing (no silent base-0 placement)", () => {
  const xml = readRealFixture(`${APP}.xml.gz`);
  const env = new Map([[`${APP}_P-57_R-57`, "6"]]);

  test("an argument bound to an UNDECLARED allocator aborts instance resolution", () => {
    // Rename the declared allocator so the args' AllocatorRefId dangles: the whole
    // allocation chain is unknowable, and the old behavior silently dropped the arg
    // (downstream placement then fell back to channel-1 memory).
    const broken = parseAppConfig(xml.replaceAll(`<Allocator Id="${APP}_L-49"`, `<Allocator Id="${APP}_L-4949"`));
    expect(() => resolveModuleInstances(broken, env)).toThrow(/MODULE_ARG_UNRESOLVED|allocator/);
    try { resolveModuleInstances(broken, env); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("MODULE_ARG_UNRESOLVED"); }
  });

  test("a memory param whose BaseOffset argument is missing on the instance refuses materialization", () => {
    const app2 = parseAppConfig(xml);
    const instances = resolveModuleInstances(app2, env);
    const hmg = instances.filter((i) => i.refId === "MD-7_M-19");
    expect(hmg.length).toBe(6);
    // Strip the base-offset argument (MD-7_A-1) from channel 3: its params' placement
    // becomes unknowable. The old `?? 0` placed them over channel 1's memory.
    const tampered = instances.map((i) => (i.id === "MD-7_M-19_MI-3" ? { ...i, args: i.args.filter((a) => a.refId !== "MD-7_A-1") } : i));
    try { toAppModel(app2, { instances: tampered }); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("MODULE_ARG_UNRESOLVED"); }
    // The untampered set still materializes fine (the guard is not over-broad).
    expect(() => toAppModel(app2, { instances })).not.toThrow();
  });

  test("a com-object whose BaseNumber argument is missing on the instance refuses the config build", () => {
    const app2 = parseAppConfig(xml);
    // Find the argument the ACTIVE module's (MD-7, the six HMG channels) com-objects
    // use for numbering (ObjOffsBase): only an instantiated module's numbering is
    // actually resolved, so the tampering must hit an instance the env activates.
    const baseNumArg = [...app2.comObjects.entries()]
      .filter(([id]) => id.startsWith(`${APP}_MD-7_`))
      .map(([, o]) => o.baseNumber).find((b) => b !== undefined)!;
    expect(baseNumArg).toBeDefined();
    const instances = resolveModuleInstances(app2, env);
    const argRef = baseNumArg.startsWith(`${APP}_`) ? baseNumArg.slice(APP.length + 1) : baseNumArg;
    const tampered = instances.map((i) => ({ ...i, args: i.args.filter((a) => a.refId !== argRef) }));
    try { buildDeviceConfig(app2, env, undefined, tampered); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("COMOBJ_ARG_UNRESOLVED"); }
    // Untampered instances build fine.
    expect(() => buildDeviceConfig(app2, env, undefined, instances)).not.toThrow();
  });

  test("an argument that is not an integer refuses like a missing one", () => {
    const app2 = parseAppConfig(xml);
    const instances = resolveModuleInstances(app2, env);
    const baseNumArg = [...app2.comObjects.entries()]
      .filter(([id]) => id.startsWith(`${APP}_MD-7_`))
      .map(([, o]) => o.baseNumber).find((b) => b !== undefined)!;
    const numArgRef = baseNumArg.slice(APP.length + 1);
    for (const value of ["", "1.5", " 7", "0x10"]) {
      const offsetTampered = instances.map((i) => (i.id === "MD-7_M-19_MI-3" ? { ...i, args: i.args.map((a) => (a.refId === "MD-7_A-1" ? { ...a, value } : a)) } : i));
      try { toAppModel(app2, { instances: offsetTampered }); expect.unreachable(); }
      catch (e) { expect((e as { code?: string }).code).toBe("MODULE_ARG_UNRESOLVED"); }
      const numberTampered = instances.map((i) => ({ ...i, args: i.args.map((a) => (a.refId === numArgRef ? { ...a, value } : a)) }));
      try { buildDeviceConfig(app2, env, undefined, numberTampered); expect.unreachable(); }
      catch (e) { expect((e as { code?: string }).code).toBe("COMOBJ_ARG_UNRESOLVED"); }
    }
  });
});

// The allocator takes a choose's default branch where the configuration does (config.ts defaultBranchOf): on a
// ParameterRef an active branch places, or a memoryless one heading a reached block. A module in the default branch
// of a choose on a ref nothing places is not instantiated, so it consumes no allocator a later module would then
// start behind; on an Access="None" ref nothing places, which no ETS download decides, the allocation is refused.
test("a module in the default branch of a choose on a ParameterRef nothing places is not instantiated", () => {
  const base = readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8");
  const gated = (opts: { place?: boolean; head?: boolean; access?: string }) => parseAppConfig(base
    .replace("<Parameters />", '<Parameters><Parameter Id="M-TEST_A-2_P-G" Name="Gate" ParameterType="M-TEST_A-2_PT-OnOff" Text="Gate" Value="0" /></Parameters>')
    .replace("<ParameterRefs />", `<ParameterRefs><ParameterRef Id="M-TEST_A-2_P-G_R-1" RefId="M-TEST_A-2_P-G"${opts.access ? ` Access="${opts.access}"` : ""} /></ParameterRefs>`)
    .replace(/(<Repeat Id="M-TEST_A-2_X-1"[\s\S]*?<\/Repeat>)/, `${opts.place ? '<ParameterBlock Id="M-TEST_A-2_PB-9" Name="g" Text="Gate"><ParameterRefRef RefId="M-TEST_A-2_P-G_R-1" /></ParameterBlock>' : ""}${opts.head ? '<ParameterBlock Id="M-TEST_A-2_PB-8" Name="h" ParamRefId="M-TEST_A-2_P-G_R-1"><ParameterSeparator Id="M-TEST_A-2_PS-1" Text="page" /></ParameterBlock>' : ""}<choose ParamRefId="M-TEST_A-2_P-G_R-1"><when test="7" /><when default="true">$1</when></choose>`));
  expect(resolveModuleInstances(gated({}), new Map())).toEqual([]);
  expect(resolveModuleInstances(gated({ place: true }), new Map())).toHaveLength(4);
  expect(resolveModuleInstances(gated({ head: true }), new Map())).toHaveLength(4);
  expect(resolveModuleInstances(gated({ place: true, access: "None" }), new Map())).toHaveLength(4);
  expect(() => resolveModuleInstances(gated({ access: "None" }), new Map())).toThrow(expect.objectContaining({ code: "CHOOSE_DEFAULT_UNSETTLED" }));
});

// The allocator and config share choose.ts (selectChooseWhens and resolveParamValue), so
// unplaced non-Access="None" parameters AND unplaced Access="None" Merkers agree on both sides
// without shifting allocator offsets or triggering MODULE_INSTANCES_UNREACHED.
test("unplaced non-Access=None and Access=None Merker chooses agree in allocator and config", () => {
  const base = readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8");
  const merkerApp = (access: string, testVal: string, memory = false) => parseAppConfig(base
    .replace("<Parameters />", `<Parameters><Parameter Id="M-TEST_A-2_P-M" Name="Merker" ParameterType="M-TEST_A-2_PT-OnOff" Text="Merker"${access ? ` Access="${access}"` : ""} Value="1"${memory ? '><Memory CodeSegment="M-TEST_A-2_RS-1" Offset="0" BitOffset="0" /></Parameter>' : " />"}</Parameters>`)
    .replace("<ParameterRefs />", '<ParameterRefs><ParameterRef Id="M-TEST_A-2_P-M_R-1" RefId="M-TEST_A-2_P-M" /></ParameterRefs>')
    .replace('<Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="C" />', '<Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="C"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" Value="10" /></Module>')
    .replace(/(<Repeat Id="M-TEST_A-2_X-1"[\s\S]*?<\/Repeat>)/, `<choose ParamRefId="M-TEST_A-2_P-M_R-1"><when test="${testVal}">$1</when></choose>`));
  // Unplaced Access="Read" Merker and unplaced memory-backed ReadWrite parameter match neither 1 nor 0 in either walk.
  for (const app of [merkerApp("Read", "1"), merkerApp("Read", "0"), merkerApp("", "1", true), merkerApp("", "0", true)]) {
    expect(resolveModuleInstances(app, new Map())).toEqual([]);
    expect(buildDeviceConfig(app, new Map()).moduleInstances).toEqual([]);
  }
  // Unplaced Access="None" Merker (Value="1") reads as unset (0) in BOTH allocator and config.
  const noneOne = merkerApp("None", "1");
  expect(resolveModuleInstances(noneOne, new Map())).toEqual([]);
  expect(buildDeviceConfig(noneOne, new Map()).moduleInstances).toEqual([]);
  expect([...comObjectTable(noneOne, new Map()).keys()]).toEqual([]);
  const noneZero = merkerApp("None", "0");
  expect(resolveModuleInstances(noneZero, new Map())).toHaveLength(4);
  expect(buildDeviceConfig(noneZero, new Map()).moduleInstances).toHaveLength(4);
});

test("forward-placed Access=None Merker and Repeat Count=0 agree in allocator and config", () => {
  const base = readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8");
  const forwardXml = base
    .replace("<Parameters />", '<Parameters><Parameter Id="M-TEST_A-2_P-M" Name="Merker" ParameterType="M-TEST_A-2_PT-OnOff" Text="Merker" Access="None" Value="1" /></Parameters>')
    .replace("<ParameterRefs />", '<ParameterRefs><ParameterRef Id="M-TEST_A-2_P-M_R-1" RefId="M-TEST_A-2_P-M" /><ParameterRef Id="M-TEST_A-2_P-M_R-2" RefId="M-TEST_A-2_P-M" /></ParameterRefs>')
    .replace("<Static>", '<Static><Allocators><Allocator Id="M-TEST_A-2_AL-1" Name="Obj" Start="10" maxInclusive="99" /></Allocators>')
    .replace(/<Repeat Id="M-TEST_A-2_X-1"[\s\S]*?<\/Repeat>/,
      `<Repeat Id="M-TEST_A-2_X-0" Count="0"><Module Id="M-TEST_A-2_MD-1_M-0" RefId="M-TEST_A-2_MD-1" Name="Zero"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" AllocatorRefId="M-TEST_A-2_AL-1" /></Module></Repeat>` +
      `<choose ParamRefId="M-TEST_A-2_P-M_R-1"><when test="1"><Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="Fwd"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" AllocatorRefId="M-TEST_A-2_AL-1" /></Module></when></choose>` +
      `<choose ParamRefId="M-TEST_A-2_P-M_R-2"><when test="1"><Module Id="M-TEST_A-2_MD-1_M-2" RefId="M-TEST_A-2_MD-1" Name="Sibling"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" AllocatorRefId="M-TEST_A-2_AL-1" /></Module></when></choose>` +
      `<ParameterBlock Id="M-TEST_A-2_PB-9" Name="later" Text="Later"><ParameterRefRef RefId="M-TEST_A-2_P-M_R-1" /></ParameterBlock>`);
  const app = parseAppConfig(forwardXml);
  // Repeat Count="0" allocates nothing (allocator stays at 10); forward-placed R-1 activates M-1;
  // unplaced sibling R-2 stays unset (0), so M-2 is skipped.
  const inst = resolveModuleInstances(app, new Map());
  expect(inst).toEqual([{ id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-2", value: "10" }] }]);
  const build = buildDeviceConfig(app, new Map());
  expect(build.moduleInstances).toEqual(inst);
  expect([...build.imageComObjects.keys()]).toEqual([10]);
  expect([...comObjectTable(app, new Map()).keys()]).toEqual([10]);
});

test("refuseUnreachedInstances refuses both extra unreached instances and missing reached modules", () => {
  const base = readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8")
    .replace('<Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="C" />', '<Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="C"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" Value="10" /></Module>');
  const app = parseAppConfig(base);
  const real = resolveModuleInstances(app, new Map());
  const build = buildDeviceConfig(app, new Map(), undefined, real);
  expect(() => refuseUnreachedInstances(app, build, real)).not.toThrow();
  expect(() => refuseUnreachedInstances(app, build, [])).toThrow(expect.objectContaining({ code: "MODULE_INSTANCES_UNREACHED" }));
  expect(() => refuseUnreachedInstances(app, build, [...real, { id: "MD-1_M-99_MI-1", refId: "MD-1_M-99", args: [] }])).toThrow(expect.objectContaining({ code: "MODULE_INSTANCES_UNREACHED" }));
});

test("resolveModuleInstances refuses invalid Repeat Count, refuses self-justifying default branch, and ignores provisional pass-0 dead allocators", () => {
  const base = readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8");
  for (const bad of ["1.5", "-1", "Infinity", ""]) {
    const app = parseAppConfig(base.replace('Count="4"', `Count="${bad}"`));
    expect(() => resolveModuleInstances(app, new Map())).toThrow(expect.objectContaining({ code: "REPEAT_COUNT_INVALID" }));
  }
  const selfDefault = parseAppConfig(base
    .replace("<Parameters />", '<Parameters><Parameter Id="M-TEST_A-2_P-M" Name="Merker" ParameterType="M-TEST_A-2_PT-OnOff" Text="Merker" Access="None" Value="1" /></Parameters>')
    .replace("<ParameterRefs />", '<ParameterRefs><ParameterRef Id="M-TEST_A-2_P-M_R-1" RefId="M-TEST_A-2_P-M" /></ParameterRefs>')
    .replace(/<Repeat Id="M-TEST_A-2_X-1"[\s\S]*?<\/Repeat>/,
      `<choose ParamRefId="M-TEST_A-2_P-M_R-1"><when test="7" /><when default="true"><ParameterRefRef RefId="M-TEST_A-2_P-M_R-1" /><Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="C"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" Value="10" /></Module></when></choose>`));
  expect(() => resolveModuleInstances(selfDefault, new Map())).toThrow(expect.objectContaining({ code: "CHOOSE_DEFAULT_UNSETTLED" }));

  const provisionalDead = parseAppConfig(base
    .replace("<Parameters />", '<Parameters><Parameter Id="M-TEST_A-2_P-M" Name="Merker" ParameterType="M-TEST_A-2_PT-OnOff" Text="Merker" Access="None" Value="1" /></Parameters>')
    .replace("<ParameterRefs />", '<ParameterRefs><ParameterRef Id="M-TEST_A-2_P-M_R-1" RefId="M-TEST_A-2_P-M" /></ParameterRefs>')
    .replace(/<Repeat Id="M-TEST_A-2_X-1"[\s\S]*?<\/Repeat>/,
      `<ParameterBlock Id="M-TEST_A-2_PB-9" Name="p" Text="P"><ParameterRefRef RefId="M-TEST_A-2_P-M_R-1" /></ParameterBlock>` +
      `<choose ParamRefId="M-TEST_A-2_P-M_R-1">` +
        `<when test="0"><Module Id="M-TEST_A-2_MD-1_M-DEAD" RefId="M-TEST_A-2_MD-1" Name="Dead"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" AllocatorRefId="M-TEST_A-2_AL-MISSING" /></Module></when>` +
        `<when test="1"><Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="Live"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" Value="10" /></Module></when>` +
      `</choose>`));
  expect(resolveModuleInstances(provisionalDead, new Map())).toEqual([
    { id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-2", value: "10" }] },
  ]);
  expect([...buildDeviceConfig(provisionalDead, new Map()).imageComObjects.keys()]).toEqual([10]);
});

test("a module behind an unplaced memory-backed choose does not shift a later module's allocated offset", () => {
  const base = readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8");
  const xml = base
    .replace("<Parameters />", '<Parameters><Parameter Id="M-TEST_A-2_P-M" Name="Gate" ParameterType="M-TEST_A-2_PT-OnOff" Text="Gate" Value="1"><Memory CodeSegment="M-TEST_A-2_RS-4" Offset="0" BitOffset="0" /></Parameter></Parameters>')
    .replace("<ParameterRefs />", '<ParameterRefs><ParameterRef Id="M-TEST_A-2_P-M_R-1" RefId="M-TEST_A-2_P-M" /></ParameterRefs>')
    .replace(/<Repeat Id="M-TEST_A-2_X-1"[\s\S]*?<\/Repeat>/,
      `<choose ParamRefId="M-TEST_A-2_P-M_R-1"><when test="1"><Module Id="M-TEST_A-2_MD-1_M-1" RefId="M-TEST_A-2_MD-1" Name="Skipped"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" AllocatorRefId="M-TEST_A-2_AL-1" /></Module></when></choose>` +
      `<Module Id="M-TEST_A-2_MD-1_M-2" RefId="M-TEST_A-2_MD-1" Name="Kept"><NumericArg RefId="M-TEST_A-2_MD-1_A-2" AllocatorRefId="M-TEST_A-2_AL-1" /></Module>`)
    .replace("<Static>", '<Static><Allocators><Allocator Id="M-TEST_A-2_AL-1" Name="Obj" Start="10" maxInclusive="99" /></Allocators>');
  const app = parseAppConfig(xml);
  const inst = resolveModuleInstances(app, new Map());
  expect(inst).toEqual([{ id: "MD-1_M-2_MI-1", refId: "MD-1_M-2", args: [{ refId: "MD-1_A-2", value: "10" }] }]);
  const view = buildDeviceConfig(app, new Map());
  expect([...view.imageComObjects.keys()]).toEqual([10]);
  expect([...comObjectTable(app, new Map()).keys()]).toEqual([10]);
});

test("Parameter BaseValue adds the module instance numeric argument across allocator, choose, UI, Assign, and memory image", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
  <ApplicationProgram Id="M-TEST_A-35" ApplicationNumber="35" ApplicationVersion="1" MaskVersion="MV-07B0" MinEtsVersion="5.0" Name="BaseValue" DefaultLanguage="en-US">
    <Static>
      <Code><RelativeSegment Id="M-TEST_A-35_RS-4" Name="P" Size="16" LoadStateMachine="4" Offset="0" /></Code>
      <Allocators><Allocator Id="M-TEST_A-35_AL-1" Name="Ch" Start="10" maxInclusive="99" /></Allocators>
      <ParameterTypes>
        <ParameterType Id="M-TEST_A-35_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255" /></ParameterType>
      </ParameterTypes>
      <Parameters />
      <ParameterRefs />
      <ComObjectTable />
      <ComObjectRefs />
    </Static>
    <ModuleDefs>
      <ModuleDef Id="M-TEST_A-35_MD-1" Name="Channel">
        <Arguments>
          <Argument Id="M-TEST_A-35_MD-1_A-1" Name="ModeArg" />
          <Argument Id="M-TEST_A-35_MD-1_A-2" Name="MemBase" />
          <Argument Id="M-TEST_A-35_MD-1_A-3" Name="IdxArg" Allocates="2" />
        </Arguments>
        <Static>
          <Parameters>
            <Parameter Id="M-TEST_A-35_MD-1_P-1" Name="Mode" ParameterType="M-TEST_A-35_PT-N" Text="Mode" Access="Read" Value="0" BaseValue="M-TEST_A-35_MD-1_A-1" />
            <Parameter Id="M-TEST_A-35_MD-1_P-2" Name="Idx" ParameterType="M-TEST_A-35_PT-N" Text="Idx" Access="None" Value="1" BaseValue="M-TEST_A-35_MD-1_A-3" />
            <Parameter Id="M-TEST_A-35_MD-1_P-3" Name="Out" ParameterType="M-TEST_A-35_PT-N" Text="Out" Value="0">
              <Memory CodeSegment="M-TEST_A-35_RS-4" Offset="0" BitOffset="0" BaseOffset="M-TEST_A-35_MD-1_A-2" />
            </Parameter>
            <Parameter Id="M-TEST_A-35_MD-1_P-4" Name="Copied" ParameterType="M-TEST_A-35_PT-N" Text="Copied" Access="None" Value="0">
              <Memory CodeSegment="M-TEST_A-35_RS-4" Offset="1" BitOffset="0" BaseOffset="M-TEST_A-35_MD-1_A-2" />
            </Parameter>
            <Union SizeInBit="8">
              <Memory CodeSegment="M-TEST_A-35_RS-4" Offset="2" BitOffset="0" BaseOffset="M-TEST_A-35_MD-1_A-2" />
              <Parameter Id="M-TEST_A-35_MD-1_UP-5" Name="UnionBV" ParameterType="M-TEST_A-35_PT-N" Text="UnionBV" Access="Read" Value="5" BaseValue="M-TEST_A-35_MD-1_A-1" Offset="0" BitOffset="0" />
            </Union>
          </Parameters>
          <ParameterRefs>
            <ParameterRef Id="M-TEST_A-35_MD-1_P-1_R-1" RefId="M-TEST_A-35_MD-1_P-1" />
            <ParameterRef Id="M-TEST_A-35_MD-1_P-1_R-2" RefId="M-TEST_A-35_MD-1_P-1" Value="2" />
            <ParameterRef Id="M-TEST_A-35_MD-1_P-2_R-1" RefId="M-TEST_A-35_MD-1_P-2" />
            <ParameterRef Id="M-TEST_A-35_MD-1_P-3_R-1" RefId="M-TEST_A-35_MD-1_P-3" Value="10" />
            <ParameterRef Id="M-TEST_A-35_MD-1_P-3_R-2" RefId="M-TEST_A-35_MD-1_P-3" Value="44" />
            <ParameterRef Id="M-TEST_A-35_MD-1_P-4_R-1" RefId="M-TEST_A-35_MD-1_P-4" />
            <ParameterRef Id="M-TEST_A-35_MD-1_UP-5_R-1" RefId="M-TEST_A-35_MD-1_UP-5" />
          </ParameterRefs>
        </Static>
        <Dynamic>
          <ParameterBlock Id="M-TEST_A-35_MD-1_PB-1" Name="b" Text="Ch">
            <choose ParamRefId="M-TEST_A-35_MD-1_P-1_R-1">
              <when test="0"><ParameterRefRef RefId="M-TEST_A-35_MD-1_P-3_R-1" /></when>
              <when test="4"><ParameterRefRef RefId="M-TEST_A-35_MD-1_P-3_R-2" /></when>
            </choose>
            <ParameterRefRef RefId="M-TEST_A-35_MD-1_P-1_R-1" />
            <ParameterRefRef RefId="M-TEST_A-35_MD-1_P-2_R-1" />
            <ParameterRefRef RefId="M-TEST_A-35_MD-1_UP-5_R-1" />
            <Assign TargetParamRefRef="M-TEST_A-35_MD-1_P-4_R-1" SourceParamRefRef="M-TEST_A-35_MD-1_P-2_R-1" />
            <choose ParamRefId="M-TEST_A-35_MD-1_P-2_R-1">
              <when test="13">
                <Module Id="M-TEST_A-35_MD-2_M-9" RefId="M-TEST_A-35_MD-2" Name="Sub">
                  <NumericArg RefId="M-TEST_A-35_MD-2_A-1" Value="7" />
                </Module>
              </when>
            </choose>
          </ParameterBlock>
        </Dynamic>
      </ModuleDef>
      <ModuleDef Id="M-TEST_A-35_MD-2" Name="Nested">
        <Arguments><Argument Id="M-TEST_A-35_MD-2_A-1" Name="SubVal" /></Arguments>
        <Static>
          <Parameters>
            <Parameter Id="M-TEST_A-35_MD-2_P-1" Name="SubP" ParameterType="M-TEST_A-35_PT-N" Text="SubP" Value="1" BaseValue="M-TEST_A-35_MD-2_A-1">
              <Memory CodeSegment="M-TEST_A-35_RS-4" Offset="12" BitOffset="0" />
            </Parameter>
          </Parameters>
          <ParameterRefs><ParameterRef Id="M-TEST_A-35_MD-2_P-1_R-1" RefId="M-TEST_A-35_MD-2_P-1" /></ParameterRefs>
        </Static>
        <Dynamic><ParameterBlock Id="M-TEST_A-35_MD-2_PB-1" Name="s" Text="Sub"><ParameterRefRef RefId="M-TEST_A-35_MD-2_P-1_R-1" /></ParameterBlock></Dynamic>
      </ModuleDef>
    </ModuleDefs>
    <Dynamic>
      <ChannelIndependentBlock>
        <Module Id="M-TEST_A-35_MD-1_M-1" RefId="M-TEST_A-35_MD-1" Name="C1">
          <NumericArg RefId="M-TEST_A-35_MD-1_A-1" Value="0" />
          <NumericArg RefId="M-TEST_A-35_MD-1_A-2" Value="0" />
          <NumericArg RefId="M-TEST_A-35_MD-1_A-3" AllocatorRefId="M-TEST_A-35_AL-1" />
        </Module>
        <Module Id="M-TEST_A-35_MD-1_M-2" RefId="M-TEST_A-35_MD-1" Name="C2">
          <NumericArg RefId="M-TEST_A-35_MD-1_A-1" Value="4" />
          <NumericArg RefId="M-TEST_A-35_MD-1_A-2" Value="4" />
          <NumericArg RefId="M-TEST_A-35_MD-1_A-3" AllocatorRefId="M-TEST_A-35_AL-1" />
        </Module>
      </ChannelIndependentBlock>
    </Dynamic>
  </ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const app = parseAppConfig(xml);
  // Allocator evaluates BaseValue for MD-1_P-2 (1 + 10 = 11 on C1, 1 + 12 = 13 on C2), so only C2 instantiates MD-2_M-9.
  const inst = resolveModuleInstances(app, new Map());
  expect(inst.map((i) => i.id)).toEqual(["MD-1_M-1_MI-1", "MD-1_M-2_MI-1", "MD-2_M-9_MI-1"]);

  const view = buildDeviceConfig(app, new Map(), undefined, inst);
  const shown = new Map(view.blocks.flatMap((b) => b.items).filter((i) => i.kind === "param").map((i) => [i.param.refId, i.param]));
  // Forward-placed MD-1_P-1 (Value=0 + ModeArg): C1 -> 0 (Out=10), C2 -> 4 (Out=44); UI value and defaultValue both carry BaseValue.
  expect(shown.get("M-TEST_A-35_MD-1_M-1_MI-1_P-1_R-1")).toMatchObject({ value: "0", defaultValue: "0" });
  expect(shown.get("M-TEST_A-35_MD-1_M-2_MI-1_P-1_R-1")).toMatchObject({ value: "4", defaultValue: "4" });
  expect(shown.get("M-TEST_A-35_MD-1_M-2_MI-1_UP-5_R-1")).toMatchObject({ value: "9", defaultValue: "9" });
  // Memory image: C1 [10, 11, 5, 0], C2 [44, 13, 9, 0], nested MD-2_P-1 (1 + 7 = 8) at offset 12.
  const target = buildRelativeSegmentTarget(app, new Map(), 4, { moduleInstances: inst })!;
  expect([...target.bytes.subarray(0, 3)]).toEqual([10, 11, 5]);
  expect([...target.bytes.subarray(4, 7)]).toEqual([44, 13, 9]);
  expect(target.bytes[12]).toBe(8);
  // Explicit override replaces BaseValue without adding it a second time.
  const overridden = buildRelativeSegmentTarget(app, new Map([["M-TEST_A-35_MD-1_M-2_MI-1_UP-5_R-1", "21"]]), 4, { moduleInstances: inst })!;
  expect(overridden.bytes[6]).toBe(21);
  // ParameterRef/@Value overrides Parameter/@Value before BaseValue is added (2 + 4 = 6 on C2).
  const same = sameParamValue(app, inst);
  expect(same("M-TEST_A-35_MD-1_M-2_MI-1_P-1_R-1", null, "4")).toBe(true);
  expect(same("M-TEST_A-35_MD-1_M-2_MI-1_P-1_R-1", null, "0")).toBe(false);
  expect(same("M-TEST_A-35_MD-1_M-2_MI-1_P-1_R-2", null, "6")).toBe(true);
  // Two-sided sameParamValue compares each side against its own module instances when allocator args shift.
  const shiftedInst = inst.map((i) => (i.id === "MD-1_M-2_MI-1" ? { ...i, args: i.args.map((a) => (a.refId === "MD-1_A-1" ? { ...a, value: "7" } : a)) } : i));
  expect(sameParamValue(app, inst, shiftedInst)("M-TEST_A-35_MD-1_M-2_MI-1_P-1_R-1", null, null)).toBe(false);
  expect(sameParamValue(app, inst, shiftedInst)("M-TEST_A-35_MD-1_M-2_MI-1_P-1_R-1", null, "4")).toBe(true);
  expect(sameParamValue(app, inst, shiftedInst)("M-TEST_A-35_MD-1_M-2_MI-1_P-1_R-1", "7", null)).toBe(true);
  // Nested SubModuleDefs instance carrying the outer Module's RefId in 0.xml is not instantiated under MD-1,
  // and image builders refuse it loudly (SUBMODULE_UNSUPPORTED) instead of silently omitting its bytes.
  const withSub = [...inst, { id: "MD-1_M-2_MI-1_SM-1_M-1_MI-1-1", refId: "MD-1_M-2", args: [{ refId: "SM-1_A-1", value: "0" }] }];
  expect(() => buildDeviceConfig(app, new Map(), undefined, withSub)).not.toThrow();
  expect(() => buildRelativeSegmentTarget(app, new Map(), 4, { moduleInstances: withSub })).toThrow(expect.objectContaining({ code: "SUBMODULE_UNSUPPORTED" }));
});

test("BaseValue refuses loudly on missing/non-numeric argument, Text argument, non-integer static Value, or top-level declaration", () => {
  const mk = (extra: { paramAttr?: string; argDecl?: string; argXml?: string; topParam?: string }) => parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
  <ApplicationProgram Id="M-TEST_A-36" ApplicationNumber="36" ApplicationVersion="1" MaskVersion="MV-07B0" Name="BadBV" DefaultLanguage="en-US">
    <Static>
      <ParameterTypes><ParameterType Id="M-TEST_A-36_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255" /></ParameterType></ParameterTypes>
      <Parameters>${extra.topParam ?? ""}</Parameters>
      <ParameterRefs>${extra.topParam ? '<ParameterRef Id="M-TEST_A-36_P-T_R-1" RefId="M-TEST_A-36_P-T" />' : ""}</ParameterRefs>
    </Static>
    <ModuleDefs>
      <ModuleDef Id="M-TEST_A-36_MD-1" Name="M">
        <Arguments>${extra.argDecl ?? '<Argument Id="M-TEST_A-36_MD-1_A-1" Name="A1" />'}</Arguments>
        <Static>
          <Parameters><Parameter Id="M-TEST_A-36_MD-1_P-1" Name="P" ParameterType="M-TEST_A-36_PT-N" Text="P" Access="Read" ${extra.paramAttr ?? 'Value="0" BaseValue="M-TEST_A-36_MD-1_A-1"'} /></Parameters>
          <ParameterRefs><ParameterRef Id="M-TEST_A-36_MD-1_P-1_R-1" RefId="M-TEST_A-36_MD-1_P-1" /></ParameterRefs>
        </Static>
        <Dynamic>
          <ParameterBlock Id="M-TEST_A-36_MD-1_PB-1" Name="b" Text="B">
            <ParameterRefRef RefId="M-TEST_A-36_MD-1_P-1_R-1" />
            <choose ParamRefId="M-TEST_A-36_MD-1_P-1_R-1"><when test="1" /></choose>
          </ParameterBlock>
        </Dynamic>
      </ModuleDef>
    </ModuleDefs>
    <Dynamic><ChannelIndependentBlock>
      ${extra.topParam ? '<ParameterBlock Id="M-TEST_A-36_PB-T" Name="t" Text="T"><ParameterRefRef RefId="M-TEST_A-36_P-T_R-1" /></ParameterBlock>' : `<Module Id="M-TEST_A-36_MD-1_M-1" RefId="M-TEST_A-36_MD-1" Name="M">${extra.argXml ?? ""}</Module>`}
    </ChannelIndependentBlock></Dynamic>
  </ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
  const err = expect.objectContaining({ code: "MODULE_ARG_UNRESOLVED" });
  // Missing argument on instance
  const missingArg = mk({ argXml: "" });
  expect(() => resolveModuleInstances(missingArg, new Map())).toThrow(err);
  expect(() => buildDeviceConfig(missingArg, new Map(), undefined, [{ id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [] }])).toThrow(err);
  // Declared Type="Text" argument refuses even when its value consists of digits
  const textArg = mk({ argDecl: '<Argument Id="M-TEST_A-36_MD-1_A-1" Name="A1" Type="Text" />', argXml: '<TextArg RefId="M-TEST_A-36_MD-1_A-1" Value="4" />' });
  expect(() => resolveModuleInstances(textArg, new Map())).toThrow(err);
  expect(() => buildDeviceConfig(textArg, new Map(), undefined, [{ id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "4" }] }])).toThrow(err);
  // Non-numeric argument values (XML trims attribute edges, so " 4" is tested on a ModuleInstance directly)
  for (const bad of ["", "1.5", "abc", "0x10"]) {
    const app = mk({ argXml: `<NumericArg RefId="M-TEST_A-36_MD-1_A-1" Value="${bad}" />` });
    expect(() => resolveModuleInstances(app, new Map())).toThrow(err);
  }
  for (const bad of ["", "1.5", "abc", " 4", "0x10"]) {
    const app = mk({ argXml: '<NumericArg RefId="M-TEST_A-36_MD-1_A-1" Value="0" />' });
    expect(() => buildDeviceConfig(app, new Map(), undefined, [{ id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: bad }] }])).toThrow(err);
  }
  // Missing or non-integer static Value
  for (const attr of ['BaseValue="M-TEST_A-36_MD-1_A-1"', 'Value="" BaseValue="M-TEST_A-36_MD-1_A-1"', 'Value="1.5" BaseValue="M-TEST_A-36_MD-1_A-1"', 'Value="abc" BaseValue="M-TEST_A-36_MD-1_A-1"']) {
    const app = mk({ paramAttr: attr, argXml: '<NumericArg RefId="M-TEST_A-36_MD-1_A-1" Value="2" />' });
    expect(() => resolveModuleInstances(app, new Map())).toThrow(err);
    expect(() => buildDeviceConfig(app, new Map(), undefined, [{ id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "2" }] }])).toThrow(err);
  }
  // Top-level parameter declaring BaseValue outside any module instance
  const top = mk({ topParam: '<Parameter Id="M-TEST_A-36_P-T" Name="T" ParameterType="M-TEST_A-36_PT-N" Text="T" Value="0" BaseValue="M-TEST_A-36_MD-1_A-1" />' });
  expect(() => buildDeviceConfig(top, new Map())).toThrow(err);
});

test("BaseValue: hidden absolute-segment check uses static+arg and provisional pass-0 Assign converges in buildDeviceConfig", () => {
  // 1) AbsoluteSegment: hidden BaseValue module param (Value="0" + Arg=4 -> effective default 4).
  // Under MinEtsVersion="5.0" (hidden default rule = "default"), a hidden module param is refused whenever
  // its effective default differs from <Data>, and accepted when <Data> already matches it.
  const absXml = (dataByte: number) => parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
  <ApplicationProgram Id="M-TEST_A-37" ApplicationNumber="37" ApplicationVersion="1" MaskVersion="MV-0705" MinEtsVersion="5.0" Name="AbsBV" DefaultLanguage="en-US">
    <Static>
      <Code><AbsoluteSegment Id="M-TEST_A-37_AS-1" Address="16384" Size="4"><Data>${Buffer.from([dataByte, 0, 0, 0]).toString("base64")}</Data></AbsoluteSegment></Code>
      <ParameterTypes><ParameterType Id="M-TEST_A-37_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255" /></ParameterType></ParameterTypes>
      <Parameters />
      <ParameterRefs />
    </Static>
    <ModuleDefs>
      <ModuleDef Id="M-TEST_A-37_MD-1" Name="M">
        <Arguments><Argument Id="M-TEST_A-37_MD-1_A-1" Name="A1" /></Arguments>
        <Static>
          <Parameters>
            <Parameter Id="M-TEST_A-37_MD-1_P-1" Name="H" ParameterType="M-TEST_A-37_PT-N" Text="H" Value="0" BaseValue="M-TEST_A-37_MD-1_A-1">
              <Memory CodeSegment="M-TEST_A-37_AS-1" Offset="0" BitOffset="0" />
            </Parameter>
          </Parameters>
          <ParameterRefs><ParameterRef Id="M-TEST_A-37_MD-1_P-1_R-1" RefId="M-TEST_A-37_MD-1_P-1" /></ParameterRefs>
        </Static>
        <Dynamic><ParameterBlock Id="M-TEST_A-37_MD-1_PB-1" Name="b" Text="B" /></Dynamic>
      </ModuleDef>
    </ModuleDefs>
    <Dynamic><ChannelIndependentBlock>
      <Module Id="M-TEST_A-37_MD-1_M-1" RefId="M-TEST_A-37_MD-1" Name="M"><NumericArg RefId="M-TEST_A-37_MD-1_A-1" Value="4" /></Module>
    </ChannelIndependentBlock></Dynamic>
  </ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
  // <Data> holds 0x00 (static Value), which differs from effective default 4 -> must refuse, not bypass.
  expect(() => buildAbsoluteSegmentTargets(absXml(0x00), new Map())).toThrow(expect.objectContaining({ code: "PARAM_HIDDEN_UNSUPPORTED" }));
  // <Data> holds 0x04 (effective default 4) -> matches, no refusal.
  expect(() => buildAbsoluteSegmentTargets(absXml(0x04), new Map())).not.toThrow();

  // 2) Provisional pass-0 Assign reading an unplaced ref without Value before its placed sibling with Value="5" is discovered:
  // both resolveModuleInstances and buildDeviceConfig converge cleanly to 5 + 4 = 9.
  const provApp = parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
  <ApplicationProgram Id="M-TEST_A-38" ApplicationNumber="38" ApplicationVersion="1" MaskVersion="MV-07B0" Name="ProvBV" DefaultLanguage="en-US">
    <Static>
      <ParameterTypes><ParameterType Id="M-TEST_A-38_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255" /></ParameterType></ParameterTypes>
      <Parameters /><ParameterRefs />
    </Static>
    <ModuleDefs>
      <ModuleDef Id="M-TEST_A-38_MD-1" Name="M">
        <Arguments><Argument Id="M-TEST_A-38_MD-1_A-1" Name="A1" /></Arguments>
        <Static>
          <Parameters>
            <Parameter Id="M-TEST_A-38_MD-1_P-1" Name="Src" ParameterType="M-TEST_A-38_PT-N" Text="Src" BaseValue="M-TEST_A-38_MD-1_A-1" />
            <Parameter Id="M-TEST_A-38_MD-1_P-2" Name="Dst" ParameterType="M-TEST_A-38_PT-N" Text="Dst" Access="None" Value="0" />
          </Parameters>
          <ParameterRefs>
            <ParameterRef Id="M-TEST_A-38_MD-1_P-1_R-1" RefId="M-TEST_A-38_MD-1_P-1" />
            <ParameterRef Id="M-TEST_A-38_MD-1_P-1_R-2" RefId="M-TEST_A-38_MD-1_P-1" Value="5" />
            <ParameterRef Id="M-TEST_A-38_MD-1_P-2_R-1" RefId="M-TEST_A-38_MD-1_P-2" />
          </ParameterRefs>
        </Static>
        <Dynamic>
          <ParameterBlock Id="M-TEST_A-38_MD-1_PB-1" Name="b" Text="B">
            <Assign TargetParamRefRef="M-TEST_A-38_MD-1_P-2_R-1" SourceParamRefRef="M-TEST_A-38_MD-1_P-1_R-1" />
            <ParameterRefRef RefId="M-TEST_A-38_MD-1_P-1_R-2" />
          </ParameterBlock>
        </Dynamic>
      </ModuleDef>
    </ModuleDefs>
    <Dynamic><ChannelIndependentBlock>
      <Module Id="M-TEST_A-38_MD-1_M-1" RefId="M-TEST_A-38_MD-1" Name="M"><NumericArg RefId="M-TEST_A-38_MD-1_A-1" Value="4" /></Module>
    </ChannelIndependentBlock></Dynamic>
  </ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
  const inst = resolveModuleInstances(provApp, new Map());
  const view = buildDeviceConfig(provApp, new Map(), undefined, inst);
  expect(view.imageValues.get("M-TEST_A-38_MD-1_M-1_MI-1_P-2_R-1")).toBe("9");
});
