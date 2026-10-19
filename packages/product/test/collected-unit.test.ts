import { test, expect } from "bun:test";
import { STATE } from "@busforge/knx";
import { CollectedUnit, type Collection } from "./collected-unit.ts";

// A collection as a unit at rest shows it: each load-state machine's PID 5 with its element count and
// LOADED and, on a memory-mapped mask, LOADED in the state bytes at 46825 + LSM.
const collection = (mask: string): Collection => ({
  mask,
  records: [
    ...[1, 2, 3, 4].flatMap((o) => [
      { step: "lsm", space: "property", target: { object: o, pid: 5, start: 0, count: 1 }, outcome: "bytes", bytes: "0001" },
      { step: "lsm", space: "property", target: { object: o, pid: 5, start: 1, count: 1 }, outcome: "bytes", bytes: "01" },
    ]),
    { step: "lsm", space: "memory", target: { address: 46826, length: 4 }, outcome: "bytes", bytes: "01010101" },
  ],
});
const event = (lsm: number, ev: number) => { const b = Buffer.alloc(11); b[0] = (lsm << 4) | ev; return b; };

test("a memory-mapped load event moves the state byte, and PID 5 of that object refuses", async () => {
  const unit = new CollectedUnit(collection("MV-0701"));
  expect(unit.loadState(3)).toBe(STATE.LOADED);
  await unit.memWrite(0x0104, event(3, 1));
  expect(unit.loadState(3)).toBe(STATE.LOADING);
  const refused = (read: () => Promise<unknown>) => read().then(() => null, (e: Error) => e.message);
  for (const read of [() => unit.propRead(3, 5), () => unit.propReadIfPresent(3, 5), () => unit.propReadCounted(3, 5, 0, 2)]) {
    expect(await refused(read)).toContain("no capture shows whether the unit's PID 5 follows");
  }
  expect(await refused(() => unit.propWrite(3, 5, Buffer.from([2])))).toContain("its load controls go to 0x0104");
  // Another object's PID 5 still answers as collected.
  expect(await unit.propRead(2, 5)).toEqual(Buffer.from([STATE.LOADED]));
  await unit.memWrite(0x0104, event(3, 2));
  expect(unit.loadState(3)).toBe(STATE.LOADED);
});

test("a property-mapped unit reports its load state on PID 5", async () => {
  const unit = new CollectedUnit(collection("MV-0705"));
  await unit.propWrite(3, 5, Buffer.from([1]));
  expect(unit.loadState(3)).toBe(STATE.LOADING);
});

test("a memory-mapped unit whose collection did not read a state byte refuses that state", () => {
  const unit = new CollectedUnit({ mask: "MV-0701", records: [] });
  expect(() => unit.loadState(3)).toThrow("did not read the state of LSM 3 at 46828");
});
