import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeyring } from "@busforge/project";
import { handleApi, createState } from "../src/app.ts";
import { putDeviceSecurity } from "../src/db/deviceSecurity.ts";
import { putDeviceCertificate } from "../src/db/deviceCertificates.ts";
import { putGroupKeys } from "../src/db/groupKeys.ts";
import { putGroupSenders } from "../src/db/groupSenders.ts";

// POST /keyring: the project's Data Secure keys as an ETS keyring, read back here with the same
// reader that checks the ETS known-answer files (packages/project/test/keyring.test.ts).
type AppState = ReturnType<typeof createState>;
const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const fixture = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"));
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function project(): Promise<{ state: AppState; projectId: string; devices: { id: string; ia: string }[] }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-keyring-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => Date.UTC(2026, 9, 2, 8, 0, 0) });
  const form = new FormData();
  form.set("file", new File([fixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
  // The fixture's own keys are cleared so each test states exactly what the store holds.
  for (const t of ["device_security", "group_keys", "group_senders", "device_certificates"]) state.db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(imp.id);
  // A second device, copied from the fixture's one under another address.
  const cols = (state.db.query("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name).filter((c) => c !== "id" && c !== "instance_id" && c !== "ia");
  state.db.prepare(`INSERT INTO devices (instance_id, ia, ${cols.join(", ")}) SELECT 'second', '1.1.250', ${cols.join(", ")} FROM devices WHERE project_id = ? AND instance_id = ?`).run(imp.id, proj.devices[0].id);
  return { state, projectId: imp.id, devices: [{ id: proj.devices[0].id, ia: proj.devices[0].ia }, { id: "second", ia: "1.1.250" }] };
}
const hex = (h: string) => Buffer.from(h, "hex");
const call = async (p: { state: AppState; projectId: string }, body: unknown) => (await handleApi(req(`/api/projects/${p.projectId}/keyring`, post(body)), p.state))!;

describe("POST /api/projects/:id/keyring", () => {
  test("carries tool keys, certificates, group keys and senders, signed under the password", async () => {
    const p = await project();
    const [a, b] = p.devices;
    putDeviceSecurity(p.state.db, p.projectId, [{ deviceId: a.id, toolKey: hex("00112233445566778899aabbccddeeff"), serialNumber: hex("000a00000407"), sequenceNumber: "275729203974", source: "provisioned" }], p.state.masterKey);
    putDeviceCertificate(p.state.db, p.projectId, { deviceId: a.id, fdsk: hex("ffeeddccbbaa99887766554433221100"), serialNumber: hex("000a00000407") }, p.state.masterKey);
    putDeviceCertificate(p.state.db, p.projectId, { deviceId: b.id, fdsk: hex("0102030405060708090a0b0c0d0e0f10"), serialNumber: hex("00fa01020304") }, p.state.masterKey);
    putGroupKeys(p.state.db, p.projectId, [{ raw: 1, key: hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"), source: "generated" }], p.state.masterKey);
    p.state.db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, 'x', 0, 1)").run(p.projectId, a.id);
    putGroupSenders(p.state.db, p.projectId, [{ gaRaw: 1, ia: "1.2.250", source: "busforge" }]);

    const res = await call(p, { password: "test-pw" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/\.knxkeys"$/);
    const k = readKeyring(await res.text(), "test-pw");
    expect(k.created).toBe("2026-10-02T08:00:00");
    expect(k.createdBy).toBe("Busforge");
    const da = k.devices.find((d) => d.individualAddress === a.ia)!;
    expect(Buffer.from(da.toolKey!).toString("hex")).toBe("00112233445566778899aabbccddeeff");
    expect(Buffer.from(da.fdsk!).toString("hex")).toBe("ffeeddccbbaa99887766554433221100");
    expect(Buffer.from(da.serialNumber!).toString("hex")).toBe("000a00000407");
    expect(da.sequenceNumber).toBe(275729203974n);
    // A device with only a certificate: what ETS takes over after a master reset.
    const db = k.devices.find((d) => d.individualAddress === b.ia)!;
    expect(db.toolKey).toBeUndefined();
    expect(Buffer.from(db.fdsk!).toString("hex")).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(k.groups.map((g) => [g.address, Buffer.from(g.key).toString("hex")])).toEqual([[1, "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"]]);
    expect(k.interfaces).toEqual([{ individualAddress: "1.2.250", groups: [{ address: 1, senders: [a.ia] }] }]);
  });

  test("an unconfirmed (pending) tool key is not stated, an unknown sequence is left out", async () => {
    const p = await project();
    const [a, b] = p.devices;
    putDeviceSecurity(p.state.db, p.projectId, [
      { deviceId: a.id, toolKey: hex("00112233445566778899aabbccddeeff"), serialNumber: hex("000a00000407"), sequenceNumber: "", source: "manual" },
      { deviceId: b.id, toolKey: hex("ffeeddccbbaa99887766554433221100"), serialNumber: hex("00fa01020304"), sequenceNumber: "5", source: "pending" },
    ], p.state.masterKey);
    putDeviceCertificate(p.state.db, p.projectId, { deviceId: b.id, fdsk: hex("0102030405060708090a0b0c0d0e0f10"), serialNumber: hex("00fa01020304") }, p.state.masterKey);
    const k = readKeyring(await (await call(p, { password: "pw" })).text(), "pw");
    const da = k.devices.find((d) => d.individualAddress === a.ia)!;
    expect(da.toolKey).toBeDefined();
    expect(da.sequenceNumber).toBeUndefined();
    const db = k.devices.find((d) => d.individualAddress === b.ia)!;
    expect(db.toolKey).toBeUndefined();
    expect(Buffer.from(db.fdsk!).toString("hex")).toBe("0102030405060708090a0b0c0d0e0f10");
  });

  test("the password is trimmed as for the .busforge export, and blank is refused", async () => {
    const p = await project();
    putGroupKeys(p.state.db, p.projectId, [{ raw: 1, key: hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"), source: "generated" }], p.state.masterKey);
    const res = await call(p, { password: "  geheim " });
    expect(readKeyring(await res.text(), "geheim").groups).toHaveLength(1);
    const blank = await call(p, { password: "   " });
    expect(((await blank.json()) as any).error.code).toBe("KEYRING_PASSWORD_INVALID");
  });

  test("a key of a device placed without an address is refused as such", async () => {
    const p = await project();
    p.state.db.prepare("UPDATE devices SET ia = '1.1.NaN' WHERE project_id = ? AND instance_id = 'second'").run(p.projectId);
    putDeviceCertificate(p.state.db, p.projectId, { deviceId: "second", fdsk: hex("0102030405060708090a0b0c0d0e0f10"), serialNumber: hex("00fa01020304") }, p.state.masterKey);
    const res = await call(p, { password: "pw" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("KEYRING_DEVICE_UNPLACED");
    const nul = await handleApi(req(`/api/projects/${p.projectId}/keyring`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" }), p.state);
    expect(nul!.status).toBe(400);
  });

  test("a project without keys is refused, not exported empty", async () => {
    const p = await project();
    const res = await call(p, { password: "pw" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("KEYRING_EMPTY");
  });

  test("a missing or non-ASCII password is refused", async () => {
    const p = await project();
    putGroupKeys(p.state.db, p.projectId, [{ raw: 1, key: hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"), source: "generated" }], p.state.masterKey);
    const none = await call(p, {});
    expect(none.status).toBe(400);
    expect(((await none.json()) as any).error.code).toBe("KEYRING_PASSWORD_INVALID");
    const umlaut = await call(p, { password: "pässword" });
    expect(((await umlaut.json()) as any).error.code).toBe("KEYRING_PASSWORD_INVALID");
  });
});
