import { test, expect, describe } from "bun:test";
import { buildGroupTables, buildGroupTablesMv0705, decodeGroupTables, decodeGroupTablesMv0705, type ComObjectLink } from "../src/grouptables.ts";

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

describe("decodeGroupTablesMv0705 (System-7 layout)", () => {
  const byCo = (l: ComObjectLink[]) => l.sort((a, b) => a.comObjNum - b.comObjNum);

  test("decodes a real BE-06001.02 (MV-0705) address + association table to its links", () => {
    // Off a real device. addr = [count:1=6][own IA 0x1138=1.1.56][GA:2 BE x 5];
    // assoc = [count:1=5][groupIdx:1][comObjNum:1 x 5]. The IA entry is skipped; gi 1..5
    // index the GAs after it (gi1=0x1302, gi2=0x1303, gi3=0x2601, gi4=0x2602, gi5=0x2603).
    const addr = Buffer.from("06" + "1138" + "1302" + "1303" + "2601" + "2602" + "2603", "hex");
    const assoc = Buffer.from("05" + "0300" + "0406" + "050c" + "0112" + "022c", "hex");
    expect(byCo(decodeGroupTablesMv0705(addr, assoc))).toEqual([
      { comObjNum: 0, gaRaws: [0x2601] },  // 9729 = 4/6/1
      { comObjNum: 6, gaRaws: [0x2602] },  // 9730 = 4/6/2
      { comObjNum: 12, gaRaws: [0x2603] }, // 9731 = 4/6/3
      { comObjNum: 18, gaRaws: [0x1302] }, // 4866 = 2/3/2
      { comObjNum: 44, gaRaws: [0x1303] }, // 4867 = 2/3/3
    ]);
  });

  test("a truncated association read stops at the last whole entry, no crash", () => {
    const addr = Buffer.from("03" + "1138" + "0a01" + "0a02", "hex");   // IA + 2 GAs
    const assoc = Buffer.from("03" + "0100" + "0206" + "01", "hex");    // says 3, 2 whole + a stub byte
    expect(byCo(decodeGroupTablesMv0705(addr, assoc))).toEqual([
      { comObjNum: 0, gaRaws: [0x0a01] },
      { comObjNum: 6, gaRaws: [0x0a02] },
    ]);
  });

  test("empty / header-only buffers yield no links", () => {
    expect(decodeGroupTablesMv0705(Buffer.from("00", "hex"), Buffer.from("00", "hex"))).toEqual([]);
    expect(decodeGroupTablesMv0705(Buffer.alloc(0), Buffer.alloc(0))).toEqual([]);
  });
});

describe("buildGroupTablesMv0705 (System-7 layout)", () => {
  const links: ComObjectLink[] = [
    { comObjNum: 0, gaRaws: [0x2601] }, { comObjNum: 6, gaRaws: [0x2602] }, { comObjNum: 12, gaRaws: [0x2603] },
    { comObjNum: 18, gaRaws: [0x1302] }, { comObjNum: 44, gaRaws: [0x1303] },
  ];
  const ownIa = (1 << 12) | (1 << 8) | 56; // 1.1.56 = 0x1138

  test("produces the real device's exact bytes (byte-for-byte inverse of the decode)", () => {
    const { addr, assoc } = buildGroupTablesMv0705(links, ownIa);
    expect(addr.toString("hex")).toBe("06113813021303260126022603");
    expect(assoc.toString("hex")).toBe("0503000406050c0112022c");
  });

  test("round-trips through decodeGroupTablesMv0705", () => {
    const { addr, assoc } = buildGroupTablesMv0705(links, ownIa);
    expect(decodeGroupTablesMv0705(addr, assoc).sort((a, b) => a.comObjNum - b.comObjNum)).toEqual(links);
  });

  test("refuses tables that overflow the 1-byte count", () => {
    const many: ComObjectLink[] = Array.from({ length: 256 }, (_, i) => ({ comObjNum: i, gaRaws: [1000 + i] }));
    expect(() => buildGroupTablesMv0705(many, ownIa)).toThrow(/1-byte count/);
  });

  // Hardware-verified vectors from the GA-flash test on an M-0081 (the run that
  // ungated System7Profile.flashLinks): the build reproduces the device's exact bytes, and a
  // re-point of co#1 (0/4/11 -> 3/7/0) produced exactly these tables, which flashed and
  // byte-matched on the bus, then reverted to the originals below.
  test("reproduces real M-0081 tables and a hardware-verified re-point", () => {
    const ia17 = (1 << 12) | (2 << 8) | 17; // 1.2.17 = 0x1211
    const orig: ComObjectLink[] = [
      { comObjNum: 1, gaRaws: [0x040b] }, { comObjNum: 5, gaRaws: [0x180a] },
      { comObjNum: 8, gaRaws: [0x1807] }, { comObjNum: 10, gaRaws: [0x0508] },
      { comObjNum: 11, gaRaws: [0x100d] },
    ];
    const o = buildGroupTablesMv0705(orig, ia17);
    expect(o.addr.toString("hex")).toBe("061211040b0508100d1807180a");
    expect(o.assoc.toString("hex")).toBe("05010105050408020a030b");

    const repointed = orig.map((l) => (l.comObjNum === 1 ? { ...l, gaRaws: [0x1f00] } : l));
    const r = buildGroupTablesMv0705(repointed, ia17);
    expect(r.addr.toString("hex")).toBe("0612110508100d1807180a1f00");
    expect(r.assoc.toString("hex")).toBe("05050104050308010a020b");
  });
});
