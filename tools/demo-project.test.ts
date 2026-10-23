import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi } from "../apps/server/src/app.ts";
import { buildDemoProject, demoProductDbs, DEMO_PROJECT_NAME, DEVICES, FLOORS, GROUPS, gaRaw, type DemoApi } from "./demo-project.ts";
import { corpusDescribe } from "./corpus-test.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): the build takes 3.6 s
// with the file alone (load 3-4); twenty times that, at least 60 s.
setDefaultTimeout(80_000);

// The demo's own data holds together without any product data: every link names an address the
// project creates, every device a room, and no individual address is taken twice.
test("the demo's devices link only addresses it creates and sit in rooms it builds", () => {
  const addresses = new Set(GROUPS.flatMap((m) => m.middles.flatMap((mid) => mid.addresses.map(([sub]) => `${m.main}/${mid.mid}/${sub}`))));
  const rooms = new Set(FLOORS.flatMap((f) => f.rooms.map((r) => r.key)));
  for (const d of DEVICES) {
    expect(rooms.has(d.room)).toBe(true);
    for (const [, gas] of d.links) for (const ga of gas) expect(addresses.has(ga)).toBe(true);
  }
  expect(new Set(DEVICES.map((d) => d.ia)).size).toBe(DEVICES.length);
  expect(gaRaw("1/2/3")).toBe((1 << 11) | (2 << 8) | 3);
});

corpusDescribe("the demo project in a fresh instance", () => {
  test("is built from the corpus' product data alone, with every device placed, addressed and linked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-demo-"));
    const state = createState({ dataDir: dir });
    const api: DemoApi = async (path, init) => (await handleApi(new Request(`http://demo${path}`, init), state))!;
    const call = async (path: string) => (await api(path)).json();
    try {
      const summary = await buildDemoProject(api, demoProductDbs());
      const project = await call(`/api/projects/${summary.projectId}`);
      expect(project.name).toBe(DEMO_PROJECT_NAME);
      expect(project.devices.map((d: { ia: string }) => d.ia).sort()).toEqual(DEVICES.map((d) => d.ia).sort());
      expect(project.gaCount).toBe(GROUPS.flatMap((m) => m.middles.flatMap((mid) => mid.addresses)).length);
      // Several manufacturers, each named in the summary.
      expect(new Set(summary.devices.map((d) => d.manufacturer)).size).toBe(10);
      expect(summary.devices.every((d) => !d.manufacturer.startsWith("M-"))).toBe(true);
      // Every device sits in a room.
      const placed = new Set<string>();
      const walk = (n: { deviceIds: string[]; children: unknown[] }) => { n.deviceIds.forEach((id) => placed.add(id)); n.children.forEach((c) => walk(c as typeof n)); };
      project.locations.forEach(walk);
      expect(project.devices.every((d: { id: string }) => placed.has(d.id))).toBe(true);
      // One building, three floors, nine rooms (docs/testing.md, "The demo project").
      expect(project.locations).toHaveLength(1);
      expect(project.locations[0].children).toHaveLength(3);
      expect(project.locations[0].children.flatMap((f: { children: unknown[] }) => f.children)).toHaveLength(9);
      // Nothing secure is set up behind the user's back: no keys, every address plain.
      expect(project.secureDeviceCount).toBe(0);
      expect(project.groupKeyCount).toBe(0);
      expect((await call(`/api/projects/${summary.projectId}/snapshots`)).length).toBe(1);

      // A second build into the same instance refuses instead of adding a twin.
      const again = await buildDemoProject(api, demoProductDbs()).then(() => null, (e: unknown) => e);
      expect(String(again)).toMatch(/already holds a project/);
    } finally {
      state.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
