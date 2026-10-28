import { test, expect, describe, mock, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeZip } from "../../../packages/project/test/ziputil.ts";

// A verified address assignment is everything a product without an application program takes, so it
// marks such a device programmed; on a device with an application only the full download does. The
// bus side is stubbed (the knx layer's own tests drive the assignment against a simulated line).
const real = await import("../src/deviceprofile.ts");
const realAssign = real.assignDeviceAddress;
let assignImpl: typeof realAssign = realAssign;
await mock.module("../src/deviceprofile.ts", () => ({ ...real, assignDeviceAddress: (...a: Parameters<typeof realAssign>) => assignImpl(...a) }));
const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;
afterAll(() => { assignImpl = realAssign; });

const M = "M-0009";
const HP = `${M}_H-9.20.2F.2F.20TH001-1_HP`;
const PRODUCT = `${M}_H-9.20.2F.2F.20TH001-1_P-TH001`;
const hardware = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="${M}"><Hardware>
  <Hardware Id="${M}_H-9.20.2F.2F.20TH001-1" Name="TH001" VersionNumber="1">
    <Products><Product Id="${PRODUCT}" Text="Modular RS 232" OrderNumber="TH001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${HP}"/></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
const project = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><Project Id="P-0001"><Installations><Installation Name="">
  <Topology><Area Id="P-0001-0_A-1" Address="1"><Line Id="P-0001-0_L-1" Address="2"><Segment Id="P-0001-0_S-1" Number="0" MediumTypeRefId="MT-0">
    <DeviceInstance Id="P-0001-0_DI-1" Address="3" Name="" ProductRefId="${PRODUCT}" Hardware2ProgramRefId="${HP}"/>
  </Segment></Line></Area></Topology>
</Installation></Installations></Project></KNX>`;

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
async function setup(): Promise<{ state: AppState; projectId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-assign-noapp-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const call = async (path: string, init?: RequestInit) => (await handleApi(new Request(`http://x${path}`, init), state))!.json() as Promise<any>;
  const form = new FormData();
  form.set("file", new File([storeZip({ [`${M}/Hardware.xml`]: hardware, "P-0001/0.xml": project })], "TH001.knxproj"));
  const { id } = await call("/api/projects/import", { method: "POST", body: form });
  const conn = await call("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }) });
  await call(`/api/projects/${id}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }) });
  return { state, projectId: id };
}
async function assign(state: AppState, projectId: string) {
  const task = await (await handleApi(new Request(`http://x/api/projects/${projectId}/devices/P-0001-0_DI-1/assign-ia`, { method: "POST" }), state))!.json() as { id: string };
  await state.queue.wait(task.id);
  const p = await (await handleApi(new Request(`http://x/api/projects/${projectId}`), state))!.json() as any;
  return p.devices[0].changes.neverProgrammed as boolean;
}

describe("assigning the address of a device without an application program", () => {
  test("a verified assignment marks it programmed", async () => {
    const { state, projectId } = await setup();
    assignImpl = async (_c, ia) => ({ previous: "15.15.255", assigned: ia, verified: true, progModeCleared: true, progModeError: null });
    expect(await assign(state, projectId)).toBe(false);
  });

  test("a device with an application program stays never programmed: only its full download clears that", async () => {
    const { state, projectId } = await setup();
    state.db.run("UPDATE devices SET has_application = 1");
    assignImpl = async (_c, ia) => ({ previous: "15.15.255", assigned: ia, verified: true, progModeCleared: true, progModeError: null });
    expect(await assign(state, projectId)).toBe(true);
  });

  test("an address the project no longer holds when the assignment ends does not mark it programmed", async () => {
    const { state, projectId } = await setup();
    assignImpl = async (_c, ia) => {
      state.db.run("UPDATE devices SET ia = '1.2.9'"); // edited while the task ran
      return { previous: "15.15.255", assigned: ia, verified: true, progModeCleared: true, progModeError: null };
    };
    expect(await assign(state, projectId)).toBe(true);
  });

  test("the assignment gets the mask of the project's application, none for a product without one", async () => {
    const seen: (string | undefined)[] = [];
    assignImpl = async (_c, ia, _p, projectMask) => { seen.push(projectMask); return { previous: ia, assigned: ia, verified: true, progModeCleared: true, progModeError: null }; };
    const { state, projectId } = await setup();
    await assign(state, projectId);
    const form = new FormData();
    form.set("file", new File([readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"))], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    const { id } = await (await handleApi(new Request("http://x/api/projects/import", { method: "POST", body: form }), state))!.json() as { id: string };
    const conn = await (await handleApi(new Request("http://x/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "ip", name: "GW2", host: "198.51.100.11", port: 3671 }) }), state))!.json() as { id: string };
    await handleApi(new Request(`http://x/api/projects/${id}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }) }), state);
    const task = await (await handleApi(new Request(`http://x/api/projects/${id}/devices/P-CFG-0_DI-1/assign-ia`, { method: "POST" }), state))!.json() as { id: string };
    await state.queue.wait(task.id);
    expect(seen).toEqual([undefined, "MV-07B0"]);
    // An application the configuration parser refuses still names its mask, and the assignment runs.
    state.db.run("UPDATE app_programs SET xml = ? WHERE id = 'M-TEST_A-1'", [`<KNX><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
      <ApplicationProgram Id="M-TEST_A-1" MaskVersion="MV-0012"><Static><Parameters><Parameter Id="p" ByteOrder="Weird"/></Parameters></Static></ApplicationProgram>
    </ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`]);
    const again = await (await handleApi(new Request(`http://x/api/projects/${id}/devices/P-CFG-0_DI-1/assign-ia`, { method: "POST" }), state))!.json() as { id: string };
    await state.queue.wait(again.id);
    expect(seen).toEqual([undefined, "MV-07B0", "MV-0012"]);
  });

  test("a failed assignment leaves it never programmed", async () => {
    const { state, projectId } = await setup();
    assignImpl = async () => { throw new Error("no device is in programming mode"); };
    expect(await assign(state, projectId)).toBe(true);
  });
});
