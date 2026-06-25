import { test, expect, describe } from "bun:test";
import { isSecondsUnit, formatDuration, parseDuration, isValidIPv4 } from "./paramFormat.ts";

describe("isSecondsUnit", () => {
  test("treats undefined and Seconds as second-based (duration-editable)", () => {
    expect(isSecondsUnit(undefined)).toBe(true);
    expect(isSecondsUnit("Seconds")).toBe(true);
  });
  test("other units are not second-based (raw integer + suffix)", () => {
    expect(isSecondsUnit("Milliseconds")).toBe(false);
    expect(isSecondsUnit("Minutes")).toBe(false);
  });
});

describe("formatDuration", () => {
  test("formats seconds as zero-padded hh:mm:ss", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(30)).toBe("00:00:30");
    expect(formatDuration(60)).toBe("00:01:00");
    expect(formatDuration(300)).toBe("00:05:00");
    expect(formatDuration(3600)).toBe("01:00:00");
    expect(formatDuration(3661)).toBe("01:01:01");
    expect(formatDuration(65535)).toBe("18:12:15"); // 16-bit max
  });
  test("clamps negatives to zero and rounds fractional input", () => {
    expect(formatDuration(-5)).toBe("00:00:00");
    expect(formatDuration(59.6)).toBe("00:01:00");
  });
});

describe("parseDuration", () => {
  test("parses h:m:s, m:s and bare seconds", () => {
    expect(parseDuration("01:01:01")).toBe(3661);
    expect(parseDuration("05:00")).toBe(300);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration(" 00:00:30 ")).toBe(30);
  });
  test("round-trips with formatDuration across the 60s/3600s boundaries", () => {
    for (const s of [0, 1, 59, 60, 61, 3599, 3600, 3601, 300, 65535]) {
      expect(parseDuration(formatDuration(s))).toBe(s);
    }
  });
  test("rejects non-integer parts, too many parts, and empties", () => {
    expect(parseDuration("1:2:3:4")).toBeUndefined();
    expect(parseDuration("aa:bb")).toBeUndefined();
    expect(parseDuration("1.5")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("1::2")).toBeUndefined();
  });
});

describe("isValidIPv4", () => {
  test("accepts dotted quads with each octet 0..255", () => {
    expect(isValidIPv4("0.0.0.0")).toBe(true);
    expect(isValidIPv4("203.0.113.1")).toBe(true);
    expect(isValidIPv4("255.255.255.0")).toBe(true);
  });
  test("rejects out-of-range octets, wrong part count and non-numeric", () => {
    expect(isValidIPv4("256.0.0.1")).toBe(false);
    expect(isValidIPv4("1.2.3")).toBe(false);
    expect(isValidIPv4("1.2.3.4.5")).toBe(false);
    expect(isValidIPv4("a.b.c.d")).toBe(false);
    expect(isValidIPv4("")).toBe(false);
  });
});
