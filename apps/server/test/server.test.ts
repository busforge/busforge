import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGroupTpdu } from "../src/telegram.ts";
import { Bus } from "../src/bus.ts";
import { createState, handleApi, type AppState } from "../src/app.ts";

const encFixture = readFileSync(
  join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-encrypted.knxproj"),
);

describe("telegram decoding", () => {
  test("GroupValueWrite with a 1-bit value", () => {
    // src 1.2.50, dst 0/0/1, APDU 00 81 -> write, value bit 1
    const t = decodeGroupTpdu(0x1232, 0x0001, Buffer.from([0x00, 0x81]), 1000);
    expect(t).toMatchObject({ src: "1.2.50", dst: "0/0/1", dstRaw: 1, kind: "GroupValueWrite", raw: "01" });
  });
  test("GroupValueRead", () => {
    expect(decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x00]), 0).kind).toBe("GroupValueRead");
  });
  test("GroupValueResponse with a trailing byte payload", () => {
    const t = decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x40, 0xab]), 0);
    expect(t.kind).toBe("GroupValueResponse");
    expect(t.raw).toBe("ab");
  });
});

describe("Bus", () => {
  test("delivers telegrams to subscribers and respects unsubscribe", () => {
    const bus = new Bus(() => 42);
    const got: string[] = [];
    const unsub = bus.subscribe((t) => got.push(t.dst));
    (bus as any).emit(decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 42));
    unsub();
    (bus as any).emit(decodeGroupTpdu(0, 2, Buffer.from([0x00, 0x81]), 42));
    expect(got).toEqual(["0/0/1"]);
  });
  test("status starts disconnected with no active project", () => {
    const bus = new Bus();
    expect(bus.status).toBe("disconnected");
    expect(bus.activeProjectId).toBeNull();
  });
});

describe("API (project resources)", () => {
  const tmps: string[] = [];
  function freshState(): AppState {
    const dir = mkdtempSync(join(tmpdir(), "busforge-test-"));
    tmps.push(dir);
    return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  }
  afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
  const importDemo = async (state: AppState, password = "tester12") => {
    const form = new FormData();
    form.set("file", new File([encFixture], "Demo.knxproj"));
    form.set("password", password);
    return handleApi(req("/api/projects/import", { method: "POST", body: form }), state);
  };

  test("empty list initially", async () => {
    const res = await handleApi(req("/api/projects"), freshState());
    expect(await res!.json()).toEqual([]);
  });

  test("import -> list -> get", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    expect(imp).toMatchObject({ name: "Demo", deviceCount: 2, gaCount: 2 });
    expect(imp.id).toBeString();

    const list = (await (await handleApi(req("/api/projects"), state))!.json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: imp.id, name: "Demo", deviceCount: 2, gaCount: 2 });

    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    expect(proj.devices).toHaveLength(2);
    expect(proj.groupRanges[0].name).toBe("Licht");
    expect(proj.groupRanges[0].children[0].addresses).toHaveLength(2);
    expect(proj.interface).toMatchObject({ interfaceIp: "", port: 3671 });
  });

  test("import with wrong password -> error, nothing stored", async () => {
    const state = freshState();
    const res = await importDemo(state, "wrong");
    expect(res!.status).toBe(400);
    expect(await (await handleApi(req("/api/projects"), state))!.json()).toEqual([]);
  });

  test("get unknown project -> 404", async () => {
    const res = await handleApi(req("/api/projects/nope"), freshState());
    expect(res!.status).toBe(404);
  });

  test("interface round-trip per project", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    const res = await handleApi(req(`/api/projects/${imp.id}/interface`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ interfaceIp: "203.0.113.15", port: 3671 }),
    }), state);
    expect(await res!.json()).toMatchObject({ interfaceIp: "203.0.113.15", port: 3671 });
    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    expect(proj.interface.interfaceIp).toBe("203.0.113.15");
  });

  test("connect without an interface IP -> error", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    const res = await handleApi(req(`/api/projects/${imp.id}/bus/connect`, { method: "POST" }), state);
    expect(res!.status).toBe(400);
  });

  test("bus status is disconnected for a known project", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    const res = await handleApi(req(`/api/projects/${imp.id}/bus/status`), state);
    expect(await res!.json()).toMatchObject({ status: "disconnected", projectId: null });
  });

  test("delete removes the project", async () => {
    const state = freshState();
    const imp = (await (await importDemo(state))!.json()) as any;
    expect((await handleApi(req(`/api/projects/${imp.id}`, { method: "DELETE" }), state))!.status).toBe(200);
    expect(await (await handleApi(req("/api/projects"), state))!.json()).toEqual([]);
    expect((await handleApi(req(`/api/projects/${imp.id}`, { method: "DELETE" }), state))!.status).toBe(404);
  });

  test("non-api path returns null (falls through to static)", async () => {
    expect(await handleApi(req("/index.html"), freshState())).toBeNull();
  });
});
