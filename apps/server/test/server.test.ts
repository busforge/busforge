import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGroupTpdu } from "../src/telegram.ts";
import { Bus } from "../src/bus.ts";
import { createState, handleApi, mergeLinkBaseline, selectFlashLinks, type AppState } from "../src/app.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const encFixture = readFileSync(join(fixtures, "sample-encrypted.knxproj"));
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));

// A synthetic .knxprod: one manufacturer product with its application program,
// laid out like the manufacturer data in a .knxproj outer zip.
function knxprod(): Buffer {
  const hardware = `<?xml version="1.0"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083">
  <Hardware><Hardware Id="M-0083_H-SW4-1" Name="Switch" VersionNumber="3">
    <Products><Product Id="M-0083_H-SW4-1_P-prod" Text="Demo Switch 4f" OrderNumber="SW-4F-001"/></Products>
    <Hardware2Programs><Hardware2Program Id="M-0083_H-SW4-1_HP-AAAA-1-0001"><ApplicationProgramRef RefId="M-0083_A-AAAA-1-0001"/></Hardware2Program></Hardware2Programs>
  </Hardware></Hardware>
</Manufacturer></ManufacturerData></KNX>`;
  return storeZip({
    "M-0083/Hardware.xml": hardware,
    "M-0083/M-0083_A-AAAA-1-0001.xml": `<KNX><ManufacturerData><Manufacturer><ApplicationPrograms><ApplicationProgram Id="M-0083_A-AAAA-1-0001"/></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`,
  });
}

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

describe("selectFlashLinks (ETS-parity hidden-object handling)", () => {
  const APP = "M-0083_A-AAAA-1-0001";
  const stored = new Map<string, number[]>([["O-0", [6]], ["O-2", [262]]]);

  test("visible com-object -> flashed with its active number", () => {
    const numByRef = new Map([[`${APP}_O-0`, 0], [`${APP}_O-2`, 2]]);
    const links = selectFlashLinks(stored, numByRef, APP);
    expect(links).toEqual([{ comObjNum: 0, gaRaws: [6] }, { comObjNum: 2, gaRaws: [262] }]);
  });

  test("com-object hidden by parameters -> its GA is dropped from the flash", () => {
    // O-0 is no longer in the active view (parameter hid it); O-2 stays visible.
    const numByRef = new Map([[`${APP}_O-2`, 2]]);
    const links = selectFlashLinks(stored, numByRef, APP);
    expect(links).toEqual([{ comObjNum: 2, gaRaws: [262] }]);
  });

  test("a stored link with no active com-object (hidden module instance) -> skipped, never throws", () => {
    // Module com-objects use synthetic per-instance ref ids absent from the flat
    // tables; a hidden one resolves to no active number. It must be skipped (its
    // GA stays in the project), not abort the whole flash.
    const moduleLinks = new Map<string, number[]>([["MD-1_M-1_MI-1_O-0_R-1", [6]]]);
    expect(selectFlashLinks(moduleLinks, new Map<string, number>(), APP)).toEqual([]);
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

describe("blank projects + catalog (device placement)", () => {
  const tmps: string[] = [];
  function freshState(): AppState {
    const dir = mkdtempSync(join(tmpdir(), "busforge-blank-"));
    tmps.push(dir);
    return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  }
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
  const importConfig = async (state: AppState) => {
    const form = new FormData();
    form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    return (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  };

  test("import backfills a placeable catalog from its devices", async () => {
    const state = freshState();
    await importConfig(state);
    const catalog = (await (await handleApi(req("/api/catalog/products"), state))!.json()) as any[];
    expect(catalog.length).toBeGreaterThanOrEqual(1);
    const prod = catalog.find((p) => p.appRef === "M-TEST_H-1_HP-1");
    expect(prod).toBeDefined();
    expect(prod.appProgramId).toBe("M-TEST_A-1");
  });

  test("create blank project -> place a device -> configurable", async () => {
    const state = freshState();
    await importConfig(state); // seeds the catalog
    const catalog = (await (await handleApi(req("/api/catalog/products"), state))!.json()) as any[];
    const prod = catalog.find((p) => p.appRef === "M-TEST_H-1_HP-1");

    // Blank project: created empty.
    const created = await handleApi(req("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "From scratch" }),
    }), state);
    expect(created!.status).toBe(201);
    const blank = (await created!.json()) as any;
    expect(blank).toMatchObject({ name: "From scratch", deviceCount: 0, gaCount: 0 });

    // Place a device from the catalog.
    const added = await handleApi(req(`/api/projects/${blank.id}/devices`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appRef: prod.appRef, productRef: prod.productRef }),
    }), state);
    expect(added!.status).toBe(201);
    const device = (await added!.json()) as any;
    expect(device.ia).toBe("1.1.1"); // first free address in a fresh project
    expect(device.id).toBeString();

    // The project now has the device, and its config view builds from the catalog.
    const proj = (await (await handleApi(req(`/api/projects/${blank.id}`), state))!.json()) as any;
    expect(proj.devices).toHaveLength(1);
    expect(proj.devices[0]).toMatchObject({ id: device.id, ia: "1.1.1", appRef: prod.appRef });

    const cfg = await handleApi(req(`/api/projects/${blank.id}/devices/${device.id}/config`), state);
    expect(cfg!.status).toBe(200);
    const view = (await cfg!.json()) as any;
    expect(view.blocks.length).toBeGreaterThan(0);

    // A second device gets the next free address.
    const added2 = (await (await handleApi(req(`/api/projects/${blank.id}/devices`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appRef: prod.appRef, productRef: prod.productRef }),
    }), state))!.json()) as any;
    expect(added2.ia).toBe("1.1.2");
  });

  test("create with no name -> 400; place unknown product -> 404", async () => {
    const state = freshState();
    const noName = await handleApi(req("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "  " }),
    }), state);
    expect(noName!.status).toBe(400);
    expect(((await noName!.json()) as any).error.code).toBe("PROJECT_NAME_REQUIRED");

    const blank = (await (await handleApi(req("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "P" }),
    }), state))!.json()) as any;
    const bad = await handleApi(req(`/api/projects/${blank.id}/devices`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appRef: "M-NOPE_H-9_HP-9", productRef: "M-NOPE_P-9" }),
    }), state);
    expect(bad!.status).toBe(404);
    expect(((await bad!.json()) as any).error.code).toBe("CATALOG_PRODUCT_NOT_FOUND");
  });
});

describe("catalog import (.knxprod official source)", () => {
  const tmps: string[] = [];
  function freshState(): AppState {
    const dir = mkdtempSync(join(tmpdir(), "busforge-prod-"));
    tmps.push(dir);
    return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  }
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
  const importProd = (state: AppState) => {
    const form = new FormData();
    form.set("file", new File([knxprod()], "vendor.knxprod"));
    return handleApi(req("/api/catalog/import", { method: "POST", body: form }), state);
  };

  test("import populates the catalog without creating a project", async () => {
    const state = freshState();
    const res = await importProd(state);
    expect(res!.status).toBe(201);
    expect(await res!.json()).toEqual({ products: 1, programs: 1 });

    const catalog = (await (await handleApi(req("/api/catalog/products"), state))!.json()) as any[];
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ name: "Demo Switch 4f", orderNumber: "SW-4F-001", appRef: "M-0083_H-SW4-1_HP-AAAA-1-0001" });
    // No project was created.
    expect(await (await handleApi(req("/api/projects"), state))!.json()).toEqual([]);
  });

  test("imported products are placeable into a blank project", async () => {
    const state = freshState();
    await importProd(state);
    const blank = (await (await handleApi(req("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "P" }),
    }), state))!.json()) as any;
    const added = await handleApi(req(`/api/projects/${blank.id}/devices`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appRef: "M-0083_H-SW4-1_HP-AAAA-1-0001", productRef: "M-0083_H-SW4-1_P-prod" }),
    }), state);
    expect(added!.status).toBe(201);
    expect(((await added!.json()) as any).ia).toBe("1.1.1");
  });

  test("pinned catalog survives project deletion GC", async () => {
    const state = freshState();
    await importProd(state);
    // Create then delete a blank project: GC runs on delete but must not drop the
    // pinned official-source product.
    const blank = (await (await handleApi(req("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "throwaway" }),
    }), state))!.json()) as any;
    expect((await handleApi(req(`/api/projects/${blank.id}`, { method: "DELETE" }), state))!.status).toBe(200);

    const catalog = (await (await handleApi(req("/api/catalog/products"), state))!.json()) as any[];
    expect(catalog).toHaveLength(1); // still there
  });

  test("a non-zip upload is rejected, an empty archive too", async () => {
    const state = freshState();
    const junk = new FormData();
    junk.set("file", new File([Buffer.from("not a zip")], "x.knxprod"));
    const junkRes = await handleApi(req("/api/catalog/import", { method: "POST", body: junk }), state);
    expect(junkRes!.status).toBe(400);
    // A non-zip reports the .knxprod-aware code, not the .knxproj-worded zip error.
    expect(((await junkRes!.json()) as any).error.code).toBe("CATALOG_IMPORT_EMPTY");

    const empty = new FormData();
    empty.set("file", new File([storeZip({ "readme.txt": "hi" })], "x.knxprod"));
    const res = await handleApi(req("/api/catalog/import", { method: "POST", body: empty }), state);
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error.code).toBe("CATALOG_IMPORT_EMPTY");
  });
});

describe("busforge re-import (export round-trip)", () => {
  const tmps: string[] = [];
  function freshState(): AppState {
    const dir = mkdtempSync(join(tmpdir(), "busforge-reimport-"));
    tmps.push(dir);
    return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  }
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
  const importCfg = async (state: AppState) => {
    const form = new FormData();
    form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    return (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  };
  const reimport = (state: AppState, json: unknown) => {
    const form = new FormData();
    form.set("file", new File([JSON.stringify(json)], "p.busforge.json"));
    return handleApi(req("/api/projects/import-busforge", { method: "POST", body: form }), state);
  };

  test("export then re-import recreates an independent, equivalent project", async () => {
    const state = freshState();
    const a = await importCfg(state);
    const projA = (await (await handleApi(req(`/api/projects/${a.id}`), state))!.json()) as any;
    const dev = projA.devices[0].id;
    // Edit a parameter so the round-trip has a non-default value to preserve.
    await handleApi(req(`/api/projects/${a.id}/devices/${dev}/params`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId: "M-TEST_A-1_P-1_R-1", value: "1" }),
    }), state);

    const exported = await (await handleApi(req(`/api/projects/${a.id}/export`), state))!.json();

    const res = await reimport(state, exported);
    expect(res!.status).toBe(201);
    const b = (await res!.json()) as any;
    expect(b.id).not.toBe(a.id);
    expect(b).toMatchObject({ name: projA.name, deviceCount: projA.devices.length, gaCount: projA.gaCount });

    // Both projects coexist.
    const list = (await (await handleApi(req("/api/projects"), state))!.json()) as any[];
    expect(list).toHaveLength(2);

    // The re-imported project matches: devices, the group-range tree, and the edited
    // parameter (drift preserved against the restored baseline).
    const projB = (await (await handleApi(req(`/api/projects/${b.id}`), state))!.json()) as any;
    expect(projB.devices.map((d: any) => [d.id, d.ia, d.appRef])).toEqual(projA.devices.map((d: any) => [d.id, d.ia, d.appRef]));
    // The range tree round-trips structurally; ids are the global autoincrement and
    // are legitimately reassigned, so compare with ids stripped.
    const stripIds = (n: any): any => ({ name: n.name, rangeStart: n.rangeStart, rangeEnd: n.rangeEnd, addresses: n.addresses, children: n.children.map(stripIds) });
    expect(projB.groupRanges.map(stripIds)).toEqual(projA.groupRanges.map(stripIds));
    expect(projB.devices[0].changes).toMatchObject({ params: 1 });

    // The catalog program came back, so the device config builds.
    const cfg = await handleApi(req(`/api/projects/${b.id}/devices/${projB.devices[0].id}/config`), state);
    expect(cfg!.status).toBe(200);
    expect(((await cfg!.json()) as any).blocks.length).toBeGreaterThan(0);
  });

  test("malformed and wrong-version artifacts are rejected", async () => {
    const state = freshState();
    const bad = new FormData();
    bad.set("file", new File(["not json{"], "x.busforge.json"));
    const r1 = await handleApi(req("/api/projects/import-busforge", { method: "POST", body: bad }), state);
    expect(r1!.status).toBe(400);
    expect(((await r1!.json()) as any).error.code).toBe("BUSFORGE_INVALID");

    const r2 = await reimport(state, { busforgeExport: 999, project: { name: "x" }, devices: [], groupRanges: [], groupAddresses: [], deviceParameters: [], deviceParamBase: [], deviceLinks: [], deviceLinkBase: [], deviceModules: [] });
    expect(r2!.status).toBe(400);
    expect(((await r2!.json()) as any).error.code).toBe("BUSFORGE_VERSION_UNSUPPORTED");

    const r3 = await reimport(state, { busforgeExport: 1 }); // missing project
    expect(r3!.status).toBe(400);
    expect(((await r3!.json()) as any).error.code).toBe("BUSFORGE_INVALID");

    // A version-1 artifact missing fields importProjectExport dereferences (catalog,
    // baggage, the interface fields) must fail cleanly as 400, not crash mid-insert.
    const arrays = { devices: [], groupRanges: [], groupAddresses: [], deviceParameters: [], deviceParamBase: [], deviceLinks: [], deviceLinkBase: [], deviceModules: [] };
    for (const partial of [
      { busforgeExport: 1, project: { name: "x", interfaceIp: "", interfacePort: 3671 }, ...arrays, baggage: [] }, // no catalog
      { busforgeExport: 1, project: { name: "x", interfaceIp: "", interfacePort: 3671 }, ...arrays, catalog: {} }, // no baggage
      { busforgeExport: 1, project: { name: "x" }, ...arrays, catalog: {}, baggage: [] }, // no interface fields
    ]) {
      const r = await reimport(state, partial);
      expect(r!.status).toBe(400);
      expect(((await r!.json()) as any).error.code).toBe("BUSFORGE_INVALID");
    }
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

  test("import populates the shared app-program catalog", async () => {
    const state = freshState();
    await importConfig(state);
    const rows = state.db.query("SELECT id FROM app_programs").all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["M-TEST_A-1"]);
  });

  test("config reads from the catalog, not the source file", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    // Remove the raw .knxproj: the catalog must be self-sufficient for the config view.
    rmSync(join(state.dataDir, "projects", projectId), { recursive: true, force: true });
    const v = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    expect(paramNames(v)).toEqual(["Mode=0", "Label=hello"]);
  });

  test("config returns 404 APP_PROGRAM_MISSING when the program is in neither catalog nor file", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    state.db.exec("DELETE FROM app_programs");                                   // no catalog entry
    rmSync(join(state.dataDir, "projects", projectId), { recursive: true, force: true }); // no fallback file
    state.appCache.clear();
    const res = await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state);
    expect(res!.status).toBe(404);
    expect(((await res!.json()) as any).error.code).toBe("APP_PROGRAM_MISSING");
  });

  test("falls back to the source file and backfills the catalog (legacy projects)", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    // Simulate a project imported before DB storage: the app program lives only on
    // disk and source_file points at it, with no catalog row.
    const dir = join(state.dataDir, "projects", projectId);
    mkdirSync(dir, { recursive: true });
    const sourceFile = join(dir, "original.knxproj");
    writeFileSync(sourceFile, cfgFixture);
    state.db.exec("DELETE FROM app_programs");
    state.db.query("UPDATE projects SET source_file = ? WHERE id = ?").run(sourceFile, projectId);
    state.appCache.clear();

    const v = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    expect(paramNames(v)).toEqual(["Mode=0", "Label=hello"]);
    // The fallback backfilled the catalog so the next read hits the DB.
    expect((state.db.query("SELECT COUNT(*) AS n FROM app_programs").get() as any).n).toBe(1);
  });

  test("import writes no project files (DB is self-contained for app programs)", async () => {
    const state = freshState();
    const { projectId } = await importConfig(state);
    expect(existsSync(join(state.dataDir, "projects", projectId))).toBe(false);
  });

  test("catalog GC on delete keeps shared entries, drops orphaned ones", async () => {
    const state = freshState();
    const a = await importConfig(state);
    const b = await importConfig(state); // same fixture -> same catalog id, shared
    expect((state.db.query("SELECT COUNT(*) AS n FROM app_programs").get() as any).n).toBe(1);

    await handleApi(req(`/api/projects/${a.projectId}`, { method: "DELETE" }), state);
    expect((state.db.query("SELECT COUNT(*) AS n FROM app_programs").get() as any).n).toBe(1); // still used by b

    await handleApi(req(`/api/projects/${b.projectId}`, { method: "DELETE" }), state);
    expect((state.db.query("SELECT COUNT(*) AS n FROM app_programs").get() as any).n).toBe(0); // orphan removed
  });

  test("baggage: serves DB blobs for the device, and a deleted project cascades", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state);
    // Seed baggage as the importer would (slash-flattened, device-id prefixed).
    state.db.query("INSERT INTO device_baggage (project_id, name, data) VALUES (?, ?, ?)")
      .run(projectId, `${deviceId}_Dalie64.bin`, Buffer.from("hello"));
    state.db.query("INSERT INTO device_baggage (project_id, name, data) VALUES (?, ?, ?)")
      .run(projectId, "OTHER_x.bin", Buffer.from("nope"));

    const res = await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/baggage`), state);
    const out = (await res!.json()) as Record<string, string>;
    expect(Object.keys(out)).toEqual([`${deviceId}_Dalie64.bin`]);     // only this device's blob
    expect(Buffer.from(out[`${deviceId}_Dalie64.bin`], "base64").toString()).toBe("hello");

    await handleApi(req(`/api/projects/${projectId}`, { method: "DELETE" }), state);
    expect((state.db.query("SELECT COUNT(*) AS n FROM device_baggage").get() as any).n).toBe(0); // cascaded
  });

  test("export returns a self-contained project artifact with the referenced catalog", async () => {
    const state = freshState();
    const { projectId } = await importConfig(state);
    const res = await handleApi(req(`/api/projects/${projectId}/export`), state);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-disposition")).toContain(".busforge.json");
    const data = (await res!.json()) as any;
    expect(data.busforgeExport).toBe(1);
    expect(data.devices).toHaveLength(1);
    expect(Object.keys(data.catalog)).toEqual(["M-TEST_A-1"]); // referenced program bundled
    expect(data.catalog["M-TEST_A-1"]).toContain("<ApplicationProgram");
  });

  test("export of an unknown project -> 404", async () => {
    const res = await handleApi(req(`/api/projects/ghost/export`), freshState());
    expect(res!.status).toBe(404);
  });

  test("export backfills the catalog from the file for legacy projects", async () => {
    const state = freshState();
    const { projectId } = await importConfig(state);
    // Legacy: app program only on disk, no catalog row.
    const dir = join(state.dataDir, "projects", projectId);
    mkdirSync(dir, { recursive: true });
    const sourceFile = join(dir, "original.knxproj");
    writeFileSync(sourceFile, cfgFixture);
    state.db.exec("DELETE FROM app_programs");
    state.db.query("UPDATE projects SET source_file = ? WHERE id = ?").run(sourceFile, projectId);
    state.appCache.clear();

    const data = (await (await handleApi(req(`/api/projects/${projectId}/export`), state))!.json()) as any;
    expect(Object.keys(data.catalog)).toEqual(["M-TEST_A-1"]); // resolved from the file and bundled
  });

  test("export sanitizes the download filename (no header injection)", async () => {
    const state = freshState();
    const { projectId } = await importConfig(state);
    state.db.query("UPDATE projects SET name = ? WHERE id = ?").run('Wohn "Z"/A\r\nx', projectId);
    const cd = (await handleApi(req(`/api/projects/${projectId}/export`), state))!.headers.get("content-disposition")!;
    expect(cd).toContain('filename="Wohn_Z_A_x.busforge.json"');
    expect(cd.includes("\n")).toBe(false); // CR/LF collapsed, no header break
  });

  test("baggage falls back to the on-disk store for legacy projects", async () => {
    const state = freshState();
    const { projectId, deviceId } = await importConfig(state); // fixture has no baggage -> none in the DB
    // Simulate a project imported before DB baggage: blobs only on disk.
    const bagDir = join(state.dataDir, "projects", projectId, "baggage");
    mkdirSync(bagDir, { recursive: true });
    writeFileSync(join(bagDir, `${deviceId}_Dalie64.bin`), Buffer.from("legacy"));

    const res = await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/baggage`), state);
    const out = (await res!.json()) as Record<string, string>;
    expect(Object.keys(out)).toEqual([`${deviceId}_Dalie64.bin`]);
    expect(Buffer.from(out[`${deviceId}_Dalie64.bin`], "base64").toString()).toBe("legacy");
  });
});
