import { test, expect, describe } from "bun:test";
import { parseAppConfig } from "../src/appconfig.ts";
import { toAppModel, unmappedParamRefs } from "../src/application.ts";
import { resolveModuleInstances } from "../src/modules.ts";
import { buildDeviceConfig } from "../src/config.ts";
import { readRealFixture } from "./real-catalogue.snapshot.ts";

// The Theben M-0048_A-493B channel device (HMG/RMG/JMG heating actuators) is the
// reference for module/channel per-instance memory offsets. These tests pin the
// from-scratch allocator re-run and the resolved-offset placement against the real
// manufacturer application program (no personal data). The allocator arithmetic and
// offsets here were hardware-byte-verified against the real devices' memory read-back
// (67/67 instances reproduced the project 0.xml exactly); see docs/device-memory-model.md.
const APP = "M-0048_A-493B-21-B471";

describe("module instances (Theben 493B channel device)", () => {
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
    // as unset, so the block's params are not active). Hardware-verified on a device.
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

describe("module instances (MDT M-0083 MV-0705 device, literal-arg modules)", () => {
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

describe("unresolved module arguments refuse instead of guessing (no silent base-0 placement)", () => {
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
});
