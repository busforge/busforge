import { test, expect, describe } from "bun:test";
import { SecureSession } from "../src/secureSession.ts";

const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const US = 0xff67;   // 15.15.103
const DEV = 0xff00;  // 15.15.0

describe("SecureSession round-trip (two parties, shared tool key)", () => {
  test("client wraps a management APDU; the device side recovers it", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 4n });
    const device = new SecureSession({ toolKey, src: DEV, dst: US });
    const service = Buffer.from("0300", "hex"); // A_DeviceDescriptor_Read
    const wrapped = client.wrapManagement(service, 0);
    expect(device.unwrap(wrapped)).toEqual({ status: "ok", apdu: service });
  });

  test("the device's secured response is recovered by the client", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV });
    const device = new SecureSession({ toolKey, src: DEV, dst: US, seq: 10n });
    const response = Buffer.from("0340abcd", "hex"); // A_DeviceDescriptor_Response + data
    expect(client.unwrap(device.wrapManagement(response, 0))).toEqual({ status: "ok", apdu: response });
  });

  test("a tampered secure frame is invalid (never unauthenticated data)", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV });
    const device = new SecureSession({ toolKey, src: DEV, dst: US });
    const wrapped = client.wrapManagement(Buffer.from("0300", "hex"), 0);
    wrapped[wrapped.length - 1] ^= 0xff;
    expect(device.unwrap(wrapped)).toEqual({ status: "invalid" });
  });

  test("the sequence counter advances per sent frame and never repeats", () => {
    const s = new SecureSession({ toolKey, src: US, dst: DEV, seq: 7n });
    s.wrapManagement(Buffer.from("0300", "hex"), 0);
    s.wrapManagement(Buffer.from("0300", "hex"), 1);
    expect(s.sequence).toBe(9n);
  });

  test("setSequence only ever moves forward (Sync can advance, not rewind)", () => {
    const s = new SecureSession({ toolKey, src: US, dst: DEV, seq: 5n });
    s.setSequence(3n);
    expect(s.sequence).toBe(5n);
    s.setSequence(20n);
    expect(s.sequence).toBe(20n);
  });

  test("a replayed (MAC-valid) frame is delivered once, then flagged replay (not invalid)", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 4n });
    const device = new SecureSession({ toolKey, src: DEV, dst: US });
    const service = Buffer.from("0300", "hex");
    const wrapped = client.wrapManagement(service, 0); // carries seq 4
    // First delivery: authentic, delivered.
    expect(device.unwrap(wrapped)).toEqual({ status: "ok", apdu: service });
    // Bit-identical re-delivery (a retransmission after a lost T_ACK): same MAC, same seq.
    // It is a replay, NOT invalid: the caller must still ACK it but not re-deliver.
    expect(device.unwrap(Buffer.from(wrapped))).toEqual({ status: "replay" });
  });

  test("a fresh frame after a replay still delivers (window only blocks the stale seq)", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 4n });
    const device = new SecureSession({ toolKey, src: DEV, dst: US });
    const first = client.wrapManagement(Buffer.from("0300", "hex"), 0);  // seq 4
    const second = client.wrapManagement(Buffer.from("0301", "hex"), 1); // seq 5
    expect(device.unwrap(first).status).toBe("ok");
    expect(device.unwrap(Buffer.from(first))).toEqual({ status: "replay" }); // replay of seq 4
    expect(device.unwrap(second)).toEqual({ status: "ok", apdu: Buffer.from("0301", "hex") }); // seq 5 delivered
  });

  test("the peer's sequence is the last one it was seen to use, none before any authentic frame", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 4n });
    const device = new SecureSession({ toolKey, src: DEV, dst: US });
    expect(device.peerSequence).toBeNull();
    const first = client.wrapManagement(Buffer.from("0300", "hex"), 0); // seq 4
    const tampered = Buffer.from(first);
    tampered[tampered.length - 1] ^= 0xff;
    device.unwrap(tampered);
    expect(device.peerSequence).toBeNull();
    device.unwrap(first);
    device.unwrap(Buffer.from(first)); // a replay does not move it
    expect(device.peerSequence).toBe(4n);
  });

  test("a failed MAC does not advance the replay window", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 4n });
    const device = new SecureSession({ toolKey, src: DEV, dst: US });
    const good = client.wrapManagement(Buffer.from("0300", "hex"), 0); // seq 4
    const tampered = Buffer.from(good);
    tampered[tampered.length - 1] ^= 0xff;
    expect(device.unwrap(tampered)).toEqual({ status: "invalid" }); // dropped, must not consume seq 4
    expect(device.receiveSequence).toBe(0n);
    expect(device.unwrap(good).status).toBe("ok"); // the authentic seq-4 frame still lands
  });
});

// Vectors reproduced byte-for-byte from Calimero's SecureApplicationLayerTest:
// https://github.com/calimero-project/calimero-core/blob/118b2cb4db6782d76d218d07103589160e9f40a0/test/io/calimero/secure/SecureApplicationLayerTest.java
// (constants encryptedSyncReq / encryptedSyncRes, exercised by the encryptSyncRequest
// and encryptSyncResponse test methods).
describe("SecureSession Sync (Calimero vectors)", () => {
  test("buildSyncRequest reproduces the Calimero encryptSyncRequest vector byte-for-byte", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 1n });
    const wire = client.buildSyncRequest(Buffer.alloc(6), Buffer.from("000000000003", "hex"), 0);
    expect(wire.toString("hex")).toBe("43f192" + "000000000001" + "000000000000" + "c1cf4506f09b" + "d79fab55");
  });

  test("applySyncResponse verifies the MAC and adopts our next sequence", () => {
    // Calimero encryptSyncResponse vector: random forced to aa..aa, challenge = 3,
    // so the on-wire seq slot is aa..a9 = random XOR challenge. Decoded as the client
    // (response comes from the device), the MAC must verify. The vector's client starts at 1.
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 1n });
    const vector = Buffer.from("43f193aaaaaaaaaaa99c023ad25e146470693e638d5b70cac4", "hex");
    const res = client.applySyncResponse(vector, Buffer.from("000000000003", "hex"));
    expect(res).not.toBeNull();
    expect(client.sequence).toBe(res!.ourSeq);
    // The Sync seeds the replay window from the device's declared next sequence, so a
    // frame recorded before this session (seq < deviceSeq) cannot replay into it.
    expect(client.receiveSequence).toBe(res!.deviceSeq);
    // Everything below its declared next sequence the device has used.
    expect(client.peerSequence).toBe(res!.deviceSeq - 1n);
  });
});

describe("where a session's tool sequence starts", () => {
  test("milliseconds since 2018, so each session starts above the last", async () => {
    const { toolSequenceNow } = await import("../src/secureSession.ts");
    expect(toolSequenceNow(Date.UTC(2018, 0, 1) + 5)).toBe(5n);
    const a = new SecureSession({ toolKey: Buffer.alloc(16), src: 1, dst: 2 }).sequence;
    await new Promise((r) => setTimeout(r, 5));
    expect(new SecureSession({ toolKey: Buffer.alloc(16), src: 1, dst: 2 }).sequence).toBeGreaterThan(a);
  });
});
