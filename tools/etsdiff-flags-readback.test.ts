import { test, expect } from "bun:test";
import { parseAppConfig, buildDeviceConfig, decodeComObjectTable, decodeComObjectTableMv0705, deviceComObjOverrideRows, comObjFlagsDiffering, placeComObjOverrides } from "../packages/product/src/index.ts";
import { catalogueXml, captureText } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { parseCapture, memoryImage, captureDevice } from "./etsdiff.ts";

// A read-back takes a device's com-object flags from its table. The tables ETS wrote in its partial
// downloads after a read-flag change alone (the captures of tools/etsdiff-flags.test.ts), read as a
// read-back reads them, give back exactly the flags the project set: the read flag of the one object
// off where the project had it off, nothing on any other object of the configuration.

const span = (mem: Map<number, number>, at: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => {
  const b = mem.get(at + i);
  if (b === undefined) throw new Error(`byte ${at + i} is not in the capture`);
  return b;
}));

// MDT BE-02001.02 (System 7, MV-0705), input A's object 0, linked to no group address in the project.
corpusDescribe("System 7 flags read from the table ETS wrote", () => {
  const cfg = parseAppConfig(catalogueXml("M-0083_A-00B6-32-9642.xml.gz"));
  const l3 = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.comObjectSegment)!;
  const tableOf = (file: string) => { const m = memoryImage(parseCapture(captureText(file), captureDevice(captureText(file))).writes); return span(m, l3.address, m.get(l3.address)! * 4 + 3); };
  const view = buildDeviceConfig(cfg, new Map());
  const ref0 = view.imageComObjects.get(0)!.refId.replace(`${cfg.id}_`, "");

  test("the read flag off on object 0 and nothing else", () => {
    expect(deviceComObjOverrideRows(cfg, view.imageComObjects, decodeComObjectTableMv0705(tableOf("mdt-be02001-ets-partial-flag-read-off.log"), new Set()), []))
      .toEqual({ rows: [{ comObjRefId: ref0, attrs: { ReadFlag: "Disabled" } }], undecoded: [] });
    expect(deviceComObjOverrideRows(cfg, view.imageComObjects, decodeComObjectTableMv0705(tableOf("mdt-be02001-ets-partial-flag-read-on.log"), new Set()), []))
      .toEqual({ rows: [], undecoded: [] });
  });
  // The same object linked to one group address, its communication flag off and back on: ETS keeps the
  // association and clears the object's 0x04 bit.
  test("the communication flag off on the linked object 0 and nothing else", () => {
    expect(deviceComObjOverrideRows(cfg, view.imageComObjects, decodeComObjectTableMv0705(tableOf("mdt-be02001-ets-partial-flag-comm-off.log"), new Set([0])), []))
      .toEqual({ rows: [{ comObjRefId: ref0, attrs: { CommunicationFlag: "Disabled" } }], undecoded: [] });
    expect(deviceComObjOverrideRows(cfg, view.imageComObjects, decodeComObjectTableMv0705(tableOf("mdt-be02001-ets-partial-flag-comm-on.log"), new Set([0])), []))
      .toEqual({ rows: [], undecoded: [] });
  });
  test("the flags taken from the table are the ones a write that rewrites it then finds there", () => {
    const off = decodeComObjectTableMv0705(tableOf("mdt-be02001-ets-partial-flag-read-off.log"), new Set());
    const taken = deviceComObjOverrideRows(cfg, view.imageComObjects, off, []).rows;
    expect(comObjFlagsDiffering(off, view.imageComObjects, placeComObjOverrides(cfg, view, taken))).toEqual([]);
    expect(comObjFlagsDiffering(off, view.imageComObjects, undefined)).toEqual([0]);
  });
});

// Jung 400021SE (System B, Data Secure), K1's switching object 253 on K1's group address; the plaintext
// of every memory write from ETS's own log.
corpusDescribe("System B flags read from the table ETS wrote", () => {
  const cfg = parseAppConfig(catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz"));
  const K = (s: string) => `${cfg.id}_${s}`;
  const params = new Map([[K("MD-1_M-100_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-100_MI-1_P-150_R-243"), "Taster"], [K("MD-1_M-200_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-200_MI-1_P-150_R-243"), "Taster"]]);
  const view = buildDeviceConfig(cfg, params);
  const ref253 = view.imageComObjects.get(253)!.refId.replace(`${cfg.id}_`, "");
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
  const linked = new Set([253]);

  test("the read flag off on object 253 and nothing else, the communication flag taken only where the object is linked", () => {
    expect(deviceComObjOverrideRows(cfg, view.imageComObjects, decodeComObjectTable(tableOf("jung-400021se-ets6log-partial-flag-read-off.txt"), linked), []))
      .toEqual({ rows: [{ comObjRefId: ref253, attrs: { ReadFlag: "Disabled" } }], undecoded: [] });
    expect(deviceComObjOverrideRows(cfg, view.imageComObjects, decodeComObjectTable(tableOf("jung-400021se-ets6log-partial-flag-read-on.txt"), linked), []))
      .toEqual({ rows: [], undecoded: [] });
  });
  test("the flags taken from the table are the ones a write that rewrites it then finds there", () => {
    const off = decodeComObjectTable(tableOf("jung-400021se-ets6log-partial-flag-read-off.txt"), linked);
    const taken = deviceComObjOverrideRows(cfg, view.imageComObjects, off, []).rows;
    expect(comObjFlagsDiffering(off, view.imageComObjects, placeComObjOverrides(cfg, view, taken))).toEqual([]);
    expect(comObjFlagsDiffering(off, view.imageComObjects, undefined)).toEqual([253]);
  });
});
