import { test, expect, describe } from "bun:test";
import { transferChunks } from "../src/device.ts";
import { SECURE_APDU_OVERHEAD } from "../src/secure.ts";

// A secured APDU carries its plain inner APDU plus 13 octets: its own A_Data_Secure TPCI/APCI pair,
// the SCF, the 6-byte sequence and the 4-byte MAC, with the whole inner APDU as the ciphertext. Every limit the plain path observes (the device's maximum APDU length, and what the
// interface path carries in one frame) therefore leaves 13 fewer data bytes per chunk.
describe("chunk sizes of a secured session", () => {
  test("the secure framing costs 13 octets", () => expect(SECURE_APDU_OVERHEAD).toBe(13));

  test("a plain session keeps today's sizes", () => {
    expect(transferChunks(233, false)).toEqual({ classicRead: 48, extRead: 48, extWrite: 32 });
    expect(transferChunks(null, false)).toEqual({ classicRead: 12, extRead: 48, extWrite: 32 });
  });

  test("a secured session leaves room for the framing on the path and in the device's APDU", () => {
    // Jung 400021SE (maximum APDU 233) over the bench: 35 bytes read back on 2026-09-28, 48 did not.
    expect(transferChunks(233, true)).toEqual({ classicRead: 35, extRead: 35, extWrite: 19 });
    // A small device APDU is the binding limit: data + 5 (write) + 13 must not exceed it.
    const small = transferChunks(20, true);
    expect(small.extWrite + 5 + SECURE_APDU_OVERHEAD).toBeLessThanOrEqual(20);
    expect(small.extRead + 5 + SECURE_APDU_OVERHEAD).toBeLessThanOrEqual(20);
    expect(small.classicRead + 3 + SECURE_APDU_OVERHEAD).toBeLessThanOrEqual(20);
  });

  test("where the framing leaves no data byte, the request is refused, not shrunk to nothing", () => {
    expect(() => transferChunks(18, true)).toThrow(/does not fit/);
    expect(() => transferChunks(null, true)).toThrow(/no maximum APDU length/);
  });
});
