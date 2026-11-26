import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readZip, readXml0, appProgramId } from "@busforge/project";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { exportProject } from "../src/db/exportProject.ts";
import { importProjectExport, validateExport } from "../src/db/importProject.ts";
import { putCatalogProduct, getCatalogProduct, backfillCatalogFromDevices } from "../src/db/catalog.ts";
import { addDevice, createProject } from "../src/db/projects.ts";
import { getDeviceForFlash, replaceDeviceProduct, setDeviceParam } from "../src/db/deviceparams.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusTest } from "../../../tools/corpus-test.ts";
import { tempDir } from "../../../tools/test-temp.ts";

// Two-application hardware: a Hardware2Program that names a PEI program next to the application (the
// schema allows two ApplicationProgramRefs). No full download of Busforge loads a PEI program, the System B
// one unloads it first (rule R9), so the import records the hardware's PEI program and the full download
// is refused before anything is queued. The hardware here is synthetic, laid over the public sample project
// (real two-program exports of the private corpus are verified for application resolution in
// tools/hardware-applications.test.ts). Its Hardware2Program id takes the form such hardware has, carrying
// both programs' parts, so it names neither: the application is found from the ApplicationProgramRef whose
// program declares ProgramType="ApplicationProgram".

const sample = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"));
const PASSWORD = "tester12";

function fresh(): AppState {
  const dir = tempDir("busforge-pei-");
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
type Res = { status: number; body: any };
async function call(state: AppState, path: string, init?: RequestInit): Promise<Res> {
  const r = (await handleApi(new Request(`http://x${path}`, init), state))!;
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function imported(state: AppState, bytes: Buffer): Promise<{ projectId: string; device: { id: string; appRef: string; appProgramId: string; productRef: string } }> {
  const form = new FormData();
  form.set("file", new File([bytes], "Sample.knxproj"));
  form.set("password", PASSWORD);
  const r = await call(state, "/api/projects/import", { method: "POST", body: form });
  expect(r.status).toBe(200);
  const project = await call(state, `/api/projects/${r.body.id}`);
  return { projectId: r.body.id, device: project.body.devices[0] };
}
// The sample's application, its PEI program, and the Hardware2Program ids of its hardware with one program
// and with both.
const APP = "M-TEST_A-1";
const PEI = "M-TEST_A-PEI-1";
const ONE = "M-TEST_H-1_HP-1";
const TWO = "M-TEST_H-1_HP-1-PEI-1";
const PRODUCT = "M-TEST_H-1_P-1";
// The sample with a Hardware.xml for its device's product, the device on the Hardware2Program naming
// `programs` of [APP, PEI], and both programs declaring their ProgramType. The inner archive is stored
// unencrypted (the import then needs no password).
function withHardware(programs: number): Buffer {
  const appRef = programs === 2 ? TWO : ONE;
  const outer = readZip(sample);
  const hardware = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-TEST"><Hardware>
  <Hardware Id="M-TEST_H-1" Name="Two programs" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
    <Products><Product Id="${PRODUCT}" Text="Two-application unit" OrderNumber="TWO-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="${appRef}" MediumTypes="MT-0">${[APP, PEI].slice(0, programs).map((p) => `<ApplicationProgramRef RefId="${p}"/>`).join("")}</Hardware2Program></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
  const app = outer.get(`M-TEST/${APP}.xml`)!.toString("utf8");
  const typed = app.replace(`<ApplicationProgram Id="${APP}"`, `<ApplicationProgram Id="${APP}" ProgramType="ApplicationProgram"`);
  const pei = typed.replaceAll(APP, PEI).replace('ProgramType="ApplicationProgram"', 'ProgramType="PeiProgram"');
  const xml0 = readXml0(sample, PASSWORD).replace(`Hardware2ProgramRefId="${ONE}"`, `Hardware2ProgramRefId="${appRef}"`);
  expect([typed, pei, xml0]).not.toContain(app);
  return storeZip({
    ...Object.fromEntries(outer), "P-CFG.zip": storeZip({ "0.xml": xml0 }),
    "M-TEST/Hardware.xml": hardware, [`M-TEST/${APP}.xml`]: typed, [`M-TEST/${PEI}.xml`]: pei,
  });
}
const peiColumn = (state: AppState, deviceId: string) =>
  (state.db.query("SELECT pei_program AS p FROM devices WHERE instance_id = ?").get(deviceId) as { p: number }).p;

async function pei(state: AppState, programs = 2) {
  return { ...(await imported(state, withHardware(programs))), appRef: programs === 2 ? TWO : ONE, productRef: PRODUCT };
}

describe("hardware that carries a PEI program", () => {
  test("the device runs the application its Hardware2Program names, not the program the id's form would name", async () => {
    const state = fresh();
    const { projectId, device } = await pei(state);
    expect(device).toMatchObject({ appRef: TWO, appProgramId: APP });
    expect(appProgramId(TWO)).not.toBe(APP);
    expect((await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(device.id)}/config`)).status).toBe(200);
    expect(getCatalogProduct(state.db, TWO, PRODUCT)).toMatchObject({ appProgramId: APP, peiProgram: true });
    // The PEI program is no application of the device: the catalogue keeps the application only.
    expect(state.db.query("SELECT id FROM app_programs ORDER BY id").all()).toEqual([{ id: APP }]);
  });

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
    // The catalogue rebuilt from the re-imported devices keeps it as well, also on a row it held without it.
    backfillCatalogFromDevices(target.db);
    expect(getCatalogProduct(target.db, device.appRef, device.productRef)).toMatchObject({ peiProgram: true });
    target.db.run("UPDATE catalog_products SET pei_program = 0");
    backfillCatalogFromDevices(target.db);
    expect(getCatalogProduct(target.db, device.appRef, device.productRef)).toMatchObject({ peiProgram: true });

    const malformed = structuredClone(data);
    (malformed.devices[0] as Record<string, unknown>).peiProgram = false;
    expect(() => validateExport(malformed)).toThrow(expect.objectContaining({ code: "BUSFORGE_INVALID" }));
  });

  test("a catalogue row takes a PEI program from any later ingest that names one, and never loses it", () => {
    const state = fresh();
    const product = { appRef: "M-00FA_H-1_HP-0001-01-0000", productRef: "M-00FA_H-1_P-1", appProgramId: "M-00FA_A-0001-01-0000", manufacturer: 0xfa, name: "Two", orderNumber: "T-1", hwVersion: "1", hasApplication: true, peiProgram: false };
    putCatalogProduct(state.db, product);
    putCatalogProduct(state.db, { ...product, peiProgram: true });
    expect(getCatalogProduct(state.db, product.appRef, product.productRef)?.peiProgram).toBe(true);
    putCatalogProduct(state.db, product);
    putCatalogProduct(state.db, product, true);
    expect(getCatalogProduct(state.db, product.appRef, product.productRef)?.peiProgram).toBe(true);
    const pinned = { ...product, productRef: "M-00FA_H-1_P-2" };
    putCatalogProduct(state.db, pinned);
    putCatalogProduct(state.db, { ...pinned, peiProgram: true }, true);
    expect(getCatalogProduct(state.db, pinned.appRef, pinned.productRef)?.peiProgram).toBe(true);
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
  async function withApp(state: AppState, programs: number, xml = mix2()) {
    const r = await pei(state, programs);
    state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [xml, APP]);
    return r;
  }
  const connect = async (state: AppState, projectId: string) => {
    const conn = await call(state, "/api/connections", json("POST", { type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }));
    await call(state, `/api/projects/${projectId}/connection`, json("PUT", { connectionId: conn.body.id }));
  };
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
    await connect(state, projectId);
    state.db.run("UPDATE devices SET never_programmed = 1 WHERE project_id = ? AND instance_id = ?", [projectId, device.id]);
    for (const route of ["flash", "flash-ga"]) {
      const r = await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(device.id)}/${route}`, { method: "POST" });
      expect(r.body.error.code).toBe("NEVER_PROGRAMMED_USE_ETS");
    }
  });

  // P-9 at 2 activates com-objects; the MIX 2 offers no structural flash, so the change needs the full download.
  corpusTest("a change of the com-object table is pointed at ETS, where the same application points it at the full download", async () => {
    const outcome = async (programs: number) => {
      const state = fresh();
      const { projectId, device } = await withApp(state, programs);
      await connect(state, projectId);
      state.db.run("UPDATE devices SET never_programmed = 0 WHERE project_id = ? AND instance_id = ?", [projectId, device.id]);
      setDeviceParam(state.db, projectId, device.id, "M-0085_A-0072-30-69AA_P-9_R-9", "2");
      const codes: string[] = [];
      for (const route of ["flash", "flash-ga"]) codes.push((await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(device.id)}/${route}`, { method: "POST" })).body.error.code);
      expect((await call(state, `/api/projects/${projectId}/tasks`)).body).toEqual([]);
      return codes;
    };
    expect(await outcome(1)).toEqual(["COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", "COM_OBJECT_TABLE_STALE_USE_DOWNLOAD"]);
    expect(await outcome(2)).toEqual(["COM_OBJECT_TABLE_STALE_USE_ETS", "COM_OBJECT_TABLE_STALE_USE_ETS"]);
  });

  // A System 1 parameter download is its full download: on PEI hardware it is refused as well (MDT IP
  // Interface Secure, MV-0012).
  corpusTest("on System 1 the parameter download is refused and withheld as well", async () => {
    const state = fresh();
    const { projectId, device } = await withApp(state, 2, catalogueXml("M-0083_A-0138-21-F18E-O0072.xml.gz"));
    const page = await view(state, projectId, device.id);
    expect(page.capabilities.flashParams).toBe(false);
    expect(page.refusals.flashParams).toBe("HARDWARE_PEI_PROGRAM_UNSUPPORTED");
    await connect(state, projectId);
    const r = await call(state, `/api/projects/${projectId}/devices/${encodeURIComponent(device.id)}/flash`, { method: "POST" });
    expect(r.body.error.code).toBe("HARDWARE_PEI_PROGRAM_UNSUPPORTED");
  });
});
