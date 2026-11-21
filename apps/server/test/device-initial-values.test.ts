import { test, expect, describe } from "bun:test";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { getDeviceParams, getDeviceParamBase, getDeviceForFlash } from "../src/db/deviceparams.ts";
import { KnxError, LSM, STATE, type KnxDevice } from "@busforge/knx";
import { classify, parseAppConfig } from "@busforge/product";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { tempDir } from "../../../tools/test-temp.ts";

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

const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function project(xml: string): Promise<{ state: AppState; projectId: string }> {
  const dir = tempDir("busforge-initval-");
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

  // The value a device starts at is its default on the device page: the parameter shows no change, the
  // project counts none, and a revert returns to it, not to the Parameter's Value.
  const paramView = async (s: { state: AppState; projectId: string }, deviceId: string) => {
    const view = (await (await handleApi(new Request(`http://x/api/projects/${s.projectId}/devices/${deviceId}/config?lang=de`), s.state))!.json()) as { blocks: { items: { kind: string; param?: { refId: string; value: string; changed?: boolean } }[] }[] };
    return view.blocks.flatMap((b) => b.items).find((it) => it.param?.refId === `${A}_P-1_R-1`)!.param!;
  };
  const changes = async (s: { state: AppState; projectId: string }, deviceId: string) => {
    const view = (await (await handleApi(new Request(`http://x/api/projects/${s.projectId}`), s.state))!.json()) as { devices: { id: string; changes: { params: number; links: number; flags: number; neverProgrammed: boolean } }[] };
    return view.devices.find((d) => d.id === deviceId)!.changes;
  };

  test("a device started at a translated InitialValue shows it unchanged, and a revert returns to it", async () => {
    const s = await project(appXml());
    const dev = (await (await place(s, "de"))!.json()) as { id: string };
    expect(await paramView(s, dev.id)).toMatchObject({ value: "Bussardhorst Süd", changed: false });
    expect(await changes(s, dev.id)).toEqual({ params: 0, links: 0, flags: 0, neverProgrammed: true });

    const put = (value: string) => handleApi(new Request(`http://x/api/projects/${s.projectId}/devices/${dev.id}/params`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId: `${A}_P-1_R-1`, value, lang: "de" }) }), s.state);
    await put("Horst");
    expect(await paramView(s, dev.id)).toMatchObject({ value: "Horst", changed: true });
    expect((await changes(s, dev.id)).params).toBe(1);
    // The Parameter's Value is not where the device started, so it is a change too.
    await put("Buzzard nest");
    expect(await paramView(s, dev.id)).toMatchObject({ value: "Buzzard nest", changed: true });

    await handleApi(post(`/api/projects/${s.projectId}/devices/${dev.id}/revert-param`, { paramRefId: `${A}_P-1_R-1` }), s.state);
    expect(await paramView(s, dev.id)).toMatchObject({ value: "Bussardhorst Süd", changed: false });
    expect((await changes(s, dev.id)).params).toBe(0);

    await put("Horst");
    await handleApi(post(`/api/projects/${s.projectId}/devices/${dev.id}/revert`, {}), s.state);
    expect(await paramView(s, dev.id)).toMatchObject({ value: "Bussardhorst Süd", changed: false });
    expect(await changes(s, dev.id)).toEqual({ params: 0, links: 0, flags: 0, neverProgrammed: true });
  });

  test("a product replacement that starts a translated InitialValue shows it unchanged", async () => {
    const s = await project(appXml());
    const dev = (await (await place(s, "en"))!.json()) as { id: string };
    await handleApi(post(`/api/projects/${s.projectId}/devices/${dev.id}/replace`, { appRef: `${M}_H-1_HP-1`, productRef: `${M}_H-1_P-1`, mapping: [], lang: "de" }), s.state);
    expect(await paramView(s, dev.id)).toMatchObject({ value: "Bussardhorst Süd", changed: false });
    expect(await changes(s, dev.id)).toEqual({ params: 0, links: 0, flags: 0, neverProgrammed: true });
  });

  // The baseline holds the start value, but the device does not: the parameter flash of a never-programmed device
  // writes every byte it owns (ParamFlashCtx.neverProgrammed, which the flash-params route passes from
  // devices.never_programmed), so the text reaches a unit that reads FF there. The application declares tunnelling
  // entries, which keeps its full download from it and the parameter flash for a never-programmed device.
  test("a placed device's parameter flash writes the start value onto a unit that reads FF there", async () => {
    const xml = appXml().replace('DefaultLanguage="en-US"', 'DefaultLanguage="en-US" MaxTunnelingUserEntries="4"');
    const s = await project(xml);
    const dev = (await (await place(s, "de"))!.json()) as { id: string };
    const flashDev = getDeviceForFlash(s.state.db, s.projectId, dev.id)!;
    expect(flashDev.neverProgrammed).toBe(true);
    const unit = loadedUnitReadingFF();
    const res = await classify(parseAppConfig(xml)).flashParameters(unit as unknown as KnxDevice, "MV-07B0", {
      deviceId: dev.id, appXml: xml, params: getDeviceParams(s.state.db, s.projectId, dev.id), baseParams: getDeviceParamBase(s.state.db, s.projectId, dev.id),
      moduleInstances: [], dryRun: false, persistBackups: () => "backup", neverProgrammed: flashDev.neverProgrammed,
    });
    expect(res).toMatchObject({ kind: "flashed", verified: true });
    const field = Buffer.from(Array.from({ length: 20 }, (_, i) => unit.mem.get(SEGMENT + i) ?? 0xff));
    expect(field.toString("hex")).toBe(Buffer.concat([Buffer.from("Bussardhorst Süd", "latin1"), Buffer.alloc(4)]).toString("hex"));
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

// A unit holding this application LOADED whose 32-octet parameter segment reads FF throughout, with one
// memory-control-block region over it; whatever the flash calls beyond what it uses here throws.
const SEGMENT = 0x4000;
function loadedUnitReadingFF() {
  const unit = {
    mem: new Map<number, number>(),
    state: new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED], [4, STATE.LOADED]]),
    async connect() {}, async disconnect() {},
    async deviceDescriptor() { return "MV-07B0"; },
    acceptUnprovenRestart() {}, restartUnproven: false,
    async restart() {},
    async tableAddr(obj: number) { return obj === 4 ? SEGMENT : 0x100 * obj; },
    async memRead(addr: number, len: number) { return Buffer.from(Array.from({ length: len }, (_, i) => unit.mem.get(addr + i) ?? 0xff)); },
    async memWrite(addr: number, data: Buffer) { data.forEach((b, i) => unit.mem.set(addr + i, b)); },
    async writesConfirmed() { return false; }, confirmedWrites() { return []; }, clearConfirmedWrites() {},
    setExtendedMemoryServices() {}, async setVerifyMode() {}, async interfaceMaxApdu() { return null; },
    answer(obj: number, pid: number): Buffer | null {
      if (pid === 5) return Buffer.from([unit.state.get(obj) ?? STATE.UNLOADED]);
      if (pid === 7) return Buffer.from([0, 0, (obj === 4 ? SEGMENT : 0x100 * obj) >> 8, 0]);
      if (pid === 27) return Buffer.from("0000002000ff00aa", "hex");
      return null;
    },
    async propRead(obj: number, pid: number) { const a = unit.answer(obj, pid); if (!a) throw new KnxError("PROPERTY_ABSENT", `no property ${obj}/${pid}`); return a; },
    async propReadIfPresent(obj: number, pid: number) { return unit.answer(obj, pid) ?? undefined; },
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === 5) unit.state.set(obj, data[0] === LSM.LOAD ? STATE.LOADING : data[0] === LSM.LOAD_COMPLETED ? STATE.LOADED : data[0] === LSM.UNLOAD ? STATE.UNLOADED : unit.state.get(obj) ?? STATE.UNLOADED);
      return Buffer.alloc(0);
    },
  };
  return new Proxy(unit, { get: (t, k) => (k in t ? t[k as keyof typeof t] : () => { throw new Error(`the flash called ${String(k)}`); }) });
}
