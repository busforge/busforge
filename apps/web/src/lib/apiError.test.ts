import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import { ERROR_CLASS_SYSTEM } from "@busforge/knx";
import en from "@/locales/en";
import de from "@/locales/de";
import { ApiError } from "../api.ts";
import { errMsg, localizeError } from "./apiError.ts";

describe("a refusal's details in the error text", () => {
  const i18n = i18next.createInstance();
  void i18n.init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } });
  const t = (lng: string) => i18n.getFixedT(lng);

  test("the English names of the codes are the ones the server's message uses", () => {
    expect(Object.values(en.errorDetails.lsmErrorClass)).toEqual([...ERROR_CLASS_SYSTEM]);
    expect(Object.keys(de.errorDetails.lsmErrorClass)).toEqual(Object.keys(en.errorDetails.lsmErrorClass));
  });

  test("a load-state machine's error code is named with its DPT 20.011 meaning, in the user's language", () => {
    expect(localizeError(t("en"), "LOAD_STATE_UNEXPECTED", "LSM 4 …", { lsmErrorCode: 13 }))
      .toBe(`${en.errors.LOAD_STATE_UNEXPECTED} The device names its reason: error code 13, maximal table length exceeded.`);
    expect(localizeError(t("de"), "FLASH_INTERRUPTED_UNLOADED", "the write broke off …", { lsmErrorCode: 14 }))
      .toBe(`${de.errors.FLASH_INTERRUPTED_UNLOADED} Das Gerät nennt als Grund Fehlercode 14: undefinierter Ladebefehl empfangen.`);
  });

  test("a code DPT 20.011 does not define is named as such", () => {
    expect(localizeError(t("de"), "LOAD_STATE_UNEXPECTED", "x", { lsmErrorCode: 66 }))
      .toEndWith("Fehlercode 66: ein Wert, den DPT 20.011 nicht definiert.");
  });

  test("a device that gives no code, or did not answer, is said to", () => {
    expect(localizeError(t("en"), "LOAD_STATE_UNEXPECTED", "x", { lsmErrorCode: "none" })).toEndWith(" The device gives no error code for it.");
    expect(localizeError(t("de"), "LOAD_STATE_UNEXPECTED", "x", { lsmErrorCode: "unreadable" })).toEndWith(" Der Fehlercode des Geräts ließ sich nicht lesen.");
  });

  test("details without a sentence of their own add nothing", () => {
    expect(localizeError(t("en"), "LOAD_STATE_UNEXPECTED", "x", { objects: [3] })).toBe(en.errors.LOAD_STATE_UNEXPECTED);
    expect(localizeError(t("en"), "LOAD_STATE_UNEXPECTED", "x", null)).toBe(en.errors.LOAD_STATE_UNEXPECTED);
  });

  test("a code the catalogue does not localize shows the English message alone, which already names the code", () => {
    expect(localizeError(t("de"), "SOME_NEW_CODE", "LSM 4 not LOADED (got ERROR); its error code (PID 28) is 13", { lsmErrorCode: 13 }))
      .toBe("LSM 4 not LOADED (got ERROR); its error code (PID 28) is 13");
  });

  test("a thrown ApiError carries its details into the text", () => {
    expect(errMsg(t("en"), new ApiError("x", "LOAD_STATE_UNEXPECTED", { lsmErrorCode: 9 }))).toEndWith("error code 9, CRC error.");
  });
});
