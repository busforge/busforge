import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { unpackBusforge } from "../src/db/busforgeArtifact.ts";
import { putAppProgram, putCatalogBaggage, catalogBaggageIds } from "../src/db/catalog.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";

// The product test fixture with its TypePicture parameters ("Logo" names a baggage image, "Picture without
// image" none), under a real manufacturer id so it can be placed.
const program = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "sample-unsupported-app.xml"), "utf8").replaceAll("M-TEST", "M-0083");
const APP = "M-0083_A-9";
const LOGO = "M-0083_BG--logo.2Epng";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function knxprod(withImage: boolean): Buffer {
  const hardware = `<?xml version="1.0"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083">
  <Hardware><Hardware Id="M-0083_H-1" Name="Pic" VersionNumber="1">
    <Products><Product Id="M-0083_H-1_P-pic" Text="Picture Device" OrderNumber="PIC-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="M-0083_H-1_HP-9"><ApplicationProgramRef RefId="${APP}"/></Hardware2Program></Hardware2Programs>
  </Hardware></Hardware>
</Manufacturer></ManufacturerData></KNX>`;
  const baggages = `<?xml version="1.0"?><KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-0083"><Baggages>
  <Baggage TargetPath="" Name="logo.png" Id="${LOGO}" /></Baggages></Manufacturer></ManufacturerData></KNX>`;
  return storeZip({
    "M-0083/Hardware.xml": hardware,
    [`M-0083/${APP}.xml`]: program,
    ...(withImage ? { "M-0083/Baggages.xml": baggages, "M-0083/Baggages/logo.png": png } : {}),
  });
}

describe("TypePicture images in the catalogue", () => {
  const tmps: string[] = [];
  const freshState = (): AppState => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-pic-"));
    tmps.push(dir);
    return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  };
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
  const post = (path: string, body: unknown) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const call = async (state: AppState, r: Request) => (await handleApi(r, state))!;

  async function placed(state: AppState, withImage: boolean) {
    const form = new FormData();
    form.set("file", new File([knxprod(withImage)], "vendor.knxprod"));
    expect((await call(state, req("/api/catalog/import", { method: "POST", body: form }))).status).toBe(201);
    const project = (await (await call(state, post("/api/projects", { name: "P" }))).json()) as { id: string };
    const device = (await (await call(state, post(`/api/projects/${project.id}/devices`, { appRef: "M-0083_H-1_HP-9", productRef: "M-0083_H-1_P-pic" }))).json()) as { id: string };
    return { projectId: project.id, deviceId: device.id };
  }
  const paramByName = async (state: AppState, projectId: string, deviceId: string, name: string) => {
    const view = (await (await call(state, req(`/api/projects/${projectId}/devices/${deviceId}/config`))).json()) as { blocks: { items: { kind: string; param?: { name: string } & Record<string, unknown> }[] }[] };
    return view.blocks.flatMap((b) => b.items).find((i) => i.kind === "param" && i.param!.name === name)!.param!;
  };

  test("a .knxprod's picture image is stored, named in the device view and served as an image", async () => {
    const state = freshState();
    const { projectId, deviceId } = await placed(state, true);
    const logo = await paramByName(state, projectId, deviceId, "Logo");
    expect(logo).toMatchObject({ control: "picture", readOnly: true, picture: { baggageId: LOGO, align: "Right", url: `/api/catalog/apps/${APP}/pictures/${encodeURIComponent(LOGO)}` } });
    const res = await call(state, req((logo.picture as { url: string }).url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    // A picture naming no image stays an explicit unsupported row.
    expect(await paramByName(state, projectId, deviceId, "Picture without image")).toMatchObject({ control: "unsupported" });
  });

  test("without the image file the view gives no url and the route answers 404, coded", async () => {
    const state = freshState();
    const { projectId, deviceId } = await placed(state, false);
    const logo = await paramByName(state, projectId, deviceId, "Logo");
    expect(logo).toMatchObject({ control: "picture", picture: { baggageId: LOGO } });
    expect((logo.picture as { url?: string }).url).toBeUndefined();
    const res = await call(state, req(`/api/catalog/apps/${APP}/pictures/${encodeURIComponent(LOGO)}`));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PICTURE_MISSING");
  });

  test("a baggage file that is no image type is refused, not served", async () => {
    const state = freshState();
    putAppProgram(state.db, APP, program);
    putCatalogBaggage(state.db, APP, new Map([["M-0083_BG--page.2Ehtml", { name: "page.html", data: Buffer.from("<script>1</script>") }]]));
    const res = await call(state, req(`/api/catalog/apps/${APP}/pictures/M-0083_BG--page.2Ehtml`));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PICTURE_TYPE_UNSUPPORTED");
  });

  test("the .busforge export carries the images and a re-import serves them again", async () => {
    const state = freshState();
    const { projectId } = await placed(state, true);
    const res = await call(state, req(`/api/projects/${projectId}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const bytes = Buffer.from(await res.arrayBuffer());
    const artifact = (await unpackBusforge(bytes, undefined)) as unknown as { catalogPictures: unknown[] };
    expect(artifact.catalogPictures).toEqual([{ appProgramId: APP, baggageId: LOGO, name: "logo.png", dataBase64: png.toString("base64") }]);

    const other = freshState();
    const form = new FormData();
    form.set("file", new File([bytes], "p.busforge"));
    const imported = (await (await call(other, req("/api/projects/import-busforge", { method: "POST", body: form }))).json()) as { id: string };
    const devices = (await (await call(other, req(`/api/projects/${imported.id}`))).json()) as { devices: { id: string }[] };
    const logo = await paramByName(other, imported.id, devices.devices[0].id, "Logo");
    const served = await call(other, req((logo.picture as { url: string }).url));
    expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
  });

  test("an artifact whose pictures are not images its programs show, are doubled or not base64 is refused", async () => {
    const state = freshState();
    const { projectId } = await placed(state, true);
    const res = await call(state, req(`/api/projects/${projectId}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const artifact = (await unpackBusforge(Buffer.from(await res.arrayBuffer()), undefined)) as unknown as Record<string, unknown>;
    const good = { appProgramId: APP, baggageId: LOGO, name: "logo.png", dataBase64: png.toString("base64") };
    for (const pictures of [
      [{ ...good, appProgramId: "M-0083_A-NOPE" }],
      [{ ...good, baggageId: "M-0083_BG--other.2Epng" }],
      [good, good],
      [{ ...good, dataBase64: "not base64!" }],
    ]) {
      artifact.catalogPictures = pictures;
      const form = new FormData();
      form.set("file", new File([JSON.stringify(artifact)], "p.busforge.json"));
      const refused = await call(freshState(), req("/api/projects/import-busforge", { method: "POST", body: form }));
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("BUSFORGE_INVALID");
    }
  });

  test("a stored file of a type the route does not serve gives the view no url", async () => {
    const state = freshState();
    const { projectId, deviceId } = await placed(state, false);
    putCatalogBaggage(state.db, APP, new Map([[LOGO, { name: "logo.ico", data: png }]]));
    expect(((await paramByName(state, projectId, deviceId, "Logo")).picture as { url?: string }).url).toBeUndefined();
  });

  test("an image goes with its application program", () => {
    const state = freshState();
    putAppProgram(state.db, APP, program);
    putCatalogBaggage(state.db, APP, new Map([[LOGO, { name: "logo.png", data: png }]]));
    expect(catalogBaggageIds(state.db, APP)).toEqual(new Set([LOGO]));
    state.db.prepare("DELETE FROM app_programs WHERE id = ?").run(APP);
    expect(catalogBaggageIds(state.db, APP).size).toBe(0);
  });
});
