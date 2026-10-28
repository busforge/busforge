import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";

// A product whose Hardware2Program names no application program takes its individual address and
// nothing else, as ETS shows it (Adr/Prg/Par/Grp/Cfg "–", programming offers the address only). The
// shape is ETS's export of the Hager TH001 RS 232 interface: the hardware claims
// HasApplicationProgram="true", the Hardware2Program carries no ApplicationProgramRef, the
// DeviceInstance has IndividualAddressLoaded and no other Loaded flag.
const M = "M-0009";
const HP = `${M}_H-9.20.2F.2F.20TH001-1_HP`;
const PRODUCT = `${M}_H-9.20.2F.2F.20TH001-1_P-TH001`;
const hardware = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="${M}"><Hardware>
  <Hardware Id="${M}_H-9.20.2F.2F.20TH001-1" Name="TH001 RS 232 modulaire" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
    <Products><Product Id="${PRODUCT}" Text="Modular RS 232" OrderNumber="TH001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${HP}" MediumTypes="MT-0"><RegistrationInfo RegistrationStatus="Registered"/></Hardware2Program></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
const project = (loaded: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><Project Id="P-0001"><Installations><Installation Name="">
  <Topology><Area Id="P-0001-0_A-1" Address="1"><Line Id="P-0001-0_L-1" Address="2"><Segment Id="P-0001-0_S-1" Number="0" MediumTypeRefId="MT-0">
    <DeviceInstance Id="P-0001-0_DI-1" Address="3" Name="" ProductRefId="${PRODUCT}" Hardware2ProgramRefId="${HP}" ${loaded}/>
  </Segment></Line></Area></Topology>
</Installation></Installations></Project></KNX>`;
const knxproj = (loaded = `IndividualAddressLoaded="true" MediumConfigLoaded="true"`) =>
  storeZip({ [`${M}/Hardware.xml`]: hardware, "P-0001/0.xml": project(loaded) });
const DEVICE = "P-0001-0_DI-1";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
function fresh(): AppState {
  const dir = mkdtempSync(join(tmpdir(), "busforge-noapp-"));
  tmps.push(dir);
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
type Res = { status: number; body: any };
async function call(state: AppState, path: string, init?: RequestInit): Promise<Res> {
  const r = (await handleApi(new Request(`http://x${path}`, init), state))!;
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fileForm = (bytes: Buffer, name: string) => { const f = new FormData(); f.set("file", new File([bytes], name)); return { method: "POST", body: f }; };
async function imported(state: AppState, bytes = knxproj()): Promise<{ id: string; result: any }> {
  const r = await call(state, "/api/projects/import", fileForm(bytes, "TH001.knxproj"));
  expect(r.status).toBe(200);
  return { id: r.body.id, result: r.body };
}

describe("a product without an application program", () => {
  test("imports without an import gap, programmed where ETS loaded its address", async () => {
    const state = fresh();
    const analyzed = await call(state, "/api/projects/analyze", fileForm(knxproj(), "TH001.knxproj"));
    expect(analyzed.body.devicesWithoutProgram).toEqual([]);
    const { id, result } = await imported(state);
    expect(result.devicesWithoutProgram).toEqual([]);
    const dev = (await call(state, `/api/projects/${id}`)).body.devices[0];
    expect(dev).toMatchObject({ id: DEVICE, ia: "1.2.3", hasApplication: false, changes: { neverProgrammed: false } });
  });

  test("is never programmed where ETS did not load its address", async () => {
    const state = fresh();
    const { id } = await imported(state, knxproj(""));
    expect((await call(state, `/api/projects/${id}`)).body.devices[0].changes.neverProgrammed).toBe(true);
  });

  test("every operation on its application refuses with DEVICE_WITHOUT_APPLICATION", async () => {
    const state = fresh();
    const { id } = await imported(state);
    const conn = (await call(state, "/api/connections", post({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }))).body;
    await call(state, `/api/projects/${id}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }) });
    for (const [path, init] of [
      ["config", undefined], ["read-back", { method: "POST" }], ["flash?dry=1", { method: "POST" }], ["flash", { method: "POST" }],
      ["flash-ga?dry=1", { method: "POST" }], ["download?dry=1", { method: "POST" }], ["download", { method: "POST" }],
    ] as [string, RequestInit | undefined][]) {
      const r = await call(state, `/api/projects/${id}/devices/${DEVICE}/${path}`, init);
      expect([path, r.status, r.body.error.code]).toEqual([path, 409, "DEVICE_WITHOUT_APPLICATION"]);
    }
  });

  test("its configuration edits refuse and store nothing", async () => {
    const state = fresh();
    const { id } = await imported(state);
    const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const [path, init] of [
      ["params", put({ refId: "M-0009_A-1_P-1_R-1", value: "1" })], ["links", put({ comObjRefId: "O-1_R-1", gaRaws: [1] })],
      ["comobject-flags", put({ comObjRefId: "O-1_R-1", flags: {} })], ["revert", { method: "POST" }],
    ] as [string, RequestInit][]) {
      const r = await call(state, `/api/projects/${id}/devices/${DEVICE}/${path}`, init);
      expect([path, r.status, r.body.error.code]).toEqual([path, 409, "DEVICE_WITHOUT_APPLICATION"]);
    }
    expect(state.db.query("SELECT COUNT(*) AS n FROM device_parameters").get()).toEqual({ n: 0 });
  });

  test("a new project address is not in it yet", async () => {
    const state = fresh();
    const { id } = await imported(state);
    const put = (ia: string) => call(state, `/api/projects/${id}/devices/${DEVICE}/address`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ia }) });
    expect((await put("1.2.3")).status).toBe(200); // the address it holds: still programmed
    expect((await call(state, `/api/projects/${id}`)).body.devices[0].changes.neverProgrammed).toBe(false);
    expect((await put("1.2.4")).status).toBe(200);
    expect((await call(state, `/api/projects/${id}`)).body.devices[0].changes.neverProgrammed).toBe(true);
  });

  test("is placeable from the catalogue, and a placed one is never programmed", async () => {
    const state = fresh();
    await imported(state);
    const products = (await call(state, "/api/catalog/products")).body;
    expect(products).toEqual([{ appRef: HP, productRef: PRODUCT, appProgramId: "", manufacturer: 9, name: "Modular RS 232", orderNumber: "TH001", hwVersion: "1", hasApplication: false }]);
    const blank = (await call(state, "/api/projects", post({ name: "Blank" }))).body.id;
    expect((await call(state, `/api/projects/${blank}/devices`, post({ appRef: HP, productRef: PRODUCT }))).status).toBe(201);
    expect((await call(state, `/api/projects/${blank}`)).body.devices[0]).toMatchObject({ hasApplication: false, changes: { neverProgrammed: true } });
  });

  test("a product database that holds it pins it in the catalogue", async () => {
    const state = fresh();
    expect((await call(state, "/api/catalog/import", fileForm(storeZip({ [`${M}/Hardware.xml`]: hardware }), "th001.knxprod"))).body).toEqual({ products: 1, programs: 0 });
    const { id } = await imported(state);
    await call(state, `/api/projects/${id}`, { method: "DELETE" });
    expect((await call(state, "/api/catalog/products")).body.map((p: { orderNumber: string }) => p.orderNumber)).toEqual(["TH001"]);
  });

  test("leaves the catalogue with its last device unless pinned", async () => {
    const state = fresh();
    const { id } = await imported(state);
    expect((await call(state, "/api/catalog/products")).body).toHaveLength(1);
    await call(state, `/api/projects/${id}`, { method: "DELETE" });
    expect((await call(state, "/api/catalog/products")).body).toEqual([]);
  });

  test("survives a .busforge export and re-import", async () => {
    const state = fresh();
    const { id } = await imported(state);
    const exported = Buffer.from(await (await handleApi(new Request(`http://x/api/projects/${id}/export`, { method: "POST" }), state))!.arrayBuffer());
    expect((await call(state, "/api/projects/analyze", fileForm(exported, "p.busforge"))).body.devicesWithoutProgram).toEqual([]);
    const re = await call(state, "/api/projects/import-busforge", fileForm(exported, "p.busforge"));
    expect(re.body.devicesWithoutProgram).toEqual([]);
    expect((await call(state, `/api/projects/${re.body.id}`)).body.devices[0]).toMatchObject({ hasApplication: false, changes: { neverProgrammed: false } });
    expect((await call(state, `/api/projects/${re.body.id}/devices/${DEVICE}/config`)).body.error.code).toBe("DEVICE_WITHOUT_APPLICATION");
  });

  test("no device is replaced by it", async () => {
    const state = fresh();
    const { id } = await imported(state);
    const r = await call(state, `/api/projects/${id}/devices/${DEVICE}/replace`, post({ appRef: HP, productRef: PRODUCT, mapping: [] }));
    expect([r.status, r.body.error.code]).toEqual([409, "DEVICE_WITHOUT_APPLICATION"]);
  });
});
