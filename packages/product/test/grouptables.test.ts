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

  test("builds the MEAN WELL PSU's six links, given in arbitrary order", () => {
    // The six linked com-objects of the MEAN WELL PSU, in arbitrary input order (synthetic addresses).
    const { addr, assoc } = buildGroupTables([
      { comObjNum: 20, gaRaws: [4367] },
      { comObjNum: 11, gaRaws: [4362] },
      { comObjNum: 16, gaRaws: [4364] },
      { comObjNum: 13, gaRaws: [4363] },
      { comObjNum: 19, gaRaws: [4366] },
      { comObjNum: 15, gaRaws: [4365] },
    ]);
    expect(addr.toString("hex")).toBe("0006110a110b110c110d110e110f");
    expect(assoc.toString("hex")).toBe("0006" + "0001000b" + "0002000d" + "0004000f" + "00030010" + "00050013" + "00060014");
  });

  test("in ETS's order: each object's first link first, then the others by object", () => {
    // Theben MIX 2 JMG 4 T: objects 2 and 22 with two addresses each, the second shared.
    const { addr, assoc } = buildGroupTables([
      { comObjNum: 22, gaRaws: [0x0a02, 0x0a03] },
      { comObjNum: 2, gaRaws: [0x0a01, 0x0a03] },
      { comObjNum: 5, gaRaws: [0x0a04] },
    ]);
    expect(addr.toString("hex")).toBe("00040a010a020a030a04");
    expect(assoc.toString("hex")).toBe("0005" + "00010002" + "00040005" + "00020016" + "00030002" + "00030016");
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

  test("reproduces the PSU links from its tables", () => {
    const links: ComObjectLink[] = [
      { comObjNum: 20, gaRaws: [4367] }, { comObjNum: 11, gaRaws: [4362] },
      { comObjNum: 16, gaRaws: [4364] }, { comObjNum: 13, gaRaws: [4363] },
      { comObjNum: 19, gaRaws: [4366] }, { comObjNum: 15, gaRaws: [4365] },
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

  test("decodes a BE-06001.02 (MV-0705) address + association table to its links", () => {
    // The layout of a real device's tables, with synthetic addresses. addr = [count:1=6][own IA
    // 0x1203=1.2.3][GA:2 BE x 5]; assoc = [count:1=5][groupIdx:1][comObjNum:1 x 5]. The IA entry is
    // skipped; gi 1..5 index the GAs after it (gi1=0x1102, gi2=0x1103, gi3=0x2a01, gi4=0x2a02, gi5=0x2a03).
    const addr = Buffer.from("06" + "1203" + "1102" + "1103" + "2a01" + "2a02" + "2a03", "hex");
    const assoc = Buffer.from("05" + "0300" + "0406" + "050c" + "0112" + "022c", "hex");
    expect(byCo(decodeGroupTablesMv0705(addr, assoc))).toEqual([
      { comObjNum: 0, gaRaws: [0x2a01] },  // 10753 = 5/2/1
      { comObjNum: 6, gaRaws: [0x2a02] },  // 10754 = 5/2/2
      { comObjNum: 12, gaRaws: [0x2a03] }, // 10755 = 5/2/3
      { comObjNum: 18, gaRaws: [0x1102] }, // 4354 = 2/1/2
      { comObjNum: 44, gaRaws: [0x1103] }, // 4355 = 2/1/3
    ]);
  });

  test("a truncated association read stops at the last whole entry, no crash", () => {
    const addr = Buffer.from("03" + "1203" + "0a01" + "0a02", "hex");   // IA + 2 GAs
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
    { comObjNum: 0, gaRaws: [0x2a01] }, { comObjNum: 6, gaRaws: [0x2a02] }, { comObjNum: 12, gaRaws: [0x2a03] },
    { comObjNum: 18, gaRaws: [0x1102] }, { comObjNum: 44, gaRaws: [0x1103] },
  ];
  const ownIa = (1 << 12) | (2 << 8) | 3; // 1.2.3 = 0x1203

  test("produces the decoded tables' exact bytes (byte-for-byte inverse of the decode)", () => {
    const { addr, assoc } = buildGroupTablesMv0705(links, ownIa);
    expect(addr.toString("hex")).toBe("061203110211032a012a022a03");
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

  // The layout of the tables a GA flash on an M-0081 device wrote and byte-matched on the bus, with
  // synthetic addresses: own IA first, then the group addresses ascending, the association ordered by
  // object. A re-point of co#1 to an address above all others moves it to the end of the address
  // table and renumbers every other link's group index.
  test("reproduces an M-0081's tables and a re-point", () => {
    const ia = (1 << 12) | (2 << 8) | 4; // 1.2.4 = 0x1204
    const orig: ComObjectLink[] = [
      { comObjNum: 1, gaRaws: [0x0a03] }, { comObjNum: 5, gaRaws: [0x1409] },
      { comObjNum: 8, gaRaws: [0x1401] }, { comObjNum: 10, gaRaws: [0x0b04] },
      { comObjNum: 11, gaRaws: [0x1107] },
    ];
    const o = buildGroupTablesMv0705(orig, ia);
    expect(o.addr.toString("hex")).toBe("0612040a030b04110714011409");
    expect(o.assoc.toString("hex")).toBe("05010105050408020a030b");

    const repointed = orig.map((l) => (l.comObjNum === 1 ? { ...l, gaRaws: [0x77c8] } : l));
    const r = buildGroupTablesMv0705(repointed, ia);
    expect(r.addr.toString("hex")).toBe("0612040b0411071401140977c8");
    expect(r.assoc.toString("hex")).toBe("05050104050308010a020b");
  });
});

// Cross-package layout lock: the builder arithmetic here and the on-device readers in
// @busforge/knx must describe the SAME byte layout. Deriving the expected sizes from the
// knx TableLayout descriptors means a width change on either side fails this test
// instead of silently desynchronizing read and write.
test("builder output follows the shared TableLayout descriptors (@busforge/knx)", async () => {
  const { SYSTEM_B_ADDR, SYSTEM_B_ASSOC_LONG, MV0705_TABLE } = await import("@busforge/knx");
  const sysB = buildGroupTables([{ comObjNum: 1, gaRaws: [0x1101, 0x1102] }]); // 2 GAs, 2 associations
  expect(sysB.addr.length).toBe(SYSTEM_B_ADDR.countBytes + 2 * SYSTEM_B_ADDR.entryBytes);
  expect(sysB.assoc.length).toBe(SYSTEM_B_ASSOC_LONG.countBytes + 2 * SYSTEM_B_ASSOC_LONG.entryBytes);
  const mv = buildGroupTablesMv0705([{ comObjNum: 1, gaRaws: [0x040b] }], 0x1101); // IA + 1 GA, 1 association
  expect(mv.addr.length).toBe(MV0705_TABLE.countBytes + 2 * MV0705_TABLE.entryBytes);
  expect(mv.assoc.length).toBe(MV0705_TABLE.countBytes + 1 * MV0705_TABLE.entryBytes);
});
