import { test, expect, describe } from "bun:test";
import { offersFullDownload, leftDeviceUnloaded } from "./flashRecovery.ts";

describe("offersFullDownload", () => {
  test("a refusal only a full download can answer offers it whatever the family", () => {
    expect(offersFullDownload("COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", false)).toBe(true);
    expect(offersFullDownload("NEVER_PROGRAMMED_USE_DOWNLOAD", false)).toBe(true);
  });

  test("a device left without a running application offers it where the family can take one", () => {
    for (const code of ["DEVICE_NOT_PROGRAMMED", "FLASH_INTERRUPTED_UNLOADED", "DEVICE_LOAD_INCOMPLETE", "GA_FLASH_BROKE_APPLICATION"]) {
      expect(offersFullDownload(code, true)).toBe(true);
      expect(offersFullDownload(code, false)).toBe(false);
    }
  });

  test("any other error offers nothing", () => {
    expect(offersFullDownload("FLASH_UNVERIFIED", true)).toBe(false);
    expect(offersFullDownload(undefined, true)).toBe(false);
  });
});

describe("leftDeviceUnloaded", () => {
  test("a GA flash that broke the application stops further writes, like an interrupted load", () => {
    expect(leftDeviceUnloaded("GA_FLASH_BROKE_APPLICATION")).toBe(true);
    expect(leftDeviceUnloaded("FLASH_INTERRUPTED_UNLOADED")).toBe(true);
    expect(leftDeviceUnloaded("DEVICE_LOAD_INCOMPLETE")).toBe(false); // a refusal that wrote nothing
    expect(leftDeviceUnloaded("FLASH_UNVERIFIED")).toBe(false);
    expect(leftDeviceUnloaded(undefined)).toBe(false);
  });
});
