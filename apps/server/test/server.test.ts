import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGroupTpdu } from "../src/telegram.ts";
import { Bus } from "../src/bus.ts";
import { createState, handleApi, mergeLinkBaseline, type AppState } from "../src/app.ts";

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const encFixture = readFileSync(join(fixtures, "sample-encrypted.knxproj"));
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));

describe("mergeLinkBaseline (read-back link baseline)", () => {
  const m = (o: Record<string, number[]>) => new Map(Object.entries(o));
  const obj = (x: Map<string, number[]>) => Object.fromEntries(x);

  test("non-module: overrides differing, adds device-only, clears live-only", () => {
    const live = m({ A: [1, 2], B: [5], D: [3] });
    const device = m({ A: [2, 1], B: [9], C: [7] }); // A same set (reordered), B differs, C new, D gone
    expect(obj(mergeLinkBaseline(live, device, false))).toEqual({ A: [1, 2], B: [9], C: [7] });
  });

  test("module: only trusts device links mapping onto a known live com-object", () => {
    const live = m({ A: [1, 2], B: [5], D: [3] });
    const device = m({ A: [9], C: [7] }); // A in live -> override; C not in live -> ignore; B,D absent -> kept
    expect(obj(mergeLinkBaseline(live, device, true))).toEqual({ A: [9], B: [5], D: [3] });
  });

  test("no drift yields an unchanged baseline (both branches)", () => {
    const live = m({ A: [1], B: [2] });
    expect(obj(mergeLinkBaseline(live, m({ A: [1], B: [2] }), false))).toEqual({ A: [1], B: [2] });
    expect(obj(mergeLinkBaseline(live, m({ A: [1], B: [2] }), true))).toEqual({ A: [1], B: [2] });
  });
});

describe("telegram decoding", () => {
  test("GroupValueWrite with a 1-bit value", () => {
    // src 1.2.50, dst 0/0/1, APDU 00 81 -> write, value bit 1
    const t = decodeGroupTpdu(0x1232, 0x0001, Buffer.from([0x00, 0x81]), 1000);
    expect(t).toMatchObject({ src: "1.2.50", dst: "0/0/1", dstRaw: 1, kind: "GroupValueWrite", raw: "01" });
  });
  test("GroupValueRead", () => {
    expect(decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x00]), 0).kind).toBe("GroupValueRead");
  });
  test("GroupValueResponse with a trailing byte payload", () => {
    const t = decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x40, 0xab]), 0);
    expect(t.kind).toBe("GroupValueResponse");
    expect(t.raw).toBe("ab");
  });
});

describe("Bus", () => {
  test("delivers telegrams to subscribers and respects unsubscribe", () => {
    const bus = new Bus(() => 42);
    const got: string[] = [];
    const unsub = bus.subscribe((t) => got.push(t.dst));
    (bus as any).emit(decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 42));
    unsub();
    (bus as any).emit(decodeGroupTpdu(0, 2, Buffer.from([0x00, 0x81]), 42));
    expect(got).toEqual(["0/0/1"]);
  });
  test("status starts disconnected with no active project", () => {
    const bus = new Bus();
    expect(bus.status).toBe("disconnected");
    expect(bus.activeProjectId).toBeNull();
  });
});

describe("API (project resources)", () => {
  const tmps: string[] = [];
  function freshState(): AppState {
    const dir = mkdtempSync(join(tmpdir(), "busforge-test-"));
    tmps.push(dir);
    return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  }
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
  const importDemo = async (state: AppState, password = "tester12") => {
    const form = new FormData();
    form.set("file", new File([encFixture], "Demo.knxproj"));
    form.set("password", password);
    return handleApi(req("/api/projects/import", { method: "POST", body: form }), state);
  };

  test("empty list initially", async () => {
    const res = await handleApi(req("/api/projects"), freshState());
    expect(await res!.json()).toEqual([]);
  });

  test("import -> list -> get", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    expect(imp).toMatchObject({ name: "Demo", deviceCount: 2, gaCount: 2 });
    expect(imp.id).toBeString();

    const list = (await (await handleApi(req("/api/projects"), state))!.json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: imp.id, name: "Demo", deviceCount: 2, gaCount: 2 });

    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    expect(proj.devices).toHaveLength(2);
    expect(proj.groupRanges[0].name).toBe("Licht");
    expect(proj.groupRanges[0].children[0].addresses).toHaveLength(2);
    expect(proj.interface).toMatchObject({ interfaceIp: "", port: 3671 });
  });

  test("import with wrong password -> error, nothing stored", async () => {
    const state = freshState();
    const res = await importDemo(state, "wrong");
    expect(res!.status).toBe(400);
    expect(await (await handleApi(req("/api/projects"), state))!.json()).toEqual([]);
  });

  test("get unknown project -> 404", async () => {
    const res = await handleApi(req("/api/projects/nope"), freshState());
    expect(res!.status).toBe(404);
  });

  test("editing a param back to its default clears the change", async () => {
    const state = freshState();
    const form = new FormData();
    form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    const dev = proj.devices[0].id;
    const set = (value: string) => handleApi(req(`/api/projects/${imp.id}/devices/${dev}/params`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId: "M-TEST_A-1_P-1_R-1", value }),
    }), state);
    const changes = async () => ((await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any).devices[0].changes;

    await set("1"); // away from the default ("0")
    expect(await changes()).toMatchObject({ params: 1 });
    await set("0"); // back to the default -> override dropped, no longer a change
    expect(await changes()).toMatchObject({ params: 0 });
  });

  test("interface round-trip per project", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    const res = await handleApi(req(`/api/projects/${imp.id}/interface`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ interfaceIp: "203.0.113.15", port: 3671 }),
    }), state);
    expect(await res!.json()).toMatchObject({ interfaceIp: "203.0.113.15", port: 3671 });
    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    expect(proj.interface.interfaceIp).toBe("203.0.113.15");
  });

  test("connect without an interface IP -> error", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    const res = await handleApi(req(`/api/projects/${imp.id}/bus/connect`, { method: "POST" }), state);
    expect(res!.status).toBe(400);
  });

  test("bus status is disconnected for a known project", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    const res = await handleApi(req(`/api/projects/${imp.id}/bus/status`), state);
    expect(await res!.json()).toMatchObject({ status: "disconnected", projectId: null });
  });

  test("delete removes the project", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    expect((await handleApi(req(`/api/projects/${imp.id}`, { method: "DELETE" }), state))!.status).toBe(200);
    expect(await (await handleApi(req("/api/projects"), state))!.json()).toEqual([]);
    expect((await handleApi(req(`/api/projects/${imp.id}`, { method: "DELETE" }), state))!.status).toBe(404);
  });

  test("snapshots: create -> edit -> restore round-trip", async () => {
    const state = freshState();
    const form = new FormData();
    form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    const dev = proj.devices[0].id;
    const param = "M-TEST_A-1_P-1_R-1";

    // Capture a manual restore point of the clean (seeded) config.
    const created = await handleApi(req(`/api/projects/${imp.id}/snapshots`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "clean" }),
    }), state);
    expect(created!.status).toBe(201);
    const snap = (await created!.json()) as any;
    expect(snap).toMatchObject({ label: "clean", kind: "manual" });

    const list = (await (await handleApi(req(`/api/projects/${imp.id}/snapshots`), state))!.json()) as any[];
    expect(list).toHaveLength(1);

    // Edit a parameter, then restore: the edit is rolled back.
    await handleApi(req(`/api/projects/${imp.id}/devices/${dev}/params`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId: param, value: "1" }),
    }), state);
    const afterEdit = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    expect(afterEdit.devices[0].changes).toMatchObject({ params: 1 });

    const restored = await handleApi(req(`/api/projects/${imp.id}/snapshots/${snap.id}/restore`, { method: "POST" }), state);
    expect(restored!.status).toBe(200);
    const afterRestore = (await restored!.json()) as any;
    expect(afterRestore.devices[0].changes).toMatchObject({ params: 0 });
  });

  test("snapshot restore/delete of an unknown id -> 404", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    expect((await handleApi(req(`/api/projects/${imp.id}/snapshots/ghost/restore`, { method: "POST" }), state))!.status).toBe(404);
    expect((await handleApi(req(`/api/projects/${imp.id}/snapshots/ghost`, { method: "DELETE" }), state))!.status).toBe(404);
  });

  test("non-api path returns null (falls through to static)", async () => {
    expect(await handleApi(req("/index.html"), freshState())).toBeNull();
  });
});

describe("device configuration", () => {
  const tmps: string[] = [];
  function freshState(): AppState {
    const dir = mkdtempSync(join(tmpdir(), "busforge-cfg-"));
    tmps.push(dir);
    return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1 });
  }
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

  async function importConfig(state: AppState) {
    const form = new FormData();
    form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    return { projectId: imp.id, deviceId: proj.devices[0].id };
  }
  const paramNames = (v: any) => v.blocks.flatMap((b: any) => b.items).filter((i: any) => i.kind === "param").map((i: any) => `${i.param.name}=${i.param.value}`);
  const comObjCount = (v: any) => v.blocks.flatMap((b: any) => b.items).filter((i: any) => i.kind === "comObject").length;

  test("device carries its instance id and app ref", async () => {
    const state = freshState();
    const imp = (await (async () => { const f = new FormData(); f.set("file", new File([cfgFixture], "x.knxproj")); f.set("password", "tester12"); return (await (await handleApi(req("/api/projects/import", { method: "POST", body: f }), state))!.json()) as any; })());
    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    expect(proj.devices[0]).toMatchObject({ id: "P-CFG-0_DI-1", ia: "1.1.10", appRef: "M-TEST_H-1_HP-1" });
  });

  test("config reflects the seeded value and conditional visibility", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    // seeded Mode=0 -> default branch -> Label, no com-object
    const v0 = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    expect(paramNames(v0)).toEqual(["Mode=0", "Label=hello"]);
    expect(comObjCount(v0)).toBe(0);
  });

  test("editing a parameter persists and recomputes visibility", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    const put = await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/params`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId: "M-TEST_A-1_P-1_R-1", value: "1" }),
    }), state);
    const v1 = (await put!.json()) as any;
    expect(paramNames(v1)).toEqual(["Mode=1", "Level=42"]);
    expect(comObjCount(v1)).toBe(1);
    // persisted: a fresh GET shows the same
    const again = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    expect(paramNames(again)).toEqual(["Mode=1", "Level=42"]);
  });

  test("German localization via ?lang", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    const v = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config?lang=de-DE`), state))!.json()) as any;
    expect(paramNames(v)[0]).toBe("Modus=0");
  });

  test("unknown device -> 404", async () => {
    const state = freshState();
    const { projectId } = await importConfig(state);
    const res = await handleApi(req(`/api/projects/${projectId}/devices/ghost/config`), state);
    expect(res!.status).toBe(404);
  });

  test("flash guards: unknown device -> 404, no interface -> 400", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    // unknown device
    const r1 = await handleApi(req(`/api/projects/${projectId}/devices/ghost/flash`, { method: "POST" }), state);
    expect(r1!.status).toBe(404);
    // known device but no interface set -> refuses before any bus access
    const r2 = await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash`, { method: "POST" }), state);
    expect(r2!.status).toBe(400);
    expect(((await r2!.json()) as any).error.code).toBe("INTERFACE_NOT_SET");
  });

  test("flash-ga guards: unknown device 404, no interface 400", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    expect((await handleApi(req(`/api/projects/${projectId}/devices/ghost/flash-ga`, { method: "POST" }), state))!.status).toBe(404);
    const r2 = await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash-ga`, { method: "POST" }), state);
    expect(r2!.status).toBe(400);
  });

  test("tasks endpoint is empty until a bus operation runs", async () => {
    const state = freshState();
    const { projectId } = await importConfig(state);
    const res = await handleApi(req(`/api/projects/${projectId}/tasks`, { method: "GET" }), state);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });
});
