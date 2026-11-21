import { test, expect, describe } from "bun:test";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { tempDir } from "../../../tools/test-temp.ts";

// An archive holding one manufacturer's Hardware.xml twice under paths that differ in case only is refused
// by ARCHIVE_DUPLICATE_ENTRY on every import, the catalogue's included: it is not reported as a file without
// products.
const M = "M-0083";
const hardware = (text: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><ManufacturerData><Manufacturer RefId="${M}"><Hardware>
  <Hardware Id="${M}_H-1-1" Name="Unit" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
    <Products><Product Id="${M}_H-1-1_P-1" Text="${text}" OrderNumber="U-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="${M}_H-1-1_HP" MediumTypes="MT-0"/></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
const xml0 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><Project Id="P-0001"><Installations><Installation Name="">
  <Topology><Area Id="P-0001-0_A-1" Address="1"><Line Id="P-0001-0_L-1" Address="1"><Segment Id="P-0001-0_S-1" Number="0" MediumTypeRefId="MT-0">
    <DeviceInstance Id="P-0001-0_DI-1" Address="1" Name="" ProductRefId="${M}_H-1-1_P-1" Hardware2ProgramRefId="${M}_H-1-1_HP"/>
  </Segment></Line></Area></Topology>
</Installation></Installations></Project></KNX>`;
const twice = { [`${M}/Hardware.xml`]: hardware("A"), [`${M}/hardware.xml`]: hardware("B") };

const fresh = (): AppState => createState({ dbPath: ":memory:", dataDir: tempDir("busforge-hwplace-"), now: () => 1000 });
async function post(path: string, bytes: Buffer, name: string): Promise<{ status: number; body: any }> {
  const f = new FormData();
  f.set("file", new File([bytes], name));
  const r = (await handleApi(new Request(`http://x${path}`, { method: "POST", body: f }), fresh()))!;
  return { status: r.status, body: await r.json() };
}
const code = async (path: string, bytes: Buffer, name: string) => {
  const { status, body } = await post(path, bytes, name);
  return { status, code: (body as { error: { code: string } }).error.code };
};

describe("two Hardware.xml in one manufacturer directory", () => {
  test("a .knxprod is refused by the catalogue import with its code", async () => {
    expect(await code("/api/catalog/import", storeZip(twice), "two.knxprod")).toEqual({ status: 400, code: "ARCHIVE_DUPLICATE_ENTRY" });
  });
  for (const path of ["/api/projects/analyze", "/api/projects/import"]) {
    test(`a .knxproj is refused by ${path} with its code`, async () => {
      expect(await code(path, storeZip({ ...twice, "P-0001/0.xml": xml0 }), "two.knxproj")).toEqual({ status: 400, code: "ARCHIVE_DUPLICATE_ENTRY" });
    });
  }
  test("a .knxprod with one is imported", async () => {
    expect(await post("/api/catalog/import", storeZip({ [`${M}/Hardware.xml`]: hardware("A") }), "one.knxprod")).toEqual({ status: 201, body: { products: 1, programs: 0 } });
  });
});
