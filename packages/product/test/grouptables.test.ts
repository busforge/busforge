import { test, expect, describe } from "bun:test";
import { buildGroupTables, decodeGroupTables, type ComObjectLink } from "../src/grouptables.ts";

describe("buildGroupTables", () => {
  test("address table is sorted GAs, association is ordered by com-object number", () => {
    // com-objects out of order, with one multi-GA link
    const { addr, assoc } = buildGroupTables([
      { comObjNum: 5, gaRaws: [0x0a02] },
      { comObjNum: 3, gaRaws: [0x0a01] },
      { comObjNum: 8, gaRaws: [0x0a01, 0x0a03] },
    ]);
    // GAs sorted: 0a01,0a02,0a03 -> indices 1,2,3
    expect(addr.toString("hex")).toBe("00030a010a020a03");
    // entries sorted by comObjNum then groupIdx: (1,3)(2,5)(1,8)(3,8)
    expect(assoc.toString("hex")).toBe("0004" + "00010003" + "00020005" + "00010008" + "00030008");
  });

  test("reproduces the real PSU tables (validated against a device)", () => {
    // The six linked com-objects of the MEAN WELL PSU, in arbitrary input order.
    const { addr, assoc } = buildGroupTables([
      { comObjNum: 20, gaRaws: [7431] },
      { comObjNum: 11, gaRaws: [7426] },
      { comObjNum: 16, gaRaws: [7428] },
      { comObjNum: 13, gaRaws: [7427] },
      { comObjNum: 19, gaRaws: [7430] },
      { comObjNum: 15, gaRaws: [7429] },
    ]);
    expect(addr.toString("hex")).toBe("00061e021e031e041e051e061e07");
    expect(assoc.toString("hex")).toBe("0006" + "0001000b" + "0002000d" + "0004000f" + "00030010" + "00050013" + "00060014");
  });

  test("an empty link set yields empty tables", () => {
    const { addr, assoc } = buildGroupTables([]);
    expect(addr.toString("hex")).toBe("0000");
    expect(assoc.toString("hex")).toBe("0000");
  });
});

describe("decodeGroupTables", () => {
  // Compare link sets independent of order; gaRaws are sorted by both sides.
  const norm = (ls: ComObjectLink[]) =>
    [...ls].sort((a, b) => a.comObjNum - b.comObjNum).map((l) => ({ comObjNum: l.comObjNum, gaRaws: [...l.gaRaws].sort((x, y) => x - y) }));

  test("round-trips buildGroupTables, including a multi-GA link", () => {
    const links: ComObjectLink[] = [
      { comObjNum: 5, gaRaws: [0x0a02] },
      { comObjNum: 3, gaRaws: [0x0a01] },
      { comObjNum: 8, gaRaws: [0x0a01, 0x0a03] },
    ];
    const { addr, assoc } = buildGroupTables(links);
    expect(norm(decodeGroupTables(addr, assoc, true))).toEqual(norm(links));
  });

  test("reproduces the real PSU links from its tables", () => {
    const links: ComObjectLink[] = [
      { comObjNum: 20, gaRaws: [7431] }, { comObjNum: 11, gaRaws: [7426] },
      { comObjNum: 16, gaRaws: [7428] }, { comObjNum: 13, gaRaws: [7427] },
      { comObjNum: 19, gaRaws: [7430] }, { comObjNum: 15, gaRaws: [7429] },
    ];
    const { addr, assoc } = buildGroupTables(links);
    expect(norm(decodeGroupTables(addr, assoc, true))).toEqual(norm(links));
  });

  test("decodes the short association format", () => {
    // addr: 2 GAs (0x0a01, 0x0a02). short assoc: [count][gi:1][co:1]
    const addr = Buffer.from("00020a010a02", "hex");
    const assoc = Buffer.from("0002" + "0103" + "0205", "hex"); // (gi1->co3)(gi2->co5)
    expect(norm(decodeGroupTables(addr, assoc, false))).toEqual(
      norm([{ comObjNum: 3, gaRaws: [0x0a01] }, { comObjNum: 5, gaRaws: [0x0a02] }]),
    );
  });

  test("empty tables yield no links", () => {
    expect(decodeGroupTables(Buffer.from("0000", "hex"), Buffer.from("0000", "hex"), true)).toEqual([]);
  });

  test("a truncated table (header count exceeds the bytes read) decodes the whole entries, no crash", () => {
    // Header claims 4 GAs / 3 assoc entries, but the buffers were cut short (a
    // short device read). Must not read past the buffer (regression: RangeError
    // "offset out of range" crashed the whole read-back).
    const addr = Buffer.from("0004" + "0a01" + "0a02", "hex"); // says 4, only 2 present
    const assoc = Buffer.from("0003" + "00010003" + "0002", "hex"); // says 3, 1 whole entry + a stub
    expect(norm(decodeGroupTables(addr, assoc, true))).toEqual(
      norm([{ comObjNum: 3, gaRaws: [0x0a01] }]),
    );
  });

  test("buffers too short for even the header yield no links", () => {
    expect(decodeGroupTables(Buffer.alloc(0), Buffer.alloc(1), true)).toEqual([]);
  });
});
