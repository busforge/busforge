import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeGroupTpdu } from "../src/telegram.ts";
import { Bus } from "../src/bus.ts";
import { createState, handleApi } from "../src/app.ts";

const encFixture = readFileSync(
  join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-encrypted.knxproj"),
);

describe("telegram decoding", () => {
  test("GroupValueWrite with a 1-bit value", () => {
    // src 1.2.50, dst 0/0/1, APDU 00 81 -> write, value bit 1
    const t = decodeGroupTpdu(0x1232, 0x0001, Buffer.from([0x00, 0x81]), 1000);
    expect(t).toMatchObject({ src: "1.2.50", dst: "0/0/1", kind: "GroupValueWrite", raw: "01" });
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
    // reach into the private path the same way connect() wires it
    (bus as any).emit(decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 42));
    unsub();
    (bus as any).emit(decodeGroupTpdu(0, 2, Buffer.from([0x00, 0x81]), 42));
    expect(got).toEqual(["0/0/1"]);
  });
  test("status starts disconnected", () => expect(new Bus().status).toBe("disconnected"));

  test("buffers recent telegrams (oldest first) and caps the ring", () => {
    const bus = new Bus(() => 0);
    for (let i = 0; i < 600; i++) (bus as any).emit(decodeGroupTpdu(0, i, Buffer.from([0x00, 0x81]), 0));
    const recent = bus.recent();
    expect(recent).toHaveLength(500);
    // oldest 100 dropped: first kept is dst #100, last is #599
    expect(recent[0].dst).toBe("0/0/100");
    expect(recent[recent.length - 1].dst).toBe("0/2/87"); // 599 = 0/2/87
  });
});

describe("API", () => {
  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

  test("GET /api/project before import -> 404", async () => {
    const res = await handleApi(req("/api/project"), createState());
    expect(res!.status).toBe(404);
  });

  test("import then read project", async () => {
    const state = createState();
    const form = new FormData();
    form.set("file", new File([encFixture], "Demo.knxproj"));
    form.set("password", "tester12");
    const imp = await handleApi(req("/api/project/import", { method: "POST", body: form }), state);
    expect(await imp!.json()).toMatchObject({ name: "Demo", deviceCount: 2, gaCount: 2 });

    const proj = await handleApi(req("/api/project"), state);
    const body = (await proj!.json()) as any;
    expect(body.devices).toHaveLength(2);
    expect(body.groupRanges[0].name).toBe("Licht");
  });

  test("import with wrong password -> error", async () => {
    const state = createState();
    const form = new FormData();
    form.set("file", new File([encFixture], "Demo.knxproj"));
    form.set("password", "wrong");
    const res = await handleApi(req("/api/project/import", { method: "POST", body: form }), state);
    expect(res!.status).toBe(400);
  });

  test("settings round-trip", async () => {
    const state = createState();
    const res = await handleApi(
      req("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ interfaceIp: "203.0.113.15", port: 3671 }) }),
      state,
    );
    expect(await res!.json()).toMatchObject({ interfaceIp: "203.0.113.15", port: 3671 });
    expect(state.settings.interfaceIp).toBe("203.0.113.15");
  });

  test("bus status reports disconnected", async () => {
    const res = await handleApi(req("/api/bus/status"), createState());
    expect(await res!.json()).toMatchObject({ status: "disconnected" });
  });

  test("non-api path returns null (falls through to static)", async () => {
    expect(await handleApi(req("/index.html"), createState())).toBeNull();
  });
});
