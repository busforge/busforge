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
