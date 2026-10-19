import { test, expect } from "bun:test";
import { parseAppConfig, buildDeviceConfig, buildComObjectTable, withInstanceOverrides, withLinkedCommFlags, placeComObjOverrides } from "../packages/product/src/index.ts";
import { catalogueXml, captureText } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { parseCapture, memoryImage, captureDevice } from "./etsdiff.ts";

// ETS 6 partial downloads after a com-object flag change alone, on the bench: the read flag of one
// object off, then back on. ETS writes them with its group-address download
// ("PartialLoadGroupCommunication" in its log); the object's flag bit is the only byte of the
// com-object table that changes.

const span = (mem: Map<number, number>, at: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => {
  const b = mem.get(at + i);
  if (b === undefined) throw new Error(`byte ${at + i} is not in the capture`);
  return b;
}));

// MDT BE-02001.02 (System 7, MV-0705), input A's object 0, linked to no group address in the project.
// The read-on run is the clean one: the unit held the table the read-off run wrote.
corpusDescribe("System 7 flag change against ETS's group-address download", () => {
  const app = "M-0083_A-00B6-32-9642.xml.gz";
  const cfg = parseAppConfig(catalogueXml(app));
  const l3 = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.comObjectSegment)!;
  const written = (file: string) => memoryImage(parseCapture(captureText(file), captureDevice(captureText(file))).writes);
  const view = buildDeviceConfig(cfg, new Map());
  const ref0 = [...view.imageComObjects.values()].find((o) => o.number === 0)!.refId.replace(`${cfg.id}_`, "");
  const tableOf = (file: string) => { const m = written(file); return span(m, l3.address, m.get(l3.address)! * 4 + 3); };

  test("ETS writes the whole table; only object 0's config byte changes, by the read bit", () => {
    const off = tableOf("mdt-be02001-ets-partial-flag-read-off.log"), on = tableOf("mdt-be02001-ets-partial-flag-read-on.log");
    expect([...off.keys()].filter((i) => off[i] !== on[i])).toEqual([3 + 2]);
    expect([off[5], on[5]]).toEqual([0x43, 0x4b]);
  });

  test("the group-address flash lays the project's changed flags over the table the unit holds, as ETS writes them", () => {
    const held = tableOf("mdt-be02001-ets-partial-flag-read-off.log");
    // The project's flags for object 0 back to the application's: the change since the last write.
    const authored = withInstanceOverrides(view.imageComObjects, placeComObjOverrides(cfg, view, []));
    const ours = withLinkedCommFlags(held, new Set(), new Map([[0, authored.get(0)!]]));
    expect(ours.toString("hex")).toBe(tableOf("mdt-be02001-ets-partial-flag-read-on.log").toString("hex"));
    // and the read flag off again, as the project's own override
    const off = withInstanceOverrides(view.imageComObjects, placeComObjOverrides(cfg, view, [{ comObjRefId: ref0, attrs: { ReadFlag: "Disabled" } }]));
    expect(withLinkedCommFlags(ours, new Set(), new Map([[0, off.get(0)!]])).toString("hex")).toBe(held.toString("hex"));
  });
});

// Jung 400021SE (System B, Data Secure), K1's switching object 253 on K1's group address. The unit is
// secured, so the plaintext of every memory write comes from ETS's own log.
corpusDescribe("System B flag change against ETS's group-address download", () => {
  const app = "M-0004_A-7072-21-99A7-O000A.xml.gz";
  const cfg = parseAppConfig(catalogueXml(app));
  const K = (s: string) => `${cfg.id}_${s}`;
  const params = new Map([[K("MD-1_M-100_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-100_MI-1_P-150_R-243"), "Taster"], [K("MD-1_M-200_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-200_MI-1_P-150_R-243"), "Taster"]]);
  const view = buildDeviceConfig(cfg, params);
  const ref253 = [...view.imageComObjects.values()].find((o) => o.number === 253)!.refId.replace(`${cfg.id}_`, "");
  const etsWrites = (file: string) => {
    const m = new Map<number, number>();
    for (const l of captureText(file).split(/\r?\n/)) {
      const w = !l.includes("Sending") && l.match(/ Send Sec_req -> .*InnerTelegram=MemoryExtended_Write_req -> \S+ \([^)]*\) Address=\$([0-9A-F]+) Count=\d+ Data=([0-9A-F]+)/);
      if (w) Buffer.from(w[2], "hex").forEach((b, i) => m.set(Number.parseInt(w[1], 16) + i, b));
    }
    return m;
  };
  const L3_AT = 0x15000;
  const tableOf = (file: string) => { const m = etsWrites(file); return span(m, L3_AT, ((m.get(L3_AT)! << 8) | m.get(L3_AT + 1)!) * 2 + 2); };
  const ours = (rows: { comObjRefId: string; attrs: Record<string, string> }[]) =>
    buildComObjectTable(withInstanceOverrides(view.imageComObjects, placeComObjOverrides(cfg, view, rows)), view.maxComObjectNumber, new Set([253]));

  test("ETS writes the whole table; only object 253's flags byte changes, by the read bit", () => {
    const off = tableOf("jung-400021se-ets6log-partial-flag-read-off.txt"), on = tableOf("jung-400021se-ets6log-partial-flag-read-on.txt");
    const at = 2 + (253 - 1) * 2;
    expect([...off.keys()].filter((i) => off[i] !== on[i])).toEqual([at]);
    expect([off[at], on[at]]).toEqual([0xc7, 0xcf]);
  });

  test("the group-address flash's com-object table, with and without the project's read flag, is every byte ETS wrote", () => {
    expect(ours([]).toString("hex")).toBe(tableOf("jung-400021se-ets6log-partial-flag-read-on.txt").toString("hex"));
    expect(ours([{ comObjRefId: ref253, attrs: { ReadFlag: "Disabled" } }]).toString("hex")).toBe(tableOf("jung-400021se-ets6log-partial-flag-read-off.txt").toString("hex"));
  });
});
