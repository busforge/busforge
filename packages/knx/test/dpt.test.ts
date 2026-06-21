import { test, expect, describe } from "bun:test";
import { decodeDpt } from "../src/dpt.ts";

describe("decodeDpt", () => {
  test("DPT 1 booleans with subtype labels", () => {
    expect(decodeDpt("01", "1.001")).toBe("On");
    expect(decodeDpt("00", "1.001")).toBe("Off");
    expect(decodeDpt("01", "1.008")).toBe("Down");
    expect(decodeDpt("00", "1.009")).toBe("Open");
    expect(decodeDpt("01", "1.100")).toBe("Heating");
  });

  test("DPT 3 dimming control", () => {
    expect(decodeDpt("09", "3.007")).toBe("Increase 1");
    expect(decodeDpt("03", "3.007")).toBe("Decrease 3");
    expect(decodeDpt("00", "3.007")).toBe("Break");
  });

  test("DPT 5 scaling", () => {
    expect(decodeDpt("ff", "5.001")).toBe("100 %");
    expect(decodeDpt("80", "5.001")).toBe("50 %");
    expect(decodeDpt("64", "5.004")).toBe("100 %");
    expect(decodeDpt("0a", "5.010")).toBe("10");
  });

  test("DPT 9 two-byte float with units", () => {
    expect(decodeDpt("0c4e", "9.001")).toBe("22.04 °C"); // exp 1, mant 1102 -> 0.01*1102*2
    expect(decodeDpt("0000", "9.001")).toBe("0 °C");
    expect(decodeDpt("8a24", "9.001")).toBe("-30 °C"); // negative mantissa
    expect(decodeDpt("0c4e", "9.004")).toBe("22.04 lx");
  });

  test("DPT 14 four-byte IEEE float", () => {
    expect(decodeDpt("41a80000", "14.027")).toBe("21 V"); // 21.0
    expect(decodeDpt("42c80000", "14.056")).toBe("100 W");
  });

  test("DPT 17 scene", () => {
    expect(decodeDpt("00", "17.001")).toBe("Scene 1");
    expect(decodeDpt("04", "17.001")).toBe("Scene 5");
  });

  test("DPT 20 HVAC mode", () => {
    expect(decodeDpt("01", "20.102")).toBe("Comfort");
    expect(decodeDpt("03", "20.102")).toBe("Economy");
  });

  test("DPT 10/11 time and date", () => {
    expect(decodeDpt("4a1e00", "10.001")).toBe("Tue 10:30:00"); // day 2, 10:30:00
    expect(decodeDpt("15061a", "11.001")).toBe("21.06.2026");
  });

  test("coarse DPTs without a subtype still decode", () => {
    expect(decodeDpt("01", "1.*")).toBe("On");      // DPT-1 without subtype
    expect(decodeDpt("0c4e", "9.*")).toBe("22.04"); // DPT-9 without subtype, no unit
    expect(decodeDpt("01", "1")).toBe("On");         // bare main
  });

  test("short or malformed payloads fall back to hex (no garbage)", () => {
    expect(decodeDpt("15", "11.001")).toBe("0x15");  // date needs 3 bytes
    expect(decodeDpt("ab", "12.001")).toBe("0xab");  // u32 needs 4 bytes
    expect(decodeDpt("00", "9.001")).toBe("0x00");   // 1 byte is short for DPT 9 (needs 2)
  });

  test("unknown or empty DPT falls back to hex", () => {
    expect(decodeDpt("4262cccd", undefined)).toBe("0x4262cccd");
    expect(decodeDpt("ab", "")).toBe("0xab");
  });
});
