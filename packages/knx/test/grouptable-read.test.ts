import { test, expect, describe } from "bun:test";
import type { KnxDevice } from "../src/device.ts";
import { readGroupTables, readGroupTablesMv0705, loadedTableAddr, DeviceNotProgrammed } from "../src/grouptable-read.ts";

describe("a device that was never programmed", () => {
  // HARDWARE-FOUND on a virgin OpenKNX device: every load-state machine points at address 0.
  // Reading anyway walks memory at 0 and decodes whatever is there. The group-table reader
  // used to bound-check its way out ("65535 entries, not the expected System B format"), which
  // was a true refusal for a false reason; the parameter read had no guard at all and would
  // have turned the bottom of the device's memory into a "programmed baseline".
  const virgin = { tableAddr: async () => 0, memRead: async () => { throw new Error("must not read from address 0"); } } as unknown as KnxDevice;

  test("loadedTableAddr refuses a zero table pointer with an actionable reason", async () => {
    const err = await loadedTableAddr(virgin, 4, "parameter segment").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeviceNotProgrammed);
    expect((err as DeviceNotProgrammed).code).toBe("DEVICE_NOT_PROGRAMMED");
    expect((err as Error).message).toContain("full download");
  });

  test("reading its group tables refuses, and reads no memory at all", async () => {
    const err = await readGroupTables(virgin).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeviceNotProgrammed); // not GROUP_TABLE_UNREADABLE: a different truth
  });

  test("the System 7 reader refuses the same way", async () => {
    const err = await readGroupTablesMv0705(virgin).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeviceNotProgrammed);
  });
});
