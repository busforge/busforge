import { test, expect } from "bun:test";
import { untestedOps, failedOps, summarize, orderOf, appVersionOf } from "./untested.ts";
import type { DeviceConfigView, MatrixOperation, OperationState } from "../api.ts";

const view = (states: Partial<Record<MatrixOperation, OperationState>>, untestedAcknowledged = false) => ({
  untestedAcknowledged,
  compatibility: Object.fromEntries(Object.entries(states).map(([op, state]) => [op, { state, cells: {}, firmware: [] }])),
}) as unknown as Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged">;

test("an untested or failed operation needs the acknowledgement; tested and refused do not", () => {
  const v = view({ flashParams: "tested", flashLinks: "eligible", fullDownload: "failed", structuralFlash: "refused", readParams: "otherVersion", readLinks: "derived" });
  expect(untestedOps(v, ["flashParams", "flashLinks", "fullDownload", "structuralFlash", "readParams", "readLinks"])).toEqual(["flashLinks", "fullDownload", "readParams", "readLinks"]);
});

test("after the acknowledgement nothing blocks, but a failure on hardware still shows", () => {
  const v = view({ flashLinks: "eligible", fullDownload: "conflict" }, true);
  expect(untestedOps(v, ["flashLinks", "fullDownload"])).toEqual([]);
  expect(failedOps(v, ["flashLinks", "fullDownload"])).toEqual(["fullDownload"]);
});

test("a view without a matrix gates nothing (the server does not either)", () => {
  expect(untestedOps(undefined, ["flashParams"])).toEqual([]);
  expect(failedOps({} as Pick<DeviceConfigView, "compatibility">, ["flashParams"])).toEqual([]);
});

const all = (state: OperationState, over: Partial<Record<MatrixOperation, OperationState>> = {}) =>
  view({ readParams: state, readLinks: state, flashParams: state, flashLinks: state, fullDownload: state, structuralFlash: state, ...over }).compatibility!;

test("the summary never says more than every supported operation shows", () => {
  expect(summarize(all("tested"))).toBe("tested");
  expect(summarize(all("tested", { structuralFlash: "refused" }))).toBe("tested"); // refused is left out, and the label says "supported"
  expect(summarize(all("tested", { structuralFlash: "eligible" }))).toBe("partial");
  expect(summarize(all("tested", { fullDownload: "failed" }))).toBe("failed");
  expect(summarize(all("derived"))).toBe("derived");
  expect(summarize(all("eligible", { readParams: "derived" }))).toBe("untested"); // one derived operation is not the device
  expect(summarize(all("otherVersion", { structuralFlash: "refused" }))).toBe("otherVersion");
  expect(summarize(all("derived", { flashLinks: "otherVersion" }))).toBe("otherVersion"); // the weaker claim names the device
  expect(summarize(all("otherVersion", { structuralFlash: "eligible" }))).toBe("untested");
  expect(summarize(all("refused"))).toBe("unsupported");
});

test("order numbers decode from the Product id", () => {
  expect(orderOf("M-0083_H-182-0_P-BE.2D02001.2E02")).toBe("BE-02001.02");
});

test("an application version is named by its id without the manufacturer", () => {
  expect(appVersionOf("M-00FA_A-A012-55-0000")).toBe("A012-55-0000");
  expect(appVersionOf("M-0004_A-7072-21-99A7-O000A")).toBe("7072-21-99A7-O000A");
});
