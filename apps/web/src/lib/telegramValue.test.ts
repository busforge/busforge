import { test, expect } from "bun:test";
import { telegramValue } from "./telegramValue.ts";

const base = { ts: 0, src: "1.1.204", dst: "0/0/1", dstRaw: 1, kind: "GroupValueWrite", raw: "01" };

test("a plain or decrypted telegram shows its decoded value", () => {
  expect(telegramValue(base, "1.001")).toEqual({ value: "On" });
  expect(telegramValue({ ...base, security: "decrypted" }, "1.001")).toEqual({ value: "On" });
});

test("a secured telegram that was not decrypted shows its state, never a decoded value", () => {
  for (const security of ["noKey", "authFailed", "replay", "unsupported"] as const) {
    expect(telegramValue({ ...base, kind: "Unknown", raw: "a1b2", security }, "1.001")).toEqual({ secureState: security });
  }
});

test("a telegram of unknown service shows its raw octets, not a DPT value (older secured rows have no state)", () => {
  expect(telegramValue({ ...base, kind: "Unknown", raw: "10002446cfef4ac085" }, "1.001")).toEqual({ value: "0x10002446cfef4ac085" });
});

test("a GroupValueRead carries no value and shows none", () => {
  expect(telegramValue({ ...base, kind: "GroupValueRead", raw: "00" }, "1.001")).toEqual({ value: "" });
  expect(telegramValue({ ...base, kind: "GroupValueRead", raw: "00", security: "decrypted" }, "1.001")).toEqual({ value: "" });
});
