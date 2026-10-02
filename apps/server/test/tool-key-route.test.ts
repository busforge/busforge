import { test, expect, describe, mock, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDeviceSecurity, putDeviceSecurity } from "../src/db/deviceSecurity.ts";
import { putDeviceCertificate } from "../src/db/deviceCertificates.ts";

// PUT /devices/:deviceId/tool-key: a tool key deposited by hand is stored only after the device
// answered a secure Sync under it. The secure identification is stubbed; the route, the key store
// and the sealing below it are real.
const real = await import("../src/deviceprofile.ts");
const realIdentify = real.secureIdentify;
let identifyImpl: typeof realIdentify = realIdentify;
await mock.module("../src/deviceprofile.ts", () => ({
  ...real,
  secureIdentify: (...a: Parameters<typeof realIdentify>) => identifyImpl(...a),
}));
const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;
afterAll(() => { identifyImpl = realIdentify; });

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const fixture = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"));
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jsonReq = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function project(withConnection = true): Promise<{ state: AppState; projectId: string; deviceId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-toolkey-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([fixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
  if (withConnection) {
    const conn = (await (await handleApi(req("/api/connections", jsonReq("POST", { type: "ip", name: "GW", host: "198.51.100.10", port: 3671 })), state))!.json()) as any;
    await handleApi(req(`/api/projects/${imp.id}/connection`, jsonReq("PUT", { connectionId: conn.id })), state);
  }
  return { state, projectId: imp.id, deviceId: proj.devices[0].id };
}

const KEY = "00112233445566778899aabbccddeeff";
const SERIAL = "00fa01020304";
const deposit = async (p: { state: AppState; projectId: string; deviceId: string }, body: unknown) => {
  const res = (await handleApi(req(`/api/projects/${p.projectId}/devices/${p.deviceId}/tool-key`, jsonReq("PUT", body)), p.state))!;
  return { status: res.status, body: (await res.json()) as any };
};
// A device that answers the Sync under exactly `key` with `serial`, and reports `peer` as the last
// sequence it sent. Records every key it was asked with.
function deviceHolding(key: string, serial: string, peer = 4711n, mode = "on", readSerial: string | null = serial) {
  const tried: { key: string; serial: string }[] = [];
  identifyImpl = async (_conn, _ia, creds) => {
    tried.push({ key: creds!.toolKey.toString("hex"), serial: creds!.serial.toString("hex") });
    creds!.onPeerSequence?.(peer);
    if (creds!.toolKey.toString("hex") !== key || creds!.serial.toString("hex") !== serial) {
      throw Object.assign(new Error("no answer"), { code: "SECURE_SYNC_NO_RESPONSE" });
    }
    return { secure: true, mask: "MV-07B0", serial: readSerial, securityMode: { state: mode } } as Awaited<ReturnType<typeof realIdentify>>;
  };
  return tried;
}
const stored = (p: { state: AppState; projectId: string; deviceId: string }) => getDeviceSecurity(p.state.db, p.projectId, p.deviceId, p.state.masterKey);

describe("depositing a tool key by hand", () => {
  test("a key the device answers the Sync under is stored as manual, with the sequence it sent", async () => {
    const p = await project();
    const tried = deviceHolding(KEY, SERIAL);
    const r = await deposit(p, { toolKey: KEY, serial: SERIAL });
    expect(r).toEqual({ status: 200, body: { serial: SERIAL, source: "manual" } });
    expect(tried).toEqual([{ key: KEY, serial: SERIAL }]);
    const s = stored(p)!;
    expect(s.toolKey.toString("hex")).toBe(KEY);
    expect(s.serialNumber.toString("hex")).toBe(SERIAL);
    expect(s.source).toBe("manual");
    expect(s.sequenceNumber).toBe("4711");
    // The project now lists the device as secure.
    const proj = (await (await handleApi(req(`/api/projects/${p.projectId}`), p.state))!.json()) as any;
    expect(proj.devices.find((d: any) => d.id === p.deviceId).secure).toBe(true);
  });

  test("a key the device does not answer is refused and the key on file stays", async () => {
    const p = await project();
    const old = Buffer.alloc(16, 7);
    putDeviceSecurity(p.state.db, p.projectId, [{ deviceId: p.deviceId, toolKey: old, serialNumber: Buffer.from(SERIAL, "hex"), sequenceNumber: "12", source: "import" }], p.state.masterKey);
    deviceHolding(old.toString("hex"), SERIAL);
    const r = await deposit(p, { toolKey: KEY });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("SECURE_SYNC_NO_RESPONSE");
    const s = stored(p)!;
    expect(s.toolKey.equals(old)).toBe(true);
    expect(s.source).toBe("import");
  });

  test("nothing is stored for a device without a key on file when the Sync fails", async () => {
    const p = await project();
    deviceHolding("ff".repeat(16), SERIAL);
    expect((await deposit(p, { toolKey: KEY, serial: SERIAL })).body.error.code).toBe("SECURE_SYNC_NO_RESPONSE");
    expect(stored(p)).toBeNull();
  });

  test("the serial comes from the key on file, or else from the stored certificate", async () => {
    const p = await project();
    putDeviceCertificate(p.state.db, p.projectId, { deviceId: p.deviceId, fdsk: Buffer.alloc(16, 0xfd), serialNumber: Buffer.from(SERIAL, "hex") }, p.state.masterKey);
    const tried = deviceHolding(KEY, SERIAL);
    expect((await deposit(p, { toolKey: KEY })).status).toBe(200);
    expect(tried).toEqual([{ key: KEY, serial: SERIAL }]);

    const q = await project();
    putDeviceSecurity(q.state.db, q.projectId, [{ deviceId: q.deviceId, toolKey: Buffer.alloc(16, 7), serialNumber: Buffer.from(SERIAL, "hex"), sequenceNumber: "", source: "import" }], q.state.masterKey);
    deviceHolding(KEY, SERIAL);
    expect((await deposit(q, { toolKey: KEY })).status).toBe(200);
    expect(stored(q)!.toolKey.toString("hex")).toBe(KEY);
  });

  test("without a serial on file or in the request, nothing is sent to the device", async () => {
    const p = await project();
    const tried = deviceHolding(KEY, SERIAL);
    expect((await deposit(p, { toolKey: KEY })).body.error.code).toBe("TOOL_KEY_SERIAL_MISSING");
    expect(tried).toEqual([]);
  });

  test("a serial that contradicts the one on file is refused before the bus", async () => {
    const p = await project();
    putDeviceCertificate(p.state.db, p.projectId, { deviceId: p.deviceId, fdsk: Buffer.alloc(16, 0xfd), serialNumber: Buffer.from(SERIAL, "hex") }, p.state.masterKey);
    const tried = deviceHolding(KEY, "00fa09090909");
    expect((await deposit(p, { toolKey: KEY, serial: "00fa09090909" })).body.error.code).toBe("TOOL_KEY_SERIAL_MISMATCH");
    expect(tried).toEqual([]);
  });

  test("a malformed key or serial is refused before the bus", async () => {
    const p = await project();
    const tried = deviceHolding(KEY, SERIAL);
    for (const body of [{}, { toolKey: "0011" }, { toolKey: KEY + "00" }, { toolKey: "zz".repeat(16), serial: SERIAL }, { toolKey: KEY, serial: "00fa0102" }, { toolKey: 5, serial: SERIAL }]) {
      expect((await deposit(p, body)).body.error.code).toBe("TOOL_KEY_INVALID");
    }
    expect(tried).toEqual([]);
  });

  test("a key typed with spaces, dashes or colons and in upper case is accepted", async () => {
    const p = await project();
    deviceHolding(KEY, SERIAL);
    const typed = KEY.toUpperCase().match(/../g)!.join(" ");
    expect((await deposit(p, { toolKey: typed, serial: "00-FA-01-02-03-04" })).status).toBe(200);
    expect(stored(p)!.toolKey.toString("hex")).toBe(KEY);
  });

  test("depositing the key busforge already provisioned keeps it marked as busforge's own", async () => {
    const p = await project();
    putDeviceSecurity(p.state.db, p.projectId, [{ deviceId: p.deviceId, toolKey: Buffer.from(KEY, "hex"), serialNumber: Buffer.from(SERIAL, "hex"), sequenceNumber: "", source: "provisioned" }], p.state.masterKey);
    deviceHolding(KEY, SERIAL);
    expect((await deposit(p, { toolKey: KEY })).body).toEqual({ serial: SERIAL, source: "provisioned" });
    expect(stored(p)!.source).toBe("provisioned");
  });

  test("a key the device answers with its security mode off (its factory key) is refused", async () => {
    const p = await project();
    deviceHolding(KEY, SERIAL, 4711n, "off");
    expect((await deposit(p, { toolKey: KEY, serial: SERIAL })).body.error.code).toBe("TOOL_KEY_SECURITY_MODE_OFF");
    expect(stored(p)).toBeNull();
  });

  test("a device that reads back another serial inside the session is refused", async () => {
    const p = await project();
    deviceHolding(KEY, SERIAL, 4711n, "on", "00fa09090909");
    expect((await deposit(p, { toolKey: KEY, serial: SERIAL })).body.error.code).toBe("TOOL_KEY_SERIAL_MISMATCH");
    expect(stored(p)).toBeNull();
  });

  test("depositing a pending key the device answers under marks it provisioned", async () => {
    const p = await project();
    putDeviceSecurity(p.state.db, p.projectId, [{ deviceId: p.deviceId, toolKey: Buffer.from(KEY, "hex"), serialNumber: Buffer.from(SERIAL, "hex"), sequenceNumber: "", source: "pending" }], p.state.masterKey);
    deviceHolding(KEY, SERIAL);
    expect((await deposit(p, { toolKey: KEY })).body.source).toBe("provisioned");
    expect(stored(p)!.source).toBe("provisioned");
  });

  test("an unknown device and a project without a bus connection are refused", async () => {
    const p = await project(false);
    const tried = deviceHolding(KEY, SERIAL);
    expect((await deposit(p, { toolKey: KEY, serial: SERIAL })).body.error.code).toBe("INTERFACE_NOT_SET");
    expect((await deposit({ ...p, deviceId: "nope" }, { toolKey: KEY, serial: SERIAL })).status).toBe(404);
    expect(tried).toEqual([]);
  });
});
