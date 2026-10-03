import { test, expect } from "bun:test";
import { untestedOps, failedOps, summarize, orderOf } from "./untested.ts";
import type { DeviceConfigView, MatrixOperation, OperationState } from "../api.ts";

const view = (states: Partial<Record<MatrixOperation, OperationState>>, untestedAcknowledged = false) => ({
  untestedAcknowledged,
  compatibility: Object.fromEntries(Object.entries(states).map(([op, state]) => [op, { state, cells: {}, firmware: [] }])),
}) as unknown as Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged">;

test("an untested or failed operation needs the acknowledgement; tested and refused do not", () => {
  const v = view({ flashParams: "tested", flashLinks: "eligible", fullDownload: "failed", structuralFlash: "refused" });
  expect(untestedOps(v, ["flashParams", "flashLinks", "fullDownload", "structuralFlash"])).toEqual(["flashLinks", "fullDownload"]);
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
  expect(summarize(all("refused"))).toBe("unsupported");
});

test("order numbers decode from the Product id", () => {
  expect(orderOf("M-0083_H-182-0_P-BE.2D02001.2E02")).toBe("BE-02001.02");
});
