import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip } from "@busforge/project";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { exportProject } from "../src/db/exportProject.ts";
import { importProjectExport, validateExport } from "../src/db/importProject.ts";
import { putCatalogProduct, getCatalogProduct, backfillCatalogFromDevices } from "../src/db/catalog.ts";
import { addDevice, createProject } from "../src/db/projects.ts";
import { getDeviceForFlash, replaceDeviceProduct } from "../src/db/deviceparams.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusTest } from "../../../tools/corpus-test.ts";

// Two-application hardware: a Hardware2Program that names a PEI program next to the application (the
// schema allows two ApplicationProgramRefs). No full download of Busforge loads a PEI program, the System B
// one unloads it first (rule R9), so the import records the hardware's PEI program and the full download
// is refused before anything is queued. No product of the private corpus has one: the hardware here is
// synthetic, laid over the public sample project, its device keeping its own Hardware2Program id.

const sample = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"));
const PASSWORD = "tester12";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
function fresh(): AppState {
  const dir = mkdtempSync(join(tmpdir(), "busforge-pei-"));
  tmps.push(dir);
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
type Res = { status: number; body: any };
async function call(state: AppState, path: string, init?: RequestInit): Promise<Res> {
  const r = (await handleApi(new Request(`http://x${path}`, init), state))!;
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function imported(state: AppState, bytes: Buffer): Promise<{ projectId: string; device: { id: string; appRef: string; productRef: string } }> {
  const form = new FormData();
  form.set("file", new File([bytes], "Sample.knxproj"));
  form.set("password", PASSWORD);
  const r = await call(state, "/api/projects/import", { method: "POST", body: form });
  expect(r.status).toBe(200);
  const project = await call(state, `/api/projects/${r.body.id}`);
  return { projectId: r.body.id, device: project.body.devices[0] };
}
// The sample with a Hardware.xml for its device's product, its Hardware2Program naming `programs`.
function withHardware(appRef: string, productRef: string, programs: string[]): Buffer {
  const manufacturer = appRef.split("_")[0];
  const hardware = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${manufacturer}"><Hardware>
  <Hardware Id="${appRef.split("_HP-")[0]}" Name="Two programs" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
    <Products><Product Id="${productRef}" Text="Two-application unit" OrderNumber="TWO-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="${appRef}" MediumTypes="MT-0">${programs.map((p) => `<ApplicationProgramRef RefId="${p}"/>`).join("")}</Hardware2Program></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
  return storeZip({ ...Object.fromEntries(readZip(sample)), [`${manufacturer}/Hardware.xml`]: hardware });
}
const peiColumn = (state: AppState, deviceId: string) =>
  (state.db.query("SELECT pei_program AS p FROM devices WHERE instance_id = ?").get(deviceId) as { p: number }).p;

// The sample imported once without a Hardware.xml, for its device's ids; then with the hardware.
async function pei(state: AppState, programs = 2) {
  const probe = await imported(fresh(), sample);
  const { appRef, productRef } = probe.device;
  const app = `${appRef.split("_")[0]}_A-${appRef.split("_HP-")[1]}`;
  const refs = [app, `${appRef.split("_")[0]}_A-PEI-1-0000`].slice(0, programs);
  return { ...(await imported(state, withHardware(appRef, productRef, refs))), appRef, productRef };
}

describe("hardware that carries a PEI program", () => {
  test("the import records it from the Hardware2Program, and only where it names a second program", async () => {
    const state = fresh();
    const two = await pei(state);
    expect(peiColumn(state, two.device.id)).toBe(1);
    expect(getDeviceForFlash(state.db, two.projectId, two.device.id)?.peiProgram).toBe(true);
    expect(getCatalogProduct(state.db, two.appRef, two.productRef)).toMatchObject({ hasApplication: true, peiProgram: true });

    const other = fresh();
    const one = await pei(other, 1);
    expect(peiColumn(other, one.device.id)).toBe(0);
    expect(getCatalogProduct(other.db, one.appRef, one.productRef)).toMatchObject({ hasApplication: true, peiProgram: false });
  });

  test("the full download is refused before anything is queued or the connection is even looked at", async () => {
    const state = fresh();
    const { projectId, device } = await pei(state);
    // No connection is configured: a refusal after the bus preamble would answer INTERFACE_NOT_SET.
    const r = await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(device.id)}/download`, { method: "POST" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("HARDWARE_PEI_PROGRAM_UNSUPPORTED");
    const dry = await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(device.id)}/download?dry=1`, { method: "POST" });
    expect(dry.body.error.code).toBe("HARDWARE_PEI_PROGRAM_UNSUPPORTED");
    expect((await call(state, `/api/projects/${projectId}/tasks`)).body ?? []).toEqual([]);
  });

  test("a .busforge export carries it, and its re-import keeps it and refuses the same", async () => {
    const state = fresh();
    const { projectId, device } = await pei(state);
    const data = exportProject(state.db, projectId, 2000, state.masterKey)!;
    expect(data.devices.find((d) => d.id === device.id)).toMatchObject({ peiProgram: true });
    validateExport(data);
    const target = fresh();
    importProjectExport(target.db, data, "copy", 3000, target.masterKey);
    expect(getDeviceForFlash(target.db, "copy", device.id)?.peiProgram).toBe(true);
    const r = await call(target, `/api/projects/copy/devices/${encodeURIComponent(device.id)}/download`, { method: "POST" });
    expect(r.body.error.code).toBe("HARDWARE_PEI_PROGRAM_UNSUPPORTED");
    // The catalogue rebuilt from the re-imported devices keeps it as well.
    backfillCatalogFromDevices(target.db);
    expect(getCatalogProduct(target.db, device.appRef, device.productRef)).toMatchObject({ peiProgram: true });

    const malformed = structuredClone(data);
    (malformed.devices[0] as Record<string, unknown>).peiProgram = false;
    expect(() => validateExport(malformed)).toThrow(expect.objectContaining({ code: "BUSFORGE_INVALID" }));
  });

  test("a device placed from the catalogue, or replaced by such a product, carries it", () => {
    const state = fresh();
    const product = { appRef: "M-00FA_H-1_HP-0001-01-0000", productRef: "M-00FA_H-1_P-1", appProgramId: "M-00FA_A-0001-01-0000", manufacturer: 0xfa, name: "Two", orderNumber: "T-1", hwVersion: "1", hasApplication: true, peiProgram: true };
    putCatalogProduct(state.db, product);
    createProject(state.db, "p", "P", 1000);
    const placed = addDevice(state.db, "p", product, "unit");
    expect(getDeviceForFlash(state.db, "p", placed.id)?.peiProgram).toBe(true);
    const plain = addDevice(state.db, "p", { ...product, productRef: "M-00FA_H-1_P-2", peiProgram: false }, "plain");
    expect(getDeviceForFlash(state.db, "p", plain.id)?.peiProgram).toBe(false);
    replaceDeviceProduct(state.db, "p", plain.id, product, new Map());
    expect(getDeviceForFlash(state.db, "p", plain.id)?.peiProgram).toBe(true);
    replaceDeviceProduct(state.db, "p", plain.id, { ...product, peiProgram: false }, new Map());
    expect(getDeviceForFlash(state.db, "p", plain.id)?.peiProgram).toBe(false);
  });
});

// The Theben MIX 2 application (MV-07B0) can be downloaded in full; on PEI hardware its device page withholds
// the full download with the hardware's code, and every write that would point at it points at ETS instead.
describe("hardware that carries a PEI program, with a System B application that takes a full download", () => {
  const mix2 = () => catalogueXml("M-0085_A-0072-30-69AA.xml.gz");
  async function withApp(state: AppState, programs: number) {
    const r = await pei(state, programs);
    state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [mix2(), `${r.appRef.split("_")[0]}_A-${r.appRef.split("_HP-")[1]}`]);
    return r;
  }
  const view = async (state: AppState, projectId: string, deviceId: string) =>
    (await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}/config`)).body;

  corpusTest("the device page withholds the full download with the hardware's code, where the same application offers it otherwise", async () => {
    const plain = fresh();
    const one = await withApp(plain, 1);
    const offered = await view(plain, one.projectId, one.device.id);
    expect(offered.capabilities.fullDownload).toBe(true);
    expect(offered.refusals.fullDownload).toBeUndefined();

    const state = fresh();
    const two = await withApp(state, 2);
    const withheld = await view(state, two.projectId, two.device.id);
    expect(withheld.capabilities.fullDownload).toBe(false);
    expect(withheld.refusals.fullDownload).toBe("HARDWARE_PEI_PROGRAM_UNSUPPORTED");
    expect(withheld.comObjFlagsEditable).toEqual([]);
  });

  corpusTest("a never-programmed device is pointed at ETS, not at the full download", async () => {
    const state = fresh();
    const { projectId, device } = await withApp(state, 2);
    const conn = await call(state, "/api/connections", json("POST", { type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }));
    await call(state, `/api/projects/${projectId}/connection`, json("PUT", { connectionId: conn.body.id }));
    state.db.run("UPDATE devices SET never_programmed = 1 WHERE project_id = ? AND instance_id = ?", [projectId, device.id]);
    for (const route of ["flash", "flash-ga"]) {
      const r = await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(device.id)}/${route}`, { method: "POST" });
      expect(r.body.error.code).toBe("NEVER_PROGRAMMED_USE_ETS");
    }
  });
});
