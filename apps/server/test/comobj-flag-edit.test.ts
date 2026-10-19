import { test as plainTest, expect, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusTest as test } from "../../../tools/corpus-test.ts";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { getDeviceComObjOverrides } from "../src/db/deviceparams.ts";

// Editing a com-object's flags and priority on the device page: the bits offered are the ones the
// family's full download writes; an edit is stored as ETS stores it and counts as a change until a
// write that authors the com-object table carries it.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jreq = (path: string, method: string, body: unknown) =>
  req(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const j = async (res: Response | null) => (await res!.json()) as any;
const objects = (v: any) => v.blocks.flatMap((b: any) => b.items).filter((i: any) => i.kind === "comObject").map((i: any) => i.comObject);

async function setup(appFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), "busforge-flagedit-"));
  dirs.push(dir);
  const state: AppState = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"))], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const { id } = await j(await handleApi(req("/api/projects/import", { method: "POST", body: form }), state));
  const deviceId = (await j(await handleApi(req(`/api/projects/${id}`), state))).devices[0].id as string;
  if (appFile) state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [catalogueXml(appFile), "M-TEST_A-1"]);
  const conn = await j(await handleApi(jreq("/api/connections", "POST", { type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }), state));
  await handleApi(jreq(`/api/projects/${id}/connection`, "PUT", { connectionId: conn.id }), state);
  // the device holds this project's configuration
  state.db.run("UPDATE devices SET never_programmed = 0 WHERE project_id = ?", [id]);
  const base = `/api/projects/${id}/devices/${encodeURIComponent(deviceId)}`;
  const view = async () => j(await handleApi(req(`${base}/config`), state));
  const edit = (body: unknown) => handleApi(jreq(`${base}/comobject-flags`, "PUT", body), state);
  return { state, id, deviceId, base, view, edit };
}

plainTest("a family whose full download cannot write the com-object table offers no flag to edit and refuses an edit", async () => {
  const s = await setup();
  // Mode=1 shows the sample's one com-object
  await handleApi(jreq(`${s.base}/params`, "PUT", { paramRefId: "M-TEST_A-1_P-1_R-1", value: "1" }), s.state);
  const v = await s.view();
  expect(v.comObjFlagsEditable).toEqual([]);
  const [o] = objects(v);
  expect(o.priority).toBeDefined();
  const r = await s.edit({ comObjRefId: o.refId, flags: { read: true } });
  expect(r!.status).toBe(400);
  expect((await j(r)).error.code).toBe("COM_OBJECT_FLAG_NOT_EDITABLE");
  expect(getDeviceComObjOverrides(s.state.db, s.id, s.deviceId)).toEqual([]);
});

test("System 7 (MDT BE-02001.02): every flag but read-on-init and the priority are offered; an edit counts as a change and reverts", async () => {
  const s = await setup("M-0083_A-00B6-32-9642.xml.gz");
  const v = await s.view();
  expect(v.comObjFlagsEditable).toEqual(["read", "write", "comm", "transmit", "update", "priority"]);
  const [o] = objects(v);
  expect(o.flagsChanged).toBe(false);
  const r = await s.edit({ comObjRefId: o.refId, flags: { read: !o.flags.read }, priority: "Alert" });
  expect(r!.status).toBe(200);
  const after = objects(await j(r)).find((x: any) => x.refId === o.refId);
  expect(after.flags.read).toBe(!o.flags.read);
  expect(after.priority).toBe("Alert");
  expect(after.overriddenFlags).toEqual(["read"]);
  expect(after.overriddenPriority).toBe(o.priority !== "Alert");
  expect(after.flagsChanged).toBe(true);
  const project = await j(await handleApi(req(`/api/projects/${s.id}`), s.state));
  expect(project.devices[0].changes.flags).toBe(1);
  // a flag the family's download cannot write is refused, nothing stored
  const bad = await s.edit({ comObjRefId: o.refId, flags: { readOnInit: !o.flags.readOnInit } });
  expect((await j(bad)).error.code).toBe("COM_OBJECT_FLAG_NOT_EDITABLE");
  // set back to the application's: unchanged again, and no row left
  const back = await s.edit({ comObjRefId: o.refId, flags: { read: null }, priority: null });
  expect(objects(await j(back)).find((x: any) => x.refId === o.refId).flagsChanged).toBe(false);
  expect(getDeviceComObjOverrides(s.state.db, s.id, s.deviceId)).toEqual([]);
  // the per-object revert
  await s.edit({ comObjRefId: o.refId, flags: { write: !o.flags.write } });
  const rv = await handleApi(jreq(`${s.base}/revert-comobject-flags`, "POST", { comObjRefId: o.refId }), s.state);
  expect(objects(await j(rv)).find((x: any) => x.refId === o.refId).flagsChanged).toBe(false);
});

test("malformed edits and unknown objects are refused", async () => {
  const s = await setup("M-0083_A-00B6-32-9642.xml.gz");
  const [o] = objects(await s.view());
  for (const body of [{ comObjRefId: o.refId, flags: { read: "yes" } }, { comObjRefId: o.refId, priority: "Urgent" }, { comObjRefId: o.refId, flags: { bogus: true } }, { flags: { read: true } }]) {
    expect((await j(await s.edit(body))).error.code).toBe("COMOBJ_FLAGS_INVALID");
  }
  expect((await j(await s.edit({ comObjRefId: "M-TEST_A-1_O-999_R-999", flags: { read: true } }))).error.code).toBe("COMOBJ_NOT_FOUND");
});

test("System B (Jung 400021SE): every flag and the priority are offered", async () => {
  const s = await setup("M-0004_A-7072-21-99A7-O000A.xml.gz");
  expect((await s.view()).comObjFlagsEditable).toEqual(["read", "write", "comm", "transmit", "update", "readOnInit", "priority"]);
}, 60_000);
