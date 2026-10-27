import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createState, handleApi } from "../apps/server/src/app.ts";
import {
  buildDemoProject, gaRaw, MANUFACTURER_DEMO, OPEN_DEMO, OPENKNX_RELEASES, openKnxProductDb, openKnxProductDbs, parseDemoArgs,
  type Demo, type DemoApi, type ProductDb,
} from "./demo-project.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { corpusPath, DEMO_PRODUCT_FILES, OPENKNX_DEMO_DIR } from "./corpus.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): the manufacturer
// demo builds in 3.6 s with the file alone (load 3-4), twenty times that, at least 60 s; the open
// demo has its own below.
setDefaultTimeout(80_000);
// The open demo builds in 10.0 s with the file alone (load 2-3) and in 57 s with the file alone
// while other test runs keep the machine busy (load 6-7): thirty times the first, five times the
// second.
const OPEN_DEMO_TIMEOUT = 300_000;

const addressCount = (demo: Demo) => demo.groups.flatMap((m) => m.middles.flatMap((mid) => mid.addresses)).length;

// Each demo's own data holds together without any product data: every link names an address the
// project creates, every device a room, and no individual address is taken twice.
for (const demo of [OPEN_DEMO, MANUFACTURER_DEMO]) {
  test(`${demo.name}: the devices link only addresses it creates and sit in rooms it builds`, () => {
    const addresses = new Set(demo.groups.flatMap((m) => m.middles.flatMap((mid) => mid.addresses.map(([sub]) => `${m.main}/${mid.mid}/${sub}`))));
    const rooms = new Set(demo.floors.flatMap((f) => f.rooms.map((r) => r.key)));
    for (const d of demo.devices) {
      expect(rooms.has(d.room)).toBe(true);
      for (const [, gas] of d.links) for (const ga of gas) expect(addresses.has(ga)).toBe(true);
    }
    expect(new Set(demo.devices.map((d) => d.ia)).size).toBe(demo.devices.length);
  });
}

test("a group address packs its three levels", () => {
  expect(gaRaw("1/2/3")).toBe((1 << 11) | (2 << 8) | 3);
});

test("the open demo places OpenKNX applications only, each from a pinned OpenKNX release", () => {
  for (const d of OPEN_DEMO.devices) {
    expect(d.appRef.startsWith("M-00FA_")).toBe(true);
    expect(d.productRef.startsWith("M-00FA_")).toBe(true);
  }
  for (const r of OPENKNX_RELEASES) expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the command line builds the open demo unless told otherwise, and refuses what it cannot read", () => {
  expect(parseDemoArgs(["http://localhost:3000/"])).toEqual({ baseUrl: "http://localhost:3000", openKnxDir: null, manufacturerDbs: null });
  expect(parseDemoArgs(["--openknx", "/d", "http://x"])).toEqual({ baseUrl: "http://x", openKnxDir: "/d", manufacturerDbs: null });
  expect(parseDemoArgs(["--manufacturers", "a.knxprod", "b.knxprod", "http://x"])).toEqual({ baseUrl: "http://x", openKnxDir: null, manufacturerDbs: ["a.knxprod", "b.knxprod"] });
  for (const bad of [[], ["--openknx", "http://x"], ["--manufacturers", "http://x"], ["--openknx", "/a", "/b", "http://x"], ["--other", "http://x"], ["a", "http://x"], ["--openknx", "/d", "--manufacturers", "a", "http://x"], ["--manufacturers", "a.knxprod", "b.knxprod"], ["localhost:3000"]]) {
    expect(() => parseDemoArgs(bad)).toThrow(/usage/);
  }
});

// A minimal stored ZIP of the given entries (no compression), enough for readZip.
function storedZip(entries: [string, string][]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(Bun.hash.crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt32LE(Bun.hash.crc32(data), 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(n.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(head, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

test("an OpenKNX archive gives its one product XML, whichever path separator it names it with", () => {
  for (const sep of ["/", "\\"]) {
    const zip = storedZip([[`data${sep}content.xml`, "<c/>"], [`data${sep}Logic.xml`, "<KNX/>"], [`data${sep}Logic.baggages${sep}A0${sep}ets.png`, "png"]]);
    const db = openKnxProductDb({ repo: "r", tag: "t", asset: "a.zip", sha256: sha256(zip) }, zip);
    expect(db.name).toBe("Logic.xml");
    expect(new TextDecoder().decode(db.bytes)).toBe("<KNX/>");
  }
});

test("an OpenKNX archive is refused when it is not the release pinned, or holds no single product XML", () => {
  const zip = storedZip([["data/Logic.xml", "<KNX/>"]]);
  expect(() => openKnxProductDb({ repo: "r", tag: "t", asset: "a.zip", sha256: "0".repeat(64) }, zip)).toThrow(/SHA-256/);
  const none = storedZip([["data/content.xml", "<c/>"]]);
  expect(() => openKnxProductDb({ repo: "r", tag: "t", asset: "a.zip", sha256: sha256(none) }, none)).toThrow(/0 product XML/);
  const two = storedZip([["data/A.xml", "<KNX/>"], ["data/B.xml", "<KNX/>"]]);
  expect(() => openKnxProductDb({ repo: "r", tag: "t", asset: "a.zip", sha256: sha256(two) }, two)).toThrow(/2 product XML/);
});

test("a download that does not answer, or fails, is refused, naming the address and the way around it", async () => {
  const refused = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
  const e = await openKnxProductDbs(null, refused).then(() => null, (err: unknown) => err);
  expect(String(e)).toMatch(/github\.com\/OpenKNX\/.*answered 404.*--openknx/);
  const offline = (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch;
  const f = await openKnxProductDbs(null, offline).then(() => null, (err: unknown) => err);
  expect(String(f)).toMatch(/github\.com\/OpenKNX\/.*failed: Unable to connect.*--openknx/);
});

// Build `demo` into a fresh in-process instance and check what it holds.
async function buildAndCheck(demo: Demo, dbs: ProductDb[], manufacturers: number) {
  const dir = mkdtempSync(join(tmpdir(), "busforge-demo-"));
  const state = createState({ dataDir: dir });
  const api: DemoApi = async (path, init) => (await handleApi(new Request(`http://demo${path}`, init), state))!;
  const call = async (path: string) => (await api(path)).json();
  try {
    const summary = await buildDemoProject(api, demo, dbs);
    const project = await call(`/api/projects/${summary.projectId}`);
    expect(project.name).toBe(demo.name);
    expect(project.devices.map((d: { ia: string }) => d.ia).sort()).toEqual(demo.devices.map((d) => d.ia).sort());
    expect(project.gaCount).toBe(addressCount(demo));
    expect(new Set(summary.devices.map((d) => d.manufacturer)).size).toBe(manufacturers);
    expect(summary.devices.every((d) => !d.manufacturer.startsWith("M-"))).toBe(true);
    // Every device sits in a room.
    const placed = new Set<string>();
    const walk = (n: { deviceIds: string[]; children: unknown[] }) => { n.deviceIds.forEach((id) => placed.add(id)); n.children.forEach((c) => walk(c as typeof n)); };
    project.locations.forEach(walk);
    expect(project.devices.every((d: { id: string }) => placed.has(d.id))).toBe(true);
    // The building with its floors and rooms (docs/demo.md).
    expect(project.locations).toHaveLength(1);
    expect(project.locations[0].children).toHaveLength(demo.floors.length);
    expect(project.locations[0].children.flatMap((f: { children: unknown[] }) => f.children)).toHaveLength(demo.floors.flatMap((f) => f.rooms).length);
    // Nothing secure is set up behind the user's back: no keys, every address plain.
    expect(project.secureDeviceCount).toBe(0);
    expect(project.groupKeyCount).toBe(0);
    expect((await call(`/api/projects/${summary.projectId}/snapshots`)).length).toBe(1);

    // A second build into the same instance refuses instead of adding a twin.
    const again = await buildDemoProject(api, demo, dbs).then(() => null, (e: unknown) => e);
    expect(String(again)).toMatch(/already holds a project/);
  } finally {
    state.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a product database that lacks a demo's application is refused before any project is made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "busforge-demo-"));
  const state = createState({ dataDir: dir });
  const api: DemoApi = async (path, init) => (await handleApi(new Request(`http://demo${path}`, init), state))!;
  try {
    const e = await buildDemoProject(api, OPEN_DEMO, []).then(() => null, (err: unknown) => err);
    expect(String(e)).toMatch(/lack M-00FA_H-0xA602-1_P-OpenKnxSwitchActuator with application/);
    expect(await (await api("/api/projects")).json()).toEqual([]);
  } finally {
    state.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

corpusDescribe("the demo projects in a fresh instance", () => {
  test("the manufacturer demo is built from the manufacturers' product databases alone, every device placed, addressed and linked", async () => {
    const dbs = DEMO_PRODUCT_FILES.map((f) => ({ name: basename(f), bytes: new Uint8Array(readFileSync(corpusPath(f))) }));
    await buildAndCheck(MANUFACTURER_DEMO, dbs, 10);
  });

  test("the open demo is built from OpenKNX's release archives alone, every device placed, addressed and linked", async () => {
    await buildAndCheck(OPEN_DEMO, await openKnxProductDbs(corpusPath(OPENKNX_DEMO_DIR)), 1);
  }, OPEN_DEMO_TIMEOUT);
});
