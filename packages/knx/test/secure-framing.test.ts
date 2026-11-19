import { test, expect, describe } from "bun:test";
import { transferChunks } from "../src/device.ts";
import { SECURE_APDU_OVERHEAD } from "../src/secure.ts";

// A secured APDU carries its plain inner APDU plus 13 octets: its own A_Data_Secure TPCI/APCI pair,
// the SCF, the 6-byte sequence and the 4-byte MAC, with the whole inner APDU as the ciphertext. Every limit the plain path observes (the device's maximum APDU length, and what the
// interface path carries in one frame) therefore leaves 13 fewer data bytes per chunk.
describe("chunk sizes of a secured session", () => {
  test("the secure framing costs 13 octets", () => expect(SECURE_APDU_OVERHEAD).toBe(13));

  test("a plain session keeps today's sizes", () => {
    expect(transferChunks(233, false)).toEqual({ classicRead: 48, extRead: 48, extWrite: 32, propRead: 44, propWrite: 28 });
    expect(transferChunks(null, false)).toEqual({ classicRead: 12, extRead: 48, extWrite: 32, propRead: 44, propWrite: 28 });
  });

  test("a secured session leaves room for the framing on the path and in the device's APDU", () => {
    // Jung 400021SE (maximum APDU 233) on the test bench: 35 bytes read back, 48 did not.
    // Writes are the 22-byte memory chunks and 18-byte property elements ETS sends it there.
    expect(transferChunks(233, true)).toEqual({ classicRead: 35, extRead: 35, extWrite: 22, propRead: 31, propWrite: 18 });
    // A small device APDU is the binding limit: data + 5 (write) + 13 must not exceed it.
    const small = transferChunks(20, true);
    expect(small.extWrite + 5 + SECURE_APDU_OVERHEAD).toBeLessThanOrEqual(20);
    expect(small.extRead + 5 + SECURE_APDU_OVERHEAD).toBeLessThanOrEqual(20);
    expect(small.classicRead + 3 + SECURE_APDU_OVERHEAD).toBeLessThanOrEqual(20);
  });

  // ETS 6 sizes a secured write by the shorter of the device's and the interface's maximum APDU
  // (ETS6.log "NegotiateMaxApduLength -> 55, restricted by ByTargetDevice", "-> 40, restricted by
  // ByInterface"; the capture pin is tools/secure-chunks.test.ts), Busforge within the 55 shown answered.
  test("a secured write fits the device and the interface, within the 55 octets shown answered", () => {
    // MDT IP Router Secure (55) behind an interface announcing 210: ETS's 37 bytes and 33 elements.
    expect(transferChunks(55, true, 210)).toMatchObject({ extWrite: 37, propWrite: 33 });
    // The bench: an interface announcing 40.
    expect(transferChunks(233, true, 40)).toMatchObject({ extWrite: 22, propWrite: 18 });
    // A longer device and interface stay at 55, where ETS would go to 210 and fall back on a failure.
    expect(transferChunks(233, true, 210)).toMatchObject({ extWrite: 37, propWrite: 33 });
    // An interface that announces nothing: 40.
    expect(transferChunks(233, true, null)).toEqual(transferChunks(233, true));
    // Reads are not sized by the interface.
    expect(transferChunks(233, true, 210)).toMatchObject({ classicRead: 35, extRead: 35, propRead: 31 });
  });

  test("an interface too short for a secured write is named as the limit", () => {
    expect(() => transferChunks(233, true, 18)).toThrow(/interface's maximum APDU length of 18/);
  });

  test("where the framing leaves no data byte, the request is refused, not shrunk to nothing", () => {
    expect(() => transferChunks(18, true)).toThrow(/does not fit/);
    expect(() => transferChunks(null, true)).toThrow(/no maximum APDU length/);
  });
});
