import { test, expect, describe } from "bun:test";
import { decodeCertificate, encodeCertificate } from "../src/certificate.ts";

// Synthetic serial and key, never a real device's. The decoder itself was checked once against a
// real label: its serial matched the device, and its key decrypted ETS's activation of that device.
const serial = Buffer.from("00fa01020304", "hex");
const fdsk = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

describe("the device certificate label", () => {
  test("decodes to the serial and key it was made from, in groups or not, in any case", () => {
    const label = encodeCertificate(serial, fdsk);
    expect(label).toMatch(/^([A-Z2-7]{6}-){5}[A-Z2-7]{6}$/);
    for (const text of [label, label.replace(/-/g, ""), label.toLowerCase(), ` ${label} `]) {
      expect(decodeCertificate(text)).toEqual({ serial, fdsk });
    }
  });

  test("a mistyped character fails the checksum instead of yielding a wrong key", () => {
    const label = encodeCertificate(serial, fdsk).replace(/-/g, "");
    let caught = 0;
    for (let i = 0; i < label.length; i++) {
      const typo = label.slice(0, i) + (label[i] === "A" ? "B" : "A") + label.slice(i + 1);
      try { decodeCertificate(typo); } catch (e) { if ((e as { code?: string }).code === "CERTIFICATE_INVALID") caught++; }
    }
    expect(caught).toBe(label.length);
  });

  test("a label of the wrong length or alphabet is refused", () => {
    expect(() => decodeCertificate("AAAAAA-BBBBBB")).toThrow(/36 base32/);
    expect(() => decodeCertificate("0".repeat(36))).toThrow(/36 base32/);
  });
});
