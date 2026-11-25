import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { attributes, catalogueList, GENERATED_END, GENERATED_START, markdown, readFetched, SWEEP_MASKS, withGenerated, type BussardManifest, type Fetched } from "./ets-catalogue.ts";
import { tempDir } from "./test-temp.ts";

// The fixture is a fetched directory as `fetch` writes it, invented: two manufacturers (M-FFF1, M-FFF2) and an
// empty one, a market Germany and a market Austria, application headers as ETS's product store holds them.
const FIXTURE = join(import.meta.dir, "fixtures", "ets-catalogue");
const fetched = () => readFetched(FIXTURE);
const bussard = () => JSON.parse(readFileSync(join(FIXTURE, "bussard-manifest.json"), "utf8")) as BussardManifest;

describe("the catalogue list", () => {
  const list = catalogueList(fetched(), "Germany", SWEEP_MASKS, bussard());
  const row = (id: string) => list.rows.find((r) => r.application === id);

  test("one row per application at the sweep's masks, its mask from the product data", () => {
    expect(list.rows.map((r) => [r.application, r.mask, r.version])).toEqual([
      ["M-FFF1_A-0001-11-A001", "07B0", "1.1"],
      ["M-FFF1_A-0002-20-B002", "07B0", "2.0"],
      ["M-FFF1_A-0003-10-C003", "0701", "1.0"],
      ["M-FFF1_A-0004-10-D004", "0705", "1.0"],
      ["M-FFF2_A-0010-12-1234-O0001", "0705", "1.2"],
      ["M-FFF2_A-0013-10-9AB0", "07B0", "1.0"],
      ["M-FFF2_A-0015-20-7890-O0001", "07B0", "2.0"],
    ]);
    expect(list.counts.byMask).toEqual({ "07B0": 4, "0701": 1, "0705": 2, "091A": 1 });
  });

  test("counts what it passed, the applications' counts adding up", () => {
    const c = list.counts;
    expect(c).toMatchObject({
      indexEntries: 20, marketEntries: 19, withoutApplication: 1, refusedEntries: 3, marketIdsWithoutEntry: 0,
      applications: 11, loaded: 8, unloaded: 1, refusedApplications: 2, rows: 7, sameOrderAndVersion: 4, secondApplications: 1,
    });
    expect(c.loaded + c.unloaded + c.refusedApplications).toBe(c.applications);
    expect(list.unloaded).toEqual([{ application: "M-FFF2_A-0011-10-2345", orderNumbers: ["TWO-2"] }]);
    expect(list.rows.some((r) => r.application.includes("0005"))).toBe(false);
  });

  test("refused: entries whose parts disagree, applications whose product data does not fit", () => {
    expect(list.refused).toEqual([
      { kind: "entry", entry: "M-FFF1_H-hw6-1_HP-0006-10-F006_CI-ORDER.2D6-1", why: "its application identifier [255,241,0,6,17] is no M-FFF1_A-0006-10" },
      { kind: "entry", entry: "M-FFF2_H-hw6-1_HP-XYZ_CI-TWO.2D6-1", why: "its id names no application" },
      { kind: "entry", entry: "M-FFF1_H-hw9-1_HP-0009-10-9999_CI-TWO.2D9-1", why: "it stands in manufacturer M-FFF2's index" },
      { kind: "application", entry: "M-FFF2_A-0012-10-3456", why: "ETS's product data names application number 18 version 17" },
      { kind: "application", entry: "M-FFF2_A-0014-10-6789", why: "ETS's product data holds it as PeiProgram" },
    ]);
  });

  test("every order number of an application, and the German name the catalogue shows", () => {
    expect(row("M-FFF1_A-0001-11-A001")).toEqual({
      application: "M-FFF1_A-0001-11-A001", manufacturer: "M-FFF1", manufacturerName: "Example One", mask: "07B0", version: "1.1", name: "Switch (de)",
      orderNumber: "ORDER-1B", orderNumbers: ["ORDER-1", "ORDER-1B"], catalogueEntries: 3,
    });
  });

  test("order numbers compared as the driver compares them: spaces, case, O and 0, I, L and 1", () => {
    const f = fetched();
    const index = f.indexes.find((x) => x.ManufacturerId === 0xfff1)!;
    const again = structuredClone(index.Entries.find((e) => e.OrderNumber === "ORDER-4")!);
    again.Id = again.Id.replace("_H-hw8-1_", "_H-hw8-2_");
    again.OrderNumber = "0rder -4";
    index.Entries.push(again);
    index.Markets!.find((m) => m.DefaultName === "Germany")!.CatalogIds.push(again.Id);
    const r = catalogueList(f, "Germany", SWEEP_MASKS).rows.find((x) => x.application === "M-FFF1_A-0004-10-D004");
    expect(r).toMatchObject({ orderNumbers: ["0rder -4", "ORDER-3", "ORDER-4"], noOwnOrderNumber: true });
  });

  test("two catalogue rows of one application under one order number: not its own order number", () => {
    expect(row("M-FFF1_A-0001-11-A001")).toMatchObject({ orderNumber: "ORDER-1B", orderNumbers: ["ORDER-1", "ORDER-1B"], catalogueEntries: 3 });
    expect(row("M-FFF1_A-0001-11-A001")?.sameOrderAndVersion).toBeUndefined();
  });

  test("an empty order number is none to search for", () => {
    expect(row("M-FFF2_A-0010-12-1234-O0001")).toMatchObject({ orderNumber: "TWO-1", orderNumbers: ["", "TWO-1"], catalogueEntries: 2 });
    expect(row("M-FFF2_A-0010-12-1234-O0001")?.noOwnOrderNumber).toBeUndefined();
  });

  test("two applications under one order number and version: both rows, each names the other", () => {
    expect(row("M-FFF1_A-0003-10-C003")?.sameOrderAndVersion).toEqual([{ orderNumber: "ORDER-3", applications: ["M-FFF1_A-0004-10-D004"] }]);
    expect(row("M-FFF1_A-0004-10-D004")?.sameOrderAndVersion).toEqual([{ orderNumber: "ORDER-3", applications: ["M-FFF1_A-0003-10-C003"] }]);
    // Searched by an order number where it stands alone, where it has one; flagged where it has none.
    expect(row("M-FFF1_A-0004-10-D004")).toMatchObject({ orderNumber: "ORDER-4" });
    expect(row("M-FFF1_A-0004-10-D004")?.noOwnOrderNumber).toBeUndefined();
    expect(row("M-FFF1_A-0003-10-C003")).toMatchObject({ orderNumber: "ORDER-3", noOwnOrderNumber: true });
  });

  test("an order number is shared across manufacturers too: the driver searches the whole catalogue", () => {
    expect(row("M-FFF1_A-0002-20-B002")).toMatchObject({ noOwnOrderNumber: true, sameOrderAndVersion: [{ orderNumber: "ORDER-2", applications: ["M-FFF2_A-0015-20-7890-O0001"] }] });
    expect(row("M-FFF2_A-0015-20-7890-O0001")).toMatchObject({ noOwnOrderNumber: true, sameOrderAndVersion: [{ orderNumber: "ORDER-2", applications: ["M-FFF1_A-0002-20-B002"] }] });
  });

  test("the application ETS's store holds, through its catalogue item, under another hash than the index names", () => {
    // The store's hardware-to-program lists the PEI program first: the application is the program at the index's
    // number, version and OEM, whatever its place.
    expect(row("M-FFF2_A-0013-10-9AB0")).toMatchObject({ application: "M-FFF2_A-0013-10-9AB0", catalogueApplications: ["M-FFF2_A-0013-10-4567"], mask: "07B0" });
    // Where the store has no catalogue item for it, the application stands by the index's id.
    expect(row("M-FFF1_A-0001-11-A001")?.catalogueApplications).toBeUndefined();
  });

  test("the store's data refused where it names no such program or is ambiguous", () => {
    const refusal = (change: (f: Fetched) => void) => {
      const f = fetched();
      change(f);
      return catalogueList(f, "Germany", SWEEP_MASKS).refused.find((r) => r.entry === "M-FFF2_A-0013-10-4567")?.why;
    };
    const h2p = "M-FFF2_H-hw4-1_HP-0013-10-9AB0-0013-20-5678", item = "M-FFF2_H-hw4-1_HP-0013-10-0013-20_CI-TWO.2D4-1";
    expect(refusal((f) => f.programs.set(h2p, [["M-FFF2_A-0014-10-9AB0"]]))).toBe(`hardware-to-program ${h2p} in ETS's product store names no program at M-FFF2_A-0013-10`);
    // Another OEM suffix is another application.
    expect(refusal((f) => f.programs.set(h2p, [["M-FFF2_A-0013-10-9AB0-O0002"]]))).toBe(`hardware-to-program ${h2p} in ETS's product store names no program at M-FFF2_A-0013-10`);
    expect(refusal((f) => f.programs.set(h2p, [["M-FFF2_A-0013-10-9AB0"], ["M-FFF2_A-0013-10-9AB1"]]))).toBe(`ETS's product store holds hardware-to-program ${h2p} twice, with different programs`);
    expect(refusal((f) => f.items.set(item, [h2p, "M-FFF2_H-hw4-1_HP-0013-10-9AB1"]))).toContain("with several hardware-to-programs");
    expect(refusal((f) => f.programs.delete(h2p))).toBe(`ETS's product store holds no hardware-to-program ${h2p}`);
  });

  test("an application the index names under two hashes and the store holds once is one row", () => {
    const f = fetched();
    const index = f.indexes.find((x) => x.ManufacturerId === 0xfff2)!;
    const again = structuredClone(index.Entries.find((e) => e.OrderNumber === "TWO-4")!);
    again.Id = "M-FFF2_H-hw4-2_HP-0013-10-9AB0_CI-TWO.2D4B-1";
    again.FingerPrint = 0x9ab0;
    again.OrderNumber = "TWO-4B";
    index.Entries.push(again);
    index.Markets!.find((m) => m.DefaultName === "Germany")!.CatalogIds.push(again.Id);
    const rows = catalogueList(f, "Germany", SWEEP_MASKS).rows.filter((r) => r.application === "M-FFF2_A-0013-10-9AB0");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ catalogueApplications: ["M-FFF2_A-0013-10-4567"], orderNumbers: ["TWO-4", "TWO-4B"], catalogueEntries: 2 });
    // bussard naming it by either of its index ids finds the one row.
    const b = catalogueList(f, "Germany", SWEEP_MASKS, { generated: "2000-01-01", apps: { "M-FFF2_A-0013-10-9AB0": { mask: "07B0", manufacturer: "M-FFF2", outcome: "captured" } } }).bussard!;
    expect([b.theirs, b.both]).toEqual([1, 1]);
    expect(b.oursNotTheirs.map((d) => d.application)).not.toContain("M-FFF2_A-0013-10-9AB0");
  });

  test("a catalogue row whose application is refused still shares its order number", () => {
    const f = fetched();
    const index = f.indexes.find((x) => x.ManufacturerId === 0xfff2)!;
    const again = structuredClone(index.Entries.find((e) => e.OrderNumber === "TWO-4")!);
    again.Id = "M-FFF2_H-hw4-3_HP-0013-10-4567-0013-20-5678_CI-ORDER.2D4-1";
    again.OrderNumber = "ORDER-4";
    index.Entries.push(again);
    index.Markets!.find((m) => m.DefaultName === "Germany")!.CatalogIds.push(again.Id);
    f.programs.delete("M-FFF2_H-hw4-1_HP-0013-10-9AB0-0013-20-5678");
    const list = catalogueList(f, "Germany", SWEEP_MASKS);
    expect(list.refused.map((r) => r.entry)).toContain("M-FFF2_A-0013-10-4567");
    expect(list.rows.find((r) => r.application === "M-FFF1_A-0004-10-D004")).toMatchObject({ orderNumber: "ORDER-3", noOwnOrderNumber: true });
  });

  test("a mask with an extension is a mask, no row of the sweep's", () => {
    const f = fetched();
    f.applications.get("M-FFF1_A-0007-10-0007")!.MaskVersion = "MV-0300-01000001000000000000";
    expect(catalogueList(f, "Germany", SWEEP_MASKS).counts.byMask).toMatchObject({ "0300-01000001000000000000": 1 });
  });

  test("an order number of nothing but spaces is none to search for", () => {
    const f = fetched();
    f.indexes.find((x) => x.ManufacturerId === 0xfff1)!.Entries.find((e) => e.OrderNumber === "ORDER-4")!.OrderNumber = "  ";
    expect(catalogueList(f, "Germany", SWEEP_MASKS).rows.find((r) => r.application === "M-FFF1_A-0004-10-D004")).toMatchObject({ orderNumber: "ORDER-3", noOwnOrderNumber: true });
  });

  test("a hardware's second program beside the application: named with its type, no row of its own", () => {
    expect(row("M-FFF2_A-0013-10-9AB0")?.secondProgram).toEqual([{ application: "M-FFF2_A-0013-20-5678", programType: "PeiProgram" }]);
    expect(row("M-FFF2_A-0015-20-7890-O0001")?.secondProgram).toEqual([{ application: "M-FFF2_A-0016-10-8901-O0001", programType: "ApplicationProgram" }]);
    expect(row("M-FFF2_A-0013-20-5678")).toBeUndefined();
    expect(row("M-FFF2_A-0013-10-4567")).toBeUndefined();
    expect(row("M-FFF2_A-0016-10-8901-O0001")).toBeUndefined();
  });

  test("the catalogue's flags carried to the row", () => {
    expect(row("M-FFF1_A-0002-20-B002")?.secure).toBe(true);
    expect(row("M-FFF1_A-0004-10-D004")?.pluginRequired).toBe(true);
    expect(row("M-FFF1_A-0001-11-A001")?.secure).toBeUndefined();
  });

  test("the source of the list", () => {
    expect(list.source).toEqual({
      ets: "6.4.8718.0", licence: "ETS6HOME", catalogueDate: "2000-01-02T03:04:05Z", fetched: "2000-01-03T00:00:00.000Z",
      market: "Germany", indexFiles: 3, masks: SWEEP_MASKS,
    });
  });

  test("bussard's manifest compared both ways, each difference with its reason", () => {
    const b = list.bussard!;
    expect([b.theirs, b.ours, b.both]).toEqual([9, 7, 2]);
    expect(b.maskDiffers).toEqual([{ application: "M-FFF1_A-0003-10-C003", ours: "0701", theirs: "0705" }]);
    expect(b.theirsNotOurs.map((d) => [d.application, d.reason, d.detail])).toEqual([
      ["M-FFF1_A-0002-10-9999", "not in the catalogue; another version of its application is", "M-FFF1_A-0002-20-B002"],
      ["M-FFF1_A-0007-10-0007", "in the catalogue at another mask by its product data here", "091A"],
      ["M-FFF2_A-0011-10-2345", "in the catalogue, its product data not loaded here", undefined],
      ["M-FFF9_A-0001-10-0001", "not in the catalogue for this market", undefined],
      ["M-FFF2_A-0012-10-3456", "in the catalogue, its product data refused here", "ETS's product data names application number 18 version 17"],
      ["M-FFF2_A-0016-10-8901-O0001", "in the catalogue as the second program beside another application", "M-FFF2_A-0015-20-7890-O0001"],
      // Another OEM suffix is another application, not another version.
      ["M-FFF2_A-0010-13-AAAA-O0002", "not in the catalogue for this market", undefined],
    ]);
    expect(b.oursNotTheirs.map((d) => [d.application, d.reason, d.detail])).toEqual([
      ["M-FFF1_A-0002-20-B002", "bussard holds another version of its application", "M-FFF1_A-0002-10-9999 (captured)"],
      ["M-FFF1_A-0004-10-D004", "not in bussard's manifest; its manufacturer is", undefined],
      ["M-FFF2_A-0010-12-1234-O0001", "not in bussard's manifest; its manufacturer is", undefined],
      ["M-FFF2_A-0013-10-4567", "not in bussard's manifest; its manufacturer is", undefined],
      ["M-FFF2_A-0015-20-7890-O0001", "not in bussard's manifest; its manufacturer is", undefined],
    ]);
  });

  test("another market, other masks", () => {
    expect(catalogueList(fetched(), "Austria", SWEEP_MASKS).counts).toMatchObject({ marketEntries: 1, applications: 1, unloaded: 1, rows: 0 });
    expect(catalogueList(fetched(), "Germany", ["091A"]).rows.map((r) => r.application)).toEqual(["M-FFF1_A-0007-10-0007"]);
    expect(() => catalogueList(fetched(), "Atlantis", SWEEP_MASKS)).toThrow("no market Atlantis");
  });
});

describe("the Markdown", () => {
  const md = markdown(catalogueList(fetched(), "Germany", SWEEP_MASKS, bussard()));

  test("counts per mask and manufacturer", () => {
    expect(md).toContain("| **rows (07B0, 0701, 0705)** | **7** |");
    expect(md).toContain("| M-FFF1 Example One | 2 | 1 | 1 | 4 |");
    expect(md).toContain("| **all** | 4 | 1 | 2 | 7 |");
    expect(md).toContain("- a second program beside the application, PeiProgram: 1");
    expect(md).toContain("- a second program beside the application, ApplicationProgram: 1");
    expect(md).toContain("| 091A | 1 |  |");
    expect(md).toContain("- 4: not in bussard's manifest; its manufacturer is");
  });

  test("a regeneration keeps the text around the generated part", () => {
    const first = withGenerated(null, md);
    const edited = first.replace("# ETS online catalogue: the sweep's list\n", "# ETS online catalogue: the sweep's list\n\nA verdict written by hand.\n") + "\nA note below.\n";
    const again = withGenerated(edited, md.replace("**7**", "**8**"));
    expect(again).toContain("A verdict written by hand.");
    expect(again).toContain("A note below.");
    expect(again).toContain("**8**");
    expect(again.split(GENERATED_START).length).toBe(2);
    expect(again.split(GENERATED_END).length).toBe(2);
    expect(withGenerated("# Notes\n", md)).toBe(`# Notes\n\n${md}`);
  });

  test("markers that do not pair are refused, not appended to", () => {
    expect(() => withGenerated(`text\n${GENERATED_END}\n${GENERATED_START}\n`, md)).toThrow("the end first");
    expect(() => withGenerated(`text\n${GENERATED_START}\nhand text\n`, md)).toThrow("1 and 0 times");
    expect(() => withGenerated(`${md}\n${md}`, md)).toThrow("2 and 2 times");
  });
});

test("an XML start tag's attributes, entities decoded", () => {
  expect(attributes('<AP Id="M-FFF1_A-0001-11-A001" Name="A &amp; B &lt;1&gt; &#x41;&#66;" MaskVersion="MV-07B0">'))
    .toEqual({ Id: "M-FFF1_A-0001-11-A001", Name: "A & B <1> AB", MaskVersion: "MV-07B0" });
});

test("the store's listings read strictly: a program reference outside a hardware-to-program, a missing file", () => {
  const dir = join(tempDir("ets-catalogue-fetched"), "fetched");
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, "programs.txt"), 'M-FFF2/H:<APR RefId="M-FFF2_A-0013-10-9AB0" />\n');
  expect(() => readFetched(dir)).toThrow("a program reference outside a hardware-to-program");
  writeFileSync(join(dir, "programs.txt"), 'M-FFF2/H:<H2P Id="X">\n');
  expect(() => readFetched(dir)).toThrow("ends inside hardware-to-program X");
  rmSync(join(dir, "catalogue-items.txt"));
  expect(() => readFetched(dir)).toThrow("holds no catalogue-items.txt: fetch it again");
});
