import { test, expect, describe } from "bun:test";
import type { KnxDevice } from "../src/device.ts";
import { readGroupTables, readGroupTablesMv0705, loadedTableAddr, DeviceNotProgrammed, assocFormOf } from "../src/grouptable-read.ts";

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
    const err = await readGroupTables(virgin, 4).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeviceNotProgrammed); // not GROUP_TABLE_UNREADABLE: a different truth
  });

  test("the System 7 reader refuses the same way", async () => {
    const err = await readGroupTablesMv0705(virgin).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DeviceNotProgrammed);
  });
});

describe("the association table's form", () => {
  const desc = (pid: number, pdt: number) => ({ objectIndex: 2, pid, propertyIndex: 3, writable: true, pdt, maxElements: 1, readLevel: 3, writeLevel: 3 });
  test("is the one the unit's description of its table property names, and no other", () => {
    expect(assocFormOf(desc(23, 0x12))).toBe(2);
    expect(assocFormOf(desc(23, 0x14))).toBe(4);
    expect(assocFormOf(desc(0, 0))).toBe("undescribed");
    expect(assocFormOf(desc(23, 0x13))).toBeNull();
    expect(assocFormOf(desc(23, 0x04))).toBeNull();
  });

  // A unit holding exactly its tables, as allocated: a read past their end throws. The address table holds four
  // addresses, the association table four short entries (the MDT IP Interface/Router after ETS's link download).
  const unit = (assoc: Buffer) => {
    const mem = new Map<number, number>();
    const put = (at: number, b: Buffer) => b.forEach((x, i) => mem.set(at + i, x));
    put(0x1002, Buffer.from("00041900190119027fc8", "hex"));
    put(0x1202, assoc);
    put(0x1402, Buffer.from("0000", "hex"));
    const reads: [number, number][] = [];
    const dev = {
      propRead: async () => Buffer.from([1]),
      tableAddr: async (obj: number) => ({ 1: 0x1002, 2: 0x1202, 3: 0x1402 } as Record<number, number>)[obj],
      memRead: async (at: number, len: number) => {
        reads.push([at, len]);
        return Buffer.from(Array.from({ length: len }, (_, i) => { const b = mem.get(at + i); if (b === undefined) throw new Error(`read past the table at 0x${(at + i).toString(16)}`); return b; }));
      },
    } as unknown as KnxDevice;
    return { dev, reads };
  };
  const SHORT = Buffer.from("00040401020201030304", "hex");

  test("a table described short is read in that form, its entries and nothing past them", async () => {
    const { dev, reads } = unit(SHORT);
    const t = await readGroupTables(dev, 2, undefined, true);
    expect([t.long, t.assoc.equals(SHORT)]).toEqual([false, true]);
    expect(reads.filter(([at]) => at === 0x1202)).toEqual([[0x1202, 2], [0x1202, 10]]);
  });
  test("a table described long is read in that form", async () => {
    const LONG = Buffer.from("000400010001000200020003000300040004", "hex");
    const { dev } = unit(LONG);
    const t = await readGroupTables(dev, 4, undefined, true);
    expect([t.long, t.assoc.equals(LONG)]).toEqual([true, true]);
  });
  test("only a unit giving no description has its form detected, which reads the long form's length first", async () => {
    const { dev, reads } = unit(Buffer.concat([SHORT, Buffer.alloc(8)]));
    const t = await readGroupTables(dev, "undescribed", undefined, true);
    expect([t.long, t.assoc.equals(SHORT)]).toEqual([false, true]);
    expect(reads.filter(([at]) => at === 0x1202)).toEqual([[0x1202, 2], [0x1202, 18], [0x1202, 10]]);
  });
});
