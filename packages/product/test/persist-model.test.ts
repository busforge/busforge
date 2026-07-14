import { test, expect } from "bun:test";
import { persistsOnLoadCompleted } from "../src/index.ts";
import type { AppConfig } from "../src/appconfig.ts";

// The full download's closing A_Restart must, by default, prove the device rebooted (thelsing/knx
// persists ON the restart; a device that does not reboot lost the download). persistsOnLoadCompleted
// is the ONLY thing that relaxes that gate, so it must return true for the hardware-verified
// allowlist and false for everything else — a false positive would silently report an OpenKNX
// device as programmed while it comes back factory-fresh.
const app = (id: string) => ({ id }) as unknown as AppConfig;

test("only the hardware-verified GVS family relaxes the restart-reboot requirement", () => {
  expect(persistsOnLoadCompleted(app("M-0085_A-0072-30-69AA"))).toBe(true); // GVS AMMA, power-cycle-verified
  // Everything else must stay strict.
  expect(persistsOnLoadCompleted(app("M-00FA_A-A012-55-0000"))).toBe(false); // OpenKNX (persists on restart)
  expect(persistsOnLoadCompleted(app("M-0081_A-FE01-11-75D9"))).toBe(false); // Auro
  expect(persistsOnLoadCompleted(app("M-0083_A-00B4-32-3919"))).toBe(false); // MDT
});

test("a non-numeric or non-GVS application id fails safe (strict)", () => {
  // Real app ids are "M-<hex>_...". Anything whose parsed manufacturer is not 0x0085 stays strict;
  // garbage that is not hex parses to NaN, which is not in the set either. (Only a genuine GVS
  // "M-0085" reaches the allowlist; no other real manufacturer shares that code.)
  for (const id of ["", "garbage", "m-0085_lower", "M-00FB_A-1", "M-0083_A-1", "M-00FA_A-1"]) {
    expect(persistsOnLoadCompleted(app(id))).toBe(false);
  }
});
