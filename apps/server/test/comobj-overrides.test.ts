import { expect, afterAll } from "bun:test";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusTest as test } from "../../../tools/corpus-test.ts";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi } from "../src/app.ts";
import { resolveComObjOverrides, placeComObjOverrides, loadApp } from "../src/deviceservice.ts";
import { parseAppConfig, buildDeviceConfig } from "@busforge/product";
import { stripRef } from "../src/refids.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function imported() {
  const dir = mkdtempSync(join(tmpdir(), "busforge-overrides-"));
  dirs.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"))], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const { id } = (await (await handleApi(new Request("http://x/api/projects/import", { method: "POST", body: form }), state))!.json()) as { id: string };
  const project = (await (await handleApi(new Request(`http://x/api/projects/${id}`), state))!.json()) as { devices: { id: string }[] };
  const deviceId = project.devices[0].id;
  // The MDT BE-02001.02's application, whose configuration activates objects at its defaults.
  state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [catalogueXml("M-0083_A-00B6-32-9642.xml.gz"), "M-TEST_A-1"]);
  const json = (r: Response | null | undefined) => r!.json() as Promise<{ id: string }>;
  const conn = await json(await handleApi(new Request("http://x/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }) }), state));
  await handleApi(new Request(`http://x/api/projects/${id}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }) }), state);
  const view = (await (await handleApi(new Request(`http://x/api/projects/${id}/devices/${deviceId}/config`), state))!.json()) as { blocks: { items: { kind: string; comObject?: { refId: string; number: number } }[] }[] };
  const objects = view.blocks.flatMap((b) => b.items).flatMap((it) => (it.kind === "comObject" && it.comObject ? [it.comObject] : []));
  const app = loadApp(state, id, deviceId)!;
  const put = (rows: { ref: string; attrs: Record<string, string> }[]) => {
    state.db.prepare("DELETE FROM device_comobj_overrides WHERE project_id = ? AND device_id = ?").run(id, deviceId);
    rows.forEach((r, seq) => state.db.prepare("INSERT INTO device_comobj_overrides (project_id, device_id, seq, com_obj_ref_id, attrs) VALUES (?, ?, ?, ?, ?)").run(id, deviceId, seq, r.ref, JSON.stringify(r.attrs)));
  };
  return { state, id, deviceId, objects, stored: (full: string) => stripRef(app.id, full), put };
}

test("the project's com-object flags reach the writes by object number; none set, none passed", async () => {
  const t = await imported();
  expect(t.objects.length).toBeGreaterThan(0);
  expect(resolveComObjOverrides(t.state, t.id, t.deviceId)).toEqual(new Map());
  const [o] = t.objects;
  t.put([{ ref: t.stored(o.refId), attrs: { ReadFlag: "Enabled", Priority: "Alert" } }]);
  expect(resolveComObjOverrides(t.state, t.id, t.deviceId)).toEqual(new Map([[o.number, { flags: { read: true }, priority: "Alert" }]]));
});

test("an override Busforge cannot place refuses the write instead of dropping it", async () => {
  const t = await imported();
  const [o] = t.objects;
  const code = () => { try { resolveComObjOverrides(t.state, t.id, t.deviceId); return null; } catch (e) { return (e as { code?: string }).code; } };
  t.put([{ ref: "O-9999_R-9999", attrs: { ReadFlag: "Enabled" } }]);
  expect(code()).toBe("COM_OBJECT_OVERRIDE_UNRESOLVED");
  t.put([{ ref: t.stored(o.refId), attrs: { ReadFlag: "Enabled" } }, { ref: t.stored(o.refId), attrs: { ReadFlag: "Disabled" } }]);
  expect(code()).toBe("COM_OBJECT_OVERRIDE_CONFLICT");
  t.put([{ ref: t.stored(o.refId), attrs: { ReadFlag: "yes" } }]);
  expect(code()).toBe("COM_OBJECT_OVERRIDE_INVALID");
  t.put([{ ref: t.stored(o.refId), attrs: { ReadFlag: "Enabled" } }, { ref: t.stored(o.refId), attrs: { ReadFlag: "Enabled" } }]);
  expect(code()).toBeNull();
});

test("two entries on one object that set different flags are merged; an inactive module instance's object is left out", async () => {
  const t = await imported();
  const [o] = t.objects;
  t.put([{ ref: t.stored(o.refId), attrs: { ReadFlag: "Enabled" } }, { ref: t.stored(o.refId), attrs: { WriteFlag: "Disabled", Priority: "High" } }]);
  expect(resolveComObjOverrides(t.state, t.id, t.deviceId)).toEqual(new Map([[o.number, { flags: { read: true, write: false }, priority: "High" }]]));
  // the MDT's module objects are MD-n_M-n_MI-n_O-…; an instance this configuration does not create
  t.put([{ ref: "MD-2_M-2_MI-99_O-3-0_R-11", attrs: { ReadFlag: "Enabled" } }]);
  expect(resolveComObjOverrides(t.state, t.id, t.deviceId)).toEqual(new Map());
});

test("the full-download route refuses an override it cannot place before anything is queued", async () => {
  const t = await imported();
  t.put([{ ref: "O-9999_R-9999", attrs: { ReadFlag: "Enabled" } }]);
  const r = await handleApi(new Request(`http://x/api/projects/${t.id}/devices/${t.deviceId}/download?dry=1`, { method: "POST" }), t.state);
  const body = (await r!.json()) as { error?: { code: string } };
  expect([r!.status, body.error?.code]).toEqual([400, "COM_OBJECT_OVERRIDE_UNRESOLVED"]);
});

// An object the configuration writes into the table but whose block the device page does not show
// (Access="None"): its override is placed, not taken for a hidden object's.
test("an override on an object the table holds but the page does not show is placed", () => {
  const cfg = parseAppConfig(catalogueXml("M-0048_A-493B-21-B471.xml.gz"));
  const view = buildDeviceConfig(cfg, new Map());
  const shown = new Set(view.blocks.flatMap((b) => b.items).flatMap((it) => (it.kind === "comObject" ? [it.comObject.refId] : [])));
  const unshown = [...view.imageComObjects.values()].find((o) => !shown.has(o.refId));
  expect(unshown).toBeDefined();
  const placed = placeComObjOverrides(cfg, view, [{ comObjRefId: stripRef(cfg.id, unshown!.refId), attrs: { ReadFlag: unshown!.flags.read ? "Disabled" : "Enabled" } }]);
  expect(placed).toEqual(new Map([[unshown!.number, { flags: { read: !unshown!.flags.read } }]]));
});
