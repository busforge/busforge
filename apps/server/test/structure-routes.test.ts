import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi, type AppState } from "../src/app.ts";

// HTTP route-glue tests for the structural-edit routes (groups.ts, spaces.ts,
// devices.ts link/revert endpoints, deviceops.ts task cancel). The db functions
// behind them are covered in group-edit.test.ts / spaces.test.ts; here the
// contract under test is the HTTP layer: status codes, error codes, body shape,
// and that mutations actually land in the persisted projection.

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));

// sample-config.knxproj contents (see sample-config-0.xml + M-TEST_A-1.xml):
// one device P-CFG-0_DI-1 (ia 1.1.10), one main range "Light" (rangeStart 1) holding
// GA raw 1 "L1", no locations. Param M-TEST_A-1_P-1_R-1 (Mode) is instance-seeded to
// "0" (live + baseline rows); the app default is "1", and Mode=1 exposes the single
// com-object M-TEST_A-1_O-1_R-1.
const PARAM = "M-TEST_A-1_P-1_R-1";
const COMOBJ = "M-TEST_A-1_O-1_R-1";

const tmps: string[] = [];
function freshState(): AppState {
  const dir = mkdtempSync(join(tmpdir(), "busforge-structure-"));
  tmps.push(dir);
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jreq = (path: string, method: string, body: unknown) =>
  req(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const j = async (res: Response | null) => (await res!.json()) as any;
const getProj = async (state: AppState, id: string) => j(await handleApi(req(`/api/projects/${id}`), state));
const snapshots = async (state: AppState, id: string) => j(await handleApi(req(`/api/projects/${id}/snapshots`), state));

async function importConfig() {
  const state = freshState();
  const form = new FormData();
  form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const imp = await j(await handleApi(req("/api/projects/import", { method: "POST", body: form }), state));
  const proj = await getProj(state, imp.id);
  return { state, projectId: imp.id as string, deviceId: proj.devices[0].id as string, rangeId: Number(proj.groupRanges[0].id) };
}

// Pull one item out of a device-config view returned by the param/link/revert routes.
const viewParam = (v: any, refId: string) =>
  v.blocks.flatMap((b: any) => b.items).find((i: any) => i.kind === "param" && i.param.refId === refId)?.param;
const viewComObj = (v: any, refId: string) =>
  v.blocks.flatMap((b: any) => b.items).find((i: any) => i.kind === "comObject" && i.comObject.refId === refId)?.comObject;

const setMode = (state: AppState, projectId: string, deviceId: string, value: string) =>
  handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/params`, "PUT", { paramRefId: PARAM, value }), state);
const putLink = (state: AppState, projectId: string, deviceId: string, comObjRefId: string, gaRaws: number[]) =>
  handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/links`, "PUT", { comObjRefId, gaRaws }), state);

describe("group-range routes", () => {
  test("create main + middle range -> 201, both persist in the projection", async () => {
    const { state, projectId } = await importConfig();
    const res = (await handleApi(jreq(`/api/projects/${projectId}/group-ranges`, "POST", { parentId: null, name: "Beschattung", number: 1 }), state))!;
    expect(res.status).toBe(201);
    const main = ((await res.json()) as any).groupRanges.find((r: any) => r.name === "Beschattung");
    expect(main).toMatchObject({ rangeStart: 2048, rangeEnd: 4095 }); // main 1 spans one 2^11 block
    const mid = (await handleApi(jreq(`/api/projects/${projectId}/group-ranges`, "POST", { parentId: Number(main.id), name: "Fahren", number: 0 }), state))!;
    expect(mid.status).toBe(201);
    // Re-GET rather than trusting the mutation response: the write must be persisted.
    const proj = await getProj(state, projectId);
    expect(proj.groupRanges.find((r: any) => r.name === "Beschattung").children[0]).toMatchObject({ name: "Fahren", rangeStart: 2048, rangeEnd: 2303 });
  });

  test("create without a number -> 400 GA_NUMBER_INVALID", async () => {
    const { state, projectId } = await importConfig();
    const res = (await handleApi(jreq(`/api/projects/${projectId}/group-ranges`, "POST", { parentId: null, name: "X" }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("GA_NUMBER_INVALID");
  });

  test("rename persists; unknown range -> 404 GA_RANGE_NOT_FOUND", async () => {
    const { state, projectId, rangeId } = await importConfig();
    const ok = (await handleApi(jreq(`/api/projects/${projectId}/group-ranges/${rangeId}`, "PATCH", { name: "Licht neu" }), state))!;
    expect(ok.status).toBe(200);
    expect((await getProj(state, projectId)).groupRanges[0].name).toBe("Licht neu");
    const missing = (await handleApi(jreq(`/api/projects/${projectId}/group-ranges/999999`, "PATCH", { name: "X" }), state))!;
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("GA_RANGE_NOT_FOUND");
  });

  test("delete removes the range + its GAs and captures an undo snapshot; unknown -> 404", async () => {
    const { state, projectId, rangeId } = await importConfig();
    const res = (await handleApi(req(`/api/projects/${projectId}/group-ranges/${rangeId}`, { method: "DELETE" }), state))!;
    expect(res.status).toBe(200);
    const proj = await getProj(state, projectId);
    expect(proj.groupRanges).toHaveLength(0);
    expect(proj.gaCount).toBe(0); // the GA under the range went with it
    // Destructive edits must leave a restore point (routes create it pre-delete).
    expect(await snapshots(state, projectId)).toMatchObject([{ kind: "auto", reason: "before-ga-edit" }]);
    const again = (await handleApi(req(`/api/projects/${projectId}/group-ranges/${rangeId}`, { method: "DELETE" }), state))!;
    expect(again.status).toBe(404);
    expect(((await again.json()) as any).error.code).toBe("GA_RANGE_NOT_FOUND");
  });

  test("impact endpoints count live links onto the affected GAs", async () => {
    const { state, projectId, deviceId, rangeId } = await importConfig();
    // Mode=1 exposes the com-object; link it to GA raw 1 so the counts are non-zero.
    await setMode(state, projectId, deviceId, "1");
    await putLink(state, projectId, deviceId, COMOBJ, [1]);
    const range = (await handleApi(req(`/api/projects/${projectId}/group-ranges/${rangeId}/impact`), state))!;
    expect(range.status).toBe(200);
    expect(await range.json()).toEqual({ links: 1 });
    const ga = (await handleApi(req(`/api/projects/${projectId}/group-addresses/1/impact`), state))!;
    expect(ga.status).toBe(200);
    expect(await ga.json()).toEqual({ links: 1 });
  });
});

describe("group-address routes", () => {
  test("create in a leaf range -> 201 with derived raw/address, persists", async () => {
    const { state, projectId, rangeId } = await importConfig();
    // "Light" starts at raw 1, so sub 2 lands on raw 2 in the 3-level grid.
    const res = (await handleApi(jreq(`/api/projects/${projectId}/group-addresses`, "POST", { rangeId, sub: 2, name: "L2", dpt: "1.001" }), state))!;
    expect(res.status).toBe(201);
    const proj = await getProj(state, projectId);
    expect(proj.gaCount).toBe(2);
    expect(proj.groupRanges[0].addresses.find((a: any) => a.raw === 2)).toMatchObject({ address: "0/0/2", name: "L2", dpt: "1.001" });
  });

  test("create without rangeId/sub -> 400 GA_FIELDS_REQUIRED", async () => {
    const { state, projectId } = await importConfig();
    const res = (await handleApi(jreq(`/api/projects/${projectId}/group-addresses`, "POST", { name: "X" }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("GA_FIELDS_REQUIRED");
  });

  test("edit name+dpt persists; unknown raw -> 404 GA_NOT_FOUND", async () => {
    const { state, projectId } = await importConfig();
    const ok = (await handleApi(jreq(`/api/projects/${projectId}/group-addresses/1`, "PATCH", { name: "Neu", dpt: "1.002" }), state))!;
    expect(ok.status).toBe(200);
    expect((await getProj(state, projectId)).groupRanges[0].addresses[0]).toMatchObject({ raw: 1, name: "Neu", dpt: "1.002" });
    const missing = (await handleApi(jreq(`/api/projects/${projectId}/group-addresses/999`, "PATCH", { name: "X" }), state))!;
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("GA_NOT_FOUND");
  });

  test("delete removes the GA and captures an undo snapshot; unknown -> 404", async () => {
    const { state, projectId } = await importConfig();
    const res = (await handleApi(req(`/api/projects/${projectId}/group-addresses/1`, { method: "DELETE" }), state))!;
    expect(res.status).toBe(200);
    expect((await getProj(state, projectId)).gaCount).toBe(0);
    expect(await snapshots(state, projectId)).toMatchObject([{ kind: "auto", reason: "before-ga-edit" }]);
    const again = (await handleApi(req(`/api/projects/${projectId}/group-addresses/1`, { method: "DELETE" }), state))!;
    expect(again.status).toBe(404);
    expect(((await again.json()) as any).error.code).toBe("GA_NOT_FOUND");
  });
});

describe("space routes", () => {
  test("create root + child space -> 201, tree persists", async () => {
    const { state, projectId } = await importConfig(); // fixture has no locations
    const res = (await handleApi(jreq(`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: "Building", name: "Haus" }), state))!;
    expect(res.status).toBe(201);
    const building = ((await res.json()) as any).locations[0];
    expect(building).toMatchObject({ type: "Building", name: "Haus" });
    const child = (await handleApi(jreq(`/api/projects/${projectId}/spaces`, "POST", { parentId: Number(building.id), type: "Floor", name: "EG" }), state))!;
    expect(child.status).toBe(201);
    expect((await getProj(state, projectId)).locations[0].children[0]).toMatchObject({ type: "Floor", name: "EG" });
  });

  test("create without a type -> 400 SPACE_FIELDS_REQUIRED", async () => {
    const { state, projectId } = await importConfig();
    const res = (await handleApi(jreq(`/api/projects/${projectId}/spaces`, "POST", { parentId: null, name: "X" }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("SPACE_FIELDS_REQUIRED");
  });

  test("rename persists; unknown space -> 404 SPACE_NOT_FOUND", async () => {
    const { state, projectId } = await importConfig();
    const created = await j(await handleApi(jreq(`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: "Building", name: "Haus" }), state));
    const spaceId = Number(created.locations[0].id);
    const ok = (await handleApi(jreq(`/api/projects/${projectId}/spaces/${spaceId}`, "PATCH", { name: "Halle" }), state))!;
    expect(ok.status).toBe(200);
    expect((await getProj(state, projectId)).locations[0].name).toBe("Halle");
    const missing = (await handleApi(jreq(`/api/projects/${projectId}/spaces/9999`, "PATCH", { name: "X" }), state))!;
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("SPACE_NOT_FOUND");
  });

  test("delete removes the subtree, keeps the devices, snapshots first; unknown -> 404", async () => {
    const { state, projectId } = await importConfig();
    const created = await j(await handleApi(jreq(`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: "Building", name: "Haus" }), state));
    const spaceId = Number(created.locations[0].id);
    const res = (await handleApi(req(`/api/projects/${projectId}/spaces/${spaceId}`, { method: "DELETE" }), state))!;
    expect(res.status).toBe(200);
    const proj = await getProj(state, projectId);
    expect(proj.locations).toHaveLength(0);
    expect(proj.devices).toHaveLength(1); // devices survive the space delete
    expect(await snapshots(state, projectId)).toMatchObject([{ kind: "auto", reason: "before-space-edit" }]);
    const again = (await handleApi(req(`/api/projects/${projectId}/spaces/${spaceId}`, { method: "DELETE" }), state))!;
    expect(again.status).toBe(404);
    expect(((await again.json()) as any).error.code).toBe("SPACE_NOT_FOUND");
  });

  test("device space assignment: assign, impact, unassign; unknown space -> 404 SPACE_ASSIGN_FAILED", async () => {
    const { state, projectId, deviceId } = await importConfig();
    const created = await j(await handleApi(jreq(`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: "Room", name: "Küche" }), state));
    const roomId = Number(created.locations[0].id);
    const put = (await handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/space`, "PUT", { spaceId: roomId }), state))!;
    expect(put.status).toBe(200);
    expect((await getProj(state, projectId)).locations[0].deviceIds).toEqual([deviceId]);
    // Impact preview counts the devices a delete would unassign.
    const impact = (await handleApi(req(`/api/projects/${projectId}/spaces/${roomId}/impact`), state))!;
    expect(impact.status).toBe(200);
    expect(await impact.json()).toEqual({ devices: 1 });
    const clear = (await handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/space`, "PUT", { spaceId: null }), state))!;
    expect(clear.status).toBe(200);
    expect((await getProj(state, projectId)).locations[0].deviceIds).toEqual([]);
    const bad = (await handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/space`, "PUT", { spaceId: 9999 }), state))!;
    expect(bad.status).toBe(404);
    expect(((await bad.json()) as any).error.code).toBe("SPACE_ASSIGN_FAILED");
  });
});

describe("device rename route", () => {
  const rename = (state: AppState, projectId: string, deviceId: string, name: unknown) =>
    handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}`, "PATCH", { name }), state);

  test("PATCH renames the device and persists it", async () => {
    const { state, projectId, deviceId } = await importConfig();
    const res = (await rename(state, projectId, deviceId, "  Bathroom controller  "))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: deviceId, name: "Bathroom controller" }); // trimmed
    expect((await getProj(state, projectId)).devices[0].name).toBe("Bathroom controller");
  });

  test("a blank name -> 400 DEVICE_NAME_REQUIRED, the old name stands", async () => {
    const { state, projectId, deviceId } = await importConfig();
    const before = (await getProj(state, projectId)).devices[0].name;
    const res = (await rename(state, projectId, deviceId, "   "))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("DEVICE_NAME_REQUIRED");
    expect((await getProj(state, projectId)).devices[0].name).toBe(before);
  });

  test("a non-string name -> 400 DEVICE_NAME_REQUIRED, not a 500", async () => {
    const { state, projectId, deviceId } = await importConfig();
    for (const bogus of [42, true, ["x"], {}, null]) {
      const res = (await rename(state, projectId, deviceId, bogus))!;
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe("DEVICE_NAME_REQUIRED");
    }
  });

  test("an unknown device -> 404 DEVICE_NOT_FOUND", async () => {
    const { state, projectId } = await importConfig();
    const res = (await rename(state, projectId, "ghost", "Anything"))!;
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("DEVICE_NOT_FOUND");
  });

  test("an unknown project -> 404 PROJECT_NOT_FOUND, not DEVICE_NOT_FOUND", async () => {
    const { state, deviceId } = await importConfig();
    const res = (await rename(state, "nosuch", deviceId, "Anything"))!;
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("renaming leaves the configuration alone: no drift, no baseline move", async () => {
    const { state, projectId, deviceId } = await importConfig();
    await rename(state, projectId, deviceId, "Renamed");
    expect((await getProj(state, projectId)).devices[0].changes).toEqual({ params: 0, links: 0, neverProgrammed: false });
  });
});

describe("device link + revert routes", () => {
  test("PUT links re-points the com-object and shows as drift", async () => {
    const { state, projectId, deviceId } = await importConfig();
    await setMode(state, projectId, deviceId, "1"); // com-object only visible with Mode=1
    const res = (await putLink(state, projectId, deviceId, COMOBJ, [1]))!;
    expect(res.status).toBe(200);
    // The link baseline is empty (fixture has no seeded links), so this counts as drift.
    expect(viewComObj(await res.json(), COMOBJ)).toMatchObject({ gaRaw: 1, changed: true });
    const again = await j(await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state));
    expect(viewComObj(again, COMOBJ)).toMatchObject({ gaRaw: 1, changed: true }); // persisted
    expect((await getProj(state, projectId)).devices[0].changes.links).toBe(1);
  });

  test("PUT links with a bogus com-object ref -> 400 COMOBJ_NOT_FOUND, nothing stored", async () => {
    const { state, projectId, deviceId } = await importConfig();
    await setMode(state, projectId, deviceId, "1");
    const res = (await putLink(state, projectId, deviceId, "M-TEST_A-1_O-99_R-99", [1]))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("COMOBJ_NOT_FOUND");
    expect((await getProj(state, projectId)).devices[0].changes.links).toBe(0);
  });

  test("revert-param restores the baseline value and clears the marker; missing ref -> 400", async () => {
    const { state, projectId, deviceId } = await importConfig();
    await setMode(state, projectId, deviceId, "1"); // baseline is the seeded "0", so this is drift
    expect((await getProj(state, projectId)).devices[0].changes.params).toBe(1);
    const res = (await handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/revert-param`, "POST", { paramRefId: PARAM }), state))!;
    expect(res.status).toBe(200);
    expect(viewParam(await res.json(), PARAM)).toMatchObject({ value: "0", changed: false });
    expect((await getProj(state, projectId)).devices[0].changes.params).toBe(0);
    const bad = (await handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/revert-param`, "POST", {}), state))!;
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("PARAM_REF_REQUIRED");
  });

  test("revert-link drops the unprogrammed link; missing ref -> 400", async () => {
    const { state, projectId, deviceId } = await importConfig();
    await setMode(state, projectId, deviceId, "1");
    await putLink(state, projectId, deviceId, COMOBJ, [1]);
    expect((await getProj(state, projectId)).devices[0].changes.links).toBe(1);
    const res = (await handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/revert-link`, "POST", { comObjRefId: COMOBJ }), state))!;
    expect(res.status).toBe(200);
    // The link baseline is empty, so reverting removes the link entirely.
    expect(viewComObj(await res.json(), COMOBJ)).toMatchObject({ gaRaw: null, changed: false });
    expect((await getProj(state, projectId)).devices[0].changes.links).toBe(0);
    const bad = (await handleApi(jreq(`/api/projects/${projectId}/devices/${deviceId}/revert-link`, "POST", {}), state))!;
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("COMOBJ_REF_REQUIRED");
  });

  test("revert discards all of a device's edits; unknown device -> 404 DEVICE_NOT_FOUND", async () => {
    const { state, projectId, deviceId } = await importConfig();
    await setMode(state, projectId, deviceId, "1");
    await putLink(state, projectId, deviceId, COMOBJ, [1]);
    expect((await getProj(state, projectId)).devices[0].changes).toEqual({ params: 1, links: 1, neverProgrammed: false });
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/revert`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    expect(viewParam(await res.json(), PARAM)).toMatchObject({ value: "0", changed: false });
    expect((await getProj(state, projectId)).devices[0].changes).toEqual({ params: 0, links: 0, neverProgrammed: false });
    const bad = (await handleApi(req(`/api/projects/${projectId}/devices/ghost/revert`, { method: "POST" }), state))!;
    expect(bad.status).toBe(404);
    expect(((await bad.json()) as any).error.code).toBe("DEVICE_NOT_FOUND");
  });
});

describe("non-string text fields", () => {
  // Every route that reads a name/label/type/password used to call String.trim on whatever the
  // client sent. A number or an object threw, and the catch-all turned that into a 500 whose
  // message echoed handler source back to the caller. httputil's text() now reads a non-string
  // as absent, so these routes answer with their own contract instead.
  test("a number, an object or an array never reaches String.trim", async () => {
    const { state, projectId, deviceId, rangeId } = await importConfig();
    const space = await j(await handleApi(jreq(`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: "Building", name: "Haus" }), state));
    const spaceId = Number(space.locations[0].id);

    // Listing the catalog is what backfills it from the imported devices; without this call the
    // placement below answers CATALOG_PRODUCT_NOT_FOUND and never reaches the name.
    await handleApi(req("/api/catalog/products"), state);
    const product = (await getProj(state, projectId)).devices[0];

    const calls: [string, string, unknown][] = [
      ["/api/projects", "POST", { name: 42 }],
      [`/api/projects/${projectId}`, "PATCH", { name: {} }],
      [`/api/projects/${projectId}/snapshots`, "POST", { label: 42 }],
      [`/api/projects/${projectId}/export`, "POST", { password: 42 }],
      [`/api/projects/${projectId}/group-ranges`, "POST", { parentId: null, name: 42, number: 1 }],
      [`/api/projects/${projectId}/group-ranges/${rangeId}`, "PATCH", { name: ["x"] }],
      [`/api/projects/${projectId}/group-addresses`, "POST", { rangeId, sub: 5, name: 42, dpt: {} }],
      [`/api/projects/${projectId}/group-addresses/1`, "PATCH", { name: 42, dpt: true }],
      [`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: 42 }],
      // A valid type, so text(body.name) is actually reached.
      [`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: "Room", name: 42 }],
      [`/api/projects/${projectId}/spaces/${spaceId}`, "PATCH", { name: 42 }],
      // Real refs, else the handler answers CATALOG_PRODUCT_NOT_FOUND before it reads the name.
      [`/api/projects/${projectId}/devices`, "POST", { appRef: product.appRef, productRef: product.productRef, name: 42 }],
      [`/api/projects/${projectId}/devices/${deviceId}`, "PATCH", { name: 42 }],
    ];
    for (const [path, method, body] of calls) {
      const res = (await handleApi(jreq(path, method, body), state))!;
      // Reported as a pair so a failure names the offending route.
      expect({ path, serverError: res.status >= 500 }).toEqual({ path, serverError: false });
    }
  });

  test("where a text field is mandatory, a non-string is refused like a missing one", async () => {
    const { state, projectId } = await importConfig();
    const cases: [string, string, unknown, string][] = [
      ["/api/projects", "POST", { name: 42 }, "PROJECT_NAME_REQUIRED"],
      [`/api/projects/${projectId}`, "PATCH", { name: {} }, "PROJECT_NAME_REQUIRED"],
      [`/api/projects/${projectId}/spaces`, "POST", { parentId: null, type: 42 }, "SPACE_FIELDS_REQUIRED"],
      // Not "treated as absent": an unreadable password must never yield an unencrypted export.
      [`/api/projects/${projectId}/export`, "POST", { password: 42 }, "EXPORT_PASSWORD_INVALID"],
    ];
    for (const [path, method, body, code] of cases) {
      const res = (await handleApi(jreq(path, method, body), state))!;
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
      expect(((await res.json()) as any).error.code).toBe(code);
    }
  });
});

describe("task cancel route", () => {
  test("cancelling an unknown task -> 404 TASK_NOT_FOUND", async () => {
    const { state, projectId } = await importConfig();
    const res = (await handleApi(req(`/api/projects/${projectId}/tasks/ghost/cancel`, { method: "POST" }), state))!;
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("TASK_NOT_FOUND");
  });
});
