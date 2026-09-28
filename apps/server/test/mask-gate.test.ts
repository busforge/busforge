import { test, expect, describe } from "bun:test";
import { maskGate } from "../src/deviceprofile.ts";

describe("the mask gate", () => {
  test("a plain session answered with 0xFFFF is a missing tool key, not a wrong device", () => {
    expect(maskGate("MV-FFFF", "MV-07B0", false)?.code).toBe("SECURE_KEY_MISSING");
  });
  test("inside a secured session 0xFFFF is just a mask that does not match", () => {
    expect(maskGate("MV-FFFF", "MV-07B0", true)?.code).toBe("MASK_MISMATCH");
  });
  test("the right mask passes, another one is a mismatch", () => {
    expect(maskGate("MV-07B0", "MV-07B0", false)).toBeNull();
    expect(maskGate("MV-0705", "MV-07B0", false)?.code).toBe("MASK_MISMATCH");
  });
});
