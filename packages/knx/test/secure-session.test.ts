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
    expect(device.unwrap(wrapped)).toEqual(service);
  });

  test("the device's secured response is recovered by the client", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV });
    const device = new SecureSession({ toolKey, src: DEV, dst: US, seq: 10n });
    const response = Buffer.from("0340abcd", "hex"); // A_DeviceDescriptor_Response + data
    expect(client.unwrap(device.wrapManagement(response, 0))).toEqual(response);
  });

  test("a tampered secure frame does not unwrap (null, never unauthenticated data)", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV });
    const device = new SecureSession({ toolKey, src: DEV, dst: US });
    const wrapped = client.wrapManagement(Buffer.from("0300", "hex"), 0);
    wrapped[wrapped.length - 1] ^= 0xff;
    expect(device.unwrap(wrapped)).toBeNull();
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
});

describe("SecureSession Sync (Calimero vectors)", () => {
  test("buildSyncRequest reproduces the Calimero encryptSyncRequest vector byte-for-byte", () => {
    const client = new SecureSession({ toolKey, src: US, dst: DEV, seq: 1n });
    const wire = client.buildSyncRequest(Buffer.alloc(6), Buffer.from("000000000003", "hex"), 0);
    expect(wire.toString("hex")).toBe("43f192" + "000000000001" + "000000000000" + "c1cf4506f09b" + "d79fab55");
  });

  test("applySyncResponse verifies the MAC and adopts our next sequence", () => {
    // Calimero encryptSyncResponse vector: random forced to aa..aa, challenge = 3,
    // so the on-wire seq slot is aa..a9 = random XOR challenge. Decoded as the client
    // (response comes from the device), the MAC must verify.
    const client = new SecureSession({ toolKey, src: US, dst: DEV });
    const vector = Buffer.from("43f193aaaaaaaaaaa99c023ad25e146470693e638d5b70cac4", "hex");
    const res = client.applySyncResponse(vector, Buffer.from("000000000003", "hex"));
    expect(res).not.toBeNull();
    expect(client.sequence).toBe(res!.ourSeq);
  });
});
