import { test, expect } from "bun:test";
import { decodeGroupApdu } from "../src/frame.ts";

// decodeGroupApdu owns the bus-level layout of an unnumbered group T_Data APDU: the
// 10-bit APCI (low 2 bits of octet 0 + all of octet 1), and the value split (trailing
// octets for a long APDU, the low 6 bits of octet 1 for the compact 2-byte form). The
// expected bytes below are hand-derived from the KNX APCI table.
test("classifies the three group services and Unknown", () => {
  expect(decodeGroupApdu(Buffer.from([0x00, 0x00])).apci).toBe("GroupValueRead");
  expect(decodeGroupApdu(Buffer.from([0x00, 0x40])).apci).toBe("GroupValueResponse");
  expect(decodeGroupApdu(Buffer.from([0x00, 0x80])).apci).toBe("GroupValueWrite");
  // 0x03c0 top bits set to a value that is none of the three -> Unknown (e.g. 0x0100)
  expect(decodeGroupApdu(Buffer.from([0x01, 0x00])).apci).toBe("Unknown");
});

test("compact 2-byte APDU carries a 6-bit value in octet 1", () => {
  // GroupValueWrite of a 1-bit value 1: octet1 = 0x80 | 0x01
  const { apci, value } = decodeGroupApdu(Buffer.from([0x00, 0x81]));
  expect(apci).toBe("GroupValueWrite");
  expect(value.equals(Buffer.from([0x01]))).toBe(true); // low 6 bits only
});

test("long APDU (>2 bytes) carries the value in the trailing octets", () => {
  const { apci, value } = decodeGroupApdu(Buffer.from([0x00, 0x80, 0xab, 0xcd]));
  expect(apci).toBe("GroupValueWrite");
  expect(value.equals(Buffer.from([0xab, 0xcd]))).toBe(true);
});
