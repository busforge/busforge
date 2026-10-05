import { test, expect, describe } from "bun:test";
import { toDiagnosticPackage, type CollectPackage, type CollectRecord, type DiagnosticContext } from "../src/index.ts";

// The diagnostic package keeps the device's answers and removes what identifies the installation
// beyond them: the ids, the connection's host, port and USB serial, and the device's serial number.

const rec = (r: Partial<CollectRecord>): CollectRecord => ({ step: "scan", space: "property", target: {}, source: "device", outcome: "bytes", at: 1, ...r });
const SERIAL = "00fa01020304";

function pkg(records: CollectRecord[], stop: CollectPackage["stop"] = null): CollectPackage {
  return {
    format: "busforge-raw-collect/1", ia: "1.1.203", mask: "MV-07B0", family: "system-b", secured: true, authorizeLevel: 0, maxApdu: 55,
    plan: null, records, limits: [], stop,
    counts: { requests: 3, scanRequests: 1, memoryRequests: 1, memoryBytes: 4, reconnects: 0 }, startedAt: 10, finishedAt: 20,
  };
}
const ctx = (over: Partial<DiagnosticContext> = {}): DiagnosticContext => ({
  busforge: { version: "0.0.1", commit: "abc1234" },
  connection: { kind: "ip", ipTransport: "tcp" },
  error: null,
  bus: { takenAt: 9, monitorClosedAt: null, releasedAt: 21 },
  secrets: ["project-uuid", "device-uuid", "task-uuid", "198.51.100.10:3671", "198.51.100.10"],
  ...over,
});

describe("toDiagnosticPackage", () => {
  test("removes the serial of object 0 PID 11 wherever it was read, and keeps its length", () => {
    const d = toDiagnosticPackage(pkg([
      rec({ step: "identity", target: { object: 0, pid: 11, start: 1, count: 1 }, source: "master-data", bytes: SERIAL }),
      rec({ target: { object: 0, pid: 11, start: 0, count: 1 }, bytes: "0001" }),
      rec({ target: { object: 0, pid: 11, start: 1, count: 1 }, bytes: SERIAL }),
      rec({ step: "serial number", space: "memory", target: { address: 0xb61a, length: 6 }, source: "master-data", bytes: SERIAL }),
      rec({ target: { object: 0, pid: 12, start: 1, count: 1 }, bytes: "0085" }),
      rec({ step: "application", space: "memory", target: { address: 0x4000, length: 4 }, bytes: "deadbeef" }),
    ]), ctx());
    const text = JSON.stringify(d);
    expect(text).not.toContain(SERIAL);
    expect(d.records.filter((r) => r.removed === "serial number, 6 bytes")).toHaveLength(3);
    // Element 0 is the element count, not the serial.
    expect(d.records[1].bytes).toBe("0001");
    // Everything else is the device's bytes, unchanged.
    expect(d.records[4].bytes).toBe("0085");
    expect(d.records[5].bytes).toBe("deadbeef");
    expect(d.cleaned.notAnonymized).toEqual(["memory bytes", "property bytes"]);
  });

  test("names the connection's kind and takes the host, the ids and the USB serial out of every text", () => {
    const d = toDiagnosticPackage(pkg([
      rec({ outcome: "timeout", detail: "no answer from 198.51.100.10:3671 for task-uuid" }),
    ], { reason: "interface", detail: "TUNNEL_CONNECT_TIMEOUT: 198.51.100.10 did not answer (project-uuid/device-uuid)" }), ctx({ error: "gateway 198.51.100.10:3671 gone" }));
    const text = JSON.stringify(d);
    for (const s of ["198.51.100.10", "project-uuid", "device-uuid", "task-uuid"]) expect(text).not.toContain(s);
    expect(d.stop?.detail).toBe("TUNNEL_CONNECT_TIMEOUT: <removed> did not answer (<removed>/<removed>)");
    expect(d.error).toBe("gateway <removed> gone");
    expect(d.connection).toEqual({ kind: "ip", ipTransport: "tcp" });
    expect(d).toMatchObject({ format: "busforge-diagnostic/1", ia: "1.1.203", mask: "MV-07B0", secured: true, startedAt: 10, finishedAt: 20 });
  });

  test("PID 11 of any object is a serial, and IP addresses leave every text, also the plan's reasons", () => {
    const p = pkg([
      rec({ target: { object: 3, pid: 11, start: 1, count: 1 }, bytes: SERIAL }),
      rec({ outcome: "connection-closed", detail: "connect ECONNREFUSED 203.0.113.40:3671 and fe80::1:2:3 at 14:03:30" }),
    ]);
    p.plan = { notAttempted: [{ name: "application", reason: "APP_PARSE: knx-gw.example 192.0.2.2" }] } as unknown as CollectPackage["plan"];
    const d = toDiagnosticPackage(p, ctx({ secrets: ["knx-gw.example"] }));
    expect(d.records[0]).toMatchObject({ removed: "serial number, 6 bytes" });
    expect(d.records[1].detail).toBe("connect ECONNREFUSED <removed> and <removed> at 14:03:30");
    expect(d.plan?.notAttempted[0].reason).toBe("APP_PARSE: <removed> <removed>");
  });

  test("IPv6 in every written form leaves the texts; times of day and versions stay", () => {
    const texts = ["fe80::1", "::1", "[fe80::1]:3671", "fe80::1%en0", "2001:db8::", "2001:db8::1", "2001:db8:0:0:0:0:0:1", "::ffff:192.0.2.5"];
    const d = toDiagnosticPackage(pkg(texts.map((t) => rec({ outcome: "timeout", detail: `connect to ${t} failed` }))), ctx({ secrets: [] }));
    for (const r of d.records) expect(r.detail).toBe("connect to <removed> failed");
    // An IPv4 address glued to a word.
    expect(toDiagnosticPackage(pkg([rec({ outcome: "timeout", detail: "eth0:x192.0.2.5" })]), ctx({ secrets: [] })).records[0].detail).toBe("eth0:x<removed>");
    const kept = "at 14:03:30, v0.4.199-13, object 3: PID 7, 0x0104";
    expect(toDiagnosticPackage(pkg([rec({ outcome: "timeout", detail: kept })]), ctx({ secrets: [] })).records[0].detail).toBe(kept);
  });

  test("a refused PID 11 read without a value claims no removed serial", () => {
    const d = toDiagnosticPackage(pkg([rec({ target: { object: 0, pid: 11, start: 1, count: 1 }, outcome: "refused", raw: "" })]), ctx());
    expect(d.records[0].removed).toBeUndefined();
  });

  test("a USB interface keeps its vendor and product id, never its serial", () => {
    const d = toDiagnosticPackage(pkg([rec({ outcome: "connection-closed", detail: "HID SN-4711 closed" })]), ctx({ connection: { kind: "usb", usbVendorId: 0x147b, usbProductId: 0x5120 }, secrets: ["SN-4711"] }));
    expect(d.connection).toEqual({ kind: "usb", usbVendorId: 0x147b, usbProductId: 0x5120 });
    expect(JSON.stringify(d)).not.toContain("SN-4711");
  });
});
