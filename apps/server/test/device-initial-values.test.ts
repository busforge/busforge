import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { getDeviceParams } from "../src/db/deviceparams.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";

// A device placed from the catalogue, or given another product, starts at the values ETS gives a device added to a
// project in the client's language (initialValues, packages/product/src/config.ts): a text parameter's
// InitialValue, translated.
const M = "M-INIT1";
const A = `${M}_A-1`;
const appXml = (extra = "") => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${M}"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Nest" DefaultLanguage="en-US">
<Static>
<ParameterTypes>
  <ParameterType Id="${A}_PT-1" Name="Txt"><TypeText SizeInBit="160"/></ParameterType>
  <ParameterType Id="${A}_PT-2" Name="Num"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType>
</ParameterTypes>
<Parameters>
  <Parameter Id="${A}_P-1" Name="Name" ParameterType="${A}_PT-1" Text="Name" Value="Buzzard nest" InitialValue="Buzzard nest"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0"/></Parameter>
  ${extra}
</Parameters>
<ParameterRefs><ParameterRef Id="${A}_P-1_R-1" RefId="${A}_P-1"/><ParameterRef Id="${A}_P-2_R-2" RefId="${A}_P-2"/></ParameterRefs>
<Code><RelativeSegment Id="${A}_RS-1" Offset="0" Size="32" LoadStateMachine="4"/></Code>
</Static>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${A}_P-1_R-1"/></ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer>
<Languages><Language Identifier="de-DE"><TranslationUnit RefId="${A}">
  <TranslationElement RefId="${A}_P-1"><Translation AttributeName="InitialValue" Text="Bussardhorst Süd"/></TranslationElement>
</TranslationUnit></Language></Languages>
</ManufacturerData></KNX>`;

const hardware = `<?xml version="1.0"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${M}">
  <Hardware><Hardware Id="${M}_H-1" Name="HW" VersionNumber="1">
    <Products><Product Id="${M}_H-1_P-1" Text="Product" OrderNumber="${M}-001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${M}_H-1_HP-1"><ApplicationProgramRef RefId="${A}"/></Hardware2Program></Hardware2Programs>
  </Hardware></Hardware>
</Manufacturer></ManufacturerData></KNX>`;

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function project(xml: string): Promise<{ state: AppState; projectId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-initval-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([storeZip({ [`${M}/Hardware.xml`]: hardware, [`${M}/${A}.xml`]: xml })], "prod.knxprod"));
  expect((await handleApi(new Request("http://x/api/catalog/import", { method: "POST", body: form }), state))!.status).toBe(201);
  const proj = (await (await handleApi(post("/api/projects", { name: "P" }), state))!.json()) as { id: string };
  return { state, projectId: proj.id };
}
const place = (s: { state: AppState; projectId: string }, lang?: string) =>
  handleApi(post(`/api/projects/${s.projectId}/devices`, { appRef: `${M}_H-1_HP-1`, productRef: `${M}_H-1_P-1`, ...(lang ? { lang } : {}) }), s.state);

describe("placing a device", () => {
  test("in German, a text parameter starts at its de-DE InitialValue; in English, at its default", async () => {
    const s = await project(appXml());
    const de = (await (await place(s, "de"))!.json()) as { id: string };
    expect([...getDeviceParams(s.state.db, s.projectId, de.id)]).toEqual([[`${A}_P-1_R-1`, "Bussardhorst Süd"]]);
    const en = (await (await place(s, "en"))!.json()) as { id: string };
    expect(getDeviceParams(s.state.db, s.projectId, en.id).size).toBe(0);
    const none = (await (await place(s))!.json()) as { id: string };
    expect(getDeviceParams(s.state.db, s.projectId, none.id).size).toBe(0);
  });

  test("replacing a device's product starts it at the new application's values the same way", async () => {
    const s = await project(appXml());
    const dev = (await (await place(s, "en"))!.json()) as { id: string };
    const res = (await handleApi(post(`/api/projects/${s.projectId}/devices/${dev.id}/replace`, { appRef: `${M}_H-1_HP-1`, productRef: `${M}_H-1_P-1`, mapping: [], lang: "de" }), s.state))!;
    expect(res.status).toBe(200);
    expect([...getDeviceParams(s.state.db, s.projectId, dev.id)]).toEqual([[`${A}_P-1_R-1`, "Bussardhorst Süd"]]);
  });

  test("an InitialValue no capture shows ETS taking refuses the placement, and no device is added", async () => {
    const s = await project(appXml(`<Parameter Id="${A}_P-2" Name="N" ParameterType="${A}_PT-2" Text="N" Value="1" InitialValue="2"><Memory CodeSegment="${A}_RS-1" Offset="20" BitOffset="0"/></Parameter>`));
    const res = (await place(s, "de"))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PARAM_INITIAL_VALUE_UNSUPPORTED");
    const view = (await (await handleApi(new Request(`http://x/api/projects/${s.projectId}`), s.state))!.json()) as { devices: unknown[] };
    expect(view.devices).toEqual([]);
  });
});
