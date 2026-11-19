import { test, expect, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi } from "../src/app.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { parseProject } from "@busforge/project";
import { openDb } from "../src/db/schema.ts";
import { insertProject } from "../src/db/projects.ts";
import { exportProject } from "../src/db/exportProject.ts";
import { importProjectExport } from "../src/db/importProject.ts";
import { getDeviceKnxIp } from "../src/db/deviceparams.ts";

// What an import (.knxproj or .busforge) keeps of the keys a project holds. Synthetic keys and passwords only.
const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const xml0 = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-0.xml"), "utf8");

async function importXml(xml: string) {
  const dir = mkdtempSync(join(tmpdir(), "busforge-import-keys-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([storeZip({ "P-TEST/0.xml": xml })], "keys.knxproj"));
  const res = (await handleApi(new Request("http://x/api/projects/import", { method: "POST", body: form }), state))!;
  return { state, body: (await res.json()) as Record<string, unknown> };
}

test("a secure device ETS never commissioned is counted, and its tool key stays out of the key store", async () => {
  const { state, body } = await importXml(xml0.replace(
    'Hardware2ProgramRefId="M-0048_H-1_HP-1">',
    'Hardware2ProgramRefId="M-0048_H-1_HP-1"><Security ToolKey="AAECAwQFBgcICQoLDA0ODw==" DeviceAuthenticationCode="synthauth" />',
  ));
  expect(body.secureDevicesWithoutSerial).toBe(1);
  expect(body.secretsNotImported).toBe(1);
  expect((state.db.query("SELECT COUNT(*) AS n FROM device_security WHERE project_id = ?").get(body.id as string) as { n: number }).n).toBe(0);
  expect(JSON.stringify(body)).not.toContain("AAECAwQFBgcICQoLDA0ODw==");
  expect(JSON.stringify(body)).not.toContain("synthauth");
});

test("a .busforge artifact that carries installation keys in a device's KNXnet/IP settings is stored without them", () => {
  // Synthetic backbone and BCU key, as an artifact made by hand could carry them.
  const db = openDb(":memory:");
  const xml = xml0.replace('Hardware2ProgramRefId="M-0048_H-1_HP-1">', 'Hardware2ProgramRefId="M-0048_H-1_HP-1"><IPConfig Assign="Fixed" IPAddress="192.0.2.2" />');
  insertProject(db, "p1", parseProject(xml, undefined, "Demo"), "", 1000, new Set(), new Set());
  const MK = Buffer.alloc(32, 7);
  const data = exportProject(db, "p1", 5, MK)!;
  expect(data.deviceKnxIp).toHaveLength(1);
  const [knxIp] = data.deviceKnxIp!;
  knxIp.installation = { ...knxIp.installation, BCUKey: "305419896", IPRoutingBackboneKey: "c3ludGhldGljLWJhY2tib25l" };
  importProjectExport(db, data, "p2", 6, MK);
  const settings = getDeviceKnxIp(db, "p2", knxIp.deviceId)!;
  expect(settings.installation).toMatchObject({ BCUKey: "", IPRoutingBackboneKey: "" });
});
