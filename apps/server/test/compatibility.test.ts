import { test, expect, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi } from "../src/app.ts";
import { deviceCompatibility, evidenceBundle } from "../src/compatibility.ts";

const ALL = { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: true };
const JUNG = evidenceBundle().products.find((p) => p.productRef.startsWith("M-0004_"))!;

test("a bundled Product's own evidence makes it tested, a sibling Product on its Hardware only derived", () => {
  expect(deviceCompatibility(JUNG.productRef, JUNG.appProgramId, JUNG.capabilities).flashParams.state).toBe("tested");
  const sibling = `${JUNG.productRef.split("_P-")[0]}_P-OTHER`;
  const v = deviceCompatibility(sibling, JUNG.appProgramId, ALL).flashParams;
  expect(v).toMatchObject({ state: "derived", derivedFrom: JUNG.productRef });
  // The device's capabilities now, not the bundled ones, decide a refusal.
  expect(deviceCompatibility(JUNG.productRef, JUNG.appProgramId, { ...ALL, flashParams: false }).flashParams.state).toBe("refused");
});

test("another version of a bundled Product's application program is shown as such, never as tested", () => {
  const openknx = evidenceBundle().products.find((p) => p.productRef.startsWith("M-00FA_"))!;
  const other = openknx.appProgramId.replace(/-[0-9A-F]{4}$/, "-E5F5");
  expect(other).not.toBe(openknx.appProgramId);
  const ops = deviceCompatibility(openknx.productRef, other, ALL);
  expect(ops.flashParams).toMatchObject({ state: "otherVersion", otherVersionTested: { productRef: openknx.productRef, appProgramId: openknx.appProgramId } });
  // An operation the bundled version does not have tested is no more than untested here.
  expect(ops.structuralFlash.state).toBe("eligible");
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("the device view carries the device's compatibility", async () => {
  const dir = mkdtempSync(join(tmpdir(), "busforge-compat-"));
  dirs.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"))], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const { id } = (await (await handleApi(new Request("http://x/api/projects/import", { method: "POST", body: form }), state))!.json()) as { id: string };
  const project = (await (await handleApi(new Request(`http://x/api/projects/${id}`), state))!.json()) as { devices: { id: string }[] };
  const view = (await (await handleApi(new Request(`http://x/api/projects/${id}/devices/${project.devices[0].id}/config`), state))!.json()) as any;
  // A Product nothing was kept for: eligible where its capabilities allow, refused elsewhere.
  for (const [op, allowed] of Object.entries(view.capabilities)) {
    expect(`${op} ${view.compatibility[op].state}`).toBe(`${op} ${allowed ? "eligible" : "refused"}`);
  }
});

test("the catalog names where each manufacturer publishes its product data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "busforge-manuf-"));
  dirs.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const list = (await (await handleApi(new Request("http://x/api/catalog/manufacturers"), state))!.json()) as { id: string; productDataUrl: string | null }[];
  expect(list.find((m) => m.id === "M-0083")?.productDataUrl).toStartWith("https://");
  expect(list.find((m) => m.id === "M-0002")?.productDataUrl).toBeNull();
});
