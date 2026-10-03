import { test, expect } from "bun:test";
import { MANUFACTURERS, manufacturerId, manufacturerInfo } from "../src/manufacturers.ts";

test("each manufacturer appears once, by its KNX id, with an https page or none", () => {
  expect(new Set(MANUFACTURERS.map((m) => m.id)).size).toBe(MANUFACTURERS.length);
  for (const m of MANUFACTURERS) {
    expect(m.id).toMatch(/^M-[0-9A-F]{4}$/);
    if (m.productDataUrl !== null) expect(new URL(m.productDataUrl).protocol).toBe("https:");
  }
});

test("the numeric manufacturer of a catalog product finds its entry", () => {
  expect(manufacturerId(0x83)).toBe("M-0083");
  expect(manufacturerInfo(manufacturerId(0x83))?.name).toBe("MDT technologies");
  expect(manufacturerInfo("M-FFFF")).toBeUndefined();
});
