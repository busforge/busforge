import { test, expect, describe } from "bun:test";
import { offersFullDownload, leftDeviceUnloaded, etsCompletesLoad, flashFooter } from "./flashRecovery.ts";

describe("offersFullDownload", () => {
  test("a refusal only a full download can answer offers it whatever the family", () => {
    expect(offersFullDownload("COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", false)).toBe(true);
    expect(offersFullDownload("NEVER_PROGRAMMED_USE_DOWNLOAD", false)).toBe(true);
    expect(offersFullDownload("COM_OBJECT_FLAGS_PENDING_USE_DOWNLOAD", false)).toBe(true);
    expect(offersFullDownload("COM_OBJECT_FLAGS_PENDING", false)).toBe(false);
  });

  test("a device left without a running application offers it where the full download loads the application", () => {
    for (const code of ["DEVICE_NOT_PROGRAMMED", "FLASH_INTERRUPTED_UNLOADED", "DEVICE_LOAD_INCOMPLETE", "GA_FLASH_BROKE_APPLICATION"]) {
      expect(offersFullDownload(code, true)).toBe(true);
      expect(offersFullDownload(code, false)).toBe(false);
    }
  });

  test("any other error offers nothing", () => {
    expect(offersFullDownload("FLASH_UNVERIFIED", true)).toBe(false);
    expect(offersFullDownload(undefined, true)).toBe(false);
  });

  test("a refusal that names ETS offers no download", () => {
    expect(offersFullDownload("NEVER_PROGRAMMED_USE_ETS", false)).toBe(false);
    expect(offersFullDownload("COM_OBJECT_TABLE_STALE_USE_ETS", false)).toBe(false);
  });
});

describe("etsCompletesLoad", () => {
  test("a device left unloaded names ETS exactly where the full download does not load the application", () => {
    for (const code of ["DEVICE_NOT_PROGRAMMED", "FLASH_INTERRUPTED_UNLOADED", "DEVICE_LOAD_INCOMPLETE", "GA_FLASH_BROKE_APPLICATION"]) {
      expect(etsCompletesLoad(code, false)).toBe(true);
      expect(etsCompletesLoad(code, true)).toBe(false);
    }
    expect(etsCompletesLoad("FLASH_UNVERIFIED", false)).toBe(false);
    expect(etsCompletesLoad(undefined, false)).toBe(false);
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

describe("flashFooter", () => {
  const base = { canFlash: true, downloadTaken: false, anyFlashing: false, anyChecking: false, awaitingAck: false, blocked: false, errorCodes: [] as (string | undefined)[], anyError: false, fullDownloadLoads: true };

  test("a previewed change is flashed, and a failed preview retried", () => {
    expect(flashFooter(base)).toEqual({ flash: "enabled", retry: false, unloaded: false });
    expect(flashFooter({ ...base, canFlash: false, errorCodes: ["DEVICE_NOT_ANSWERING"], anyError: true })).toEqual({ flash: "none", retry: true, unloaded: false });
  });

  test("a device a write left unloaded takes neither another flash nor a re-preview, only the full download", () => {
    for (const code of ["FLASH_INTERRUPTED_UNLOADED", "GA_FLASH_BROKE_APPLICATION"]) {
      // The target that broke off still holds its preview, so it would be written again.
      expect(flashFooter({ ...base, errorCodes: [code, undefined], anyError: true })).toEqual({ flash: "disabled", retry: false, unloaded: true });
    }
  });

  test("where only ETS completes the load, the flash and the retry stay: the dialog offers no download", () => {
    expect(flashFooter({ ...base, fullDownloadLoads: false, errorCodes: ["FLASH_INTERRUPTED_UNLOADED"], anyError: true })).toEqual({ flash: "enabled", retry: true, unloaded: false });
  });

  test("a refusal that wrote nothing keeps the retry", () => {
    expect(flashFooter({ ...base, canFlash: false, errorCodes: ["DEVICE_LOAD_INCOMPLETE"], anyError: true }).retry).toBe(true);
  });

  test("no flash while another target still previews: the write would queue behind it and leave that target out", () => {
    expect(flashFooter({ ...base, anyChecking: true })).toEqual({ flash: "disabled", retry: false, unloaded: false });
  });

  test("an acknowledgement still missing disables the flash; the full download taken, a foreign write or a write running take the retry", () => {
    expect(flashFooter({ ...base, awaitingAck: true }).flash).toBe("disabled");
    expect(flashFooter({ ...base, downloadTaken: true }).flash).toBe("none");
    const failed = { ...base, canFlash: false, errorCodes: ["DEVICE_NOT_ANSWERING"], anyError: true };
    expect(flashFooter({ ...failed, downloadTaken: true }).retry).toBe(false);
    expect(flashFooter({ ...failed, blocked: true }).retry).toBe(false);
    expect(flashFooter({ ...failed, anyFlashing: true }).retry).toBe(false);
  });
});
