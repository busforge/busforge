import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import type { CollectPackage } from "../packages/product/src/index.ts";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { collectedUnit, type StateInCaptures } from "./sim-unit-model.ts";
import { SIM_UNITS } from "./sim-units.ts";
import { mismatchLines, productAgainstUnit, productUnit, rerunIdentity, type ProductUnit } from "./sim-unit-product.ts";

// Parsing an application (its product unit, its collected unit) takes up to 6.7 s alone (the OpenKNX
// RaumController's, measured with --reporter=junit, the file alone); twenty times that under a loaded full check
// (docs/testing.md, "Timeouts of heavy tests").
setDefaultTimeout(140_000);

// The lines below are of the form decision 0004 §1 quotes from ETS ("Required data mismatch at
// SystemProperty(0/78)[$0000]: <device> instead of <required>"), the values as contiguous hex; the one line a sweep
// row records (a MEAN WELL unit answering a wrong hardware type) is read in tools/sim-unit-catalogue.test.ts.
const at = (rest: string) => `2026-11-20 10:00:00,000 [12] WARN  Knx.Ets.Hawk.LoadDeviceTask - Required data mismatch at ${rest}`;

describe("ETS's Required data mismatch lines", () => {
  test("are read from a Latin-1 ETS6.log", () => {
    const log = Buffer.from([
      "2026-11-20 09:59:59,000 [12] INFO  Knx.Ets.Hawk.LoadDeviceTask - Ger\u00e4t 1.1.1: inkompatible Produktdaten",
      at("SystemProperty(0/78)[$0000]:  instead of 620100000004"),
      at("SystemProperty(0/15)[$0000]: 0000 instead of 4E58"),
      "",
    ].join("\r\n"), "latin1");
    expect(mismatchLines(log).map((m) => [m.object, m.pid, m.device.toString("hex"), m.required.toString("hex")])).toEqual([
      [0, 78, "", "620100000004"],
      [0, 15, "0000", "4e58"],
    ]);
  });

  test("a line that names a mismatch and does not read as one is refused, not skipped", () => {
    expect(() => mismatchLines(at("Memory(0x4000)[$0000]: 00 instead of 01"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0000]: 00 instead of 6"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(256/78)[$0000]:  instead of 01"))).toThrow("no property service addresses");
    // What no recorded line shows the meaning of: another index, a range, spaced octets.
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0002]:  instead of 01"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0000-$0001]:  instead of 6201"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0000]:  instead of 62 01"))).toThrow("does not read");
  });
});

const app = (name: string) => catalogueXml(name);
const MEANWELL = "M-0162_A-0004-11-F245.xml.gz", DALI = "M-0048_A-9071-20-F258-O00EF.xml.gz", ABB = "M-0002_A-A001-13-63C2.xml.gz";
const given = (u: ProductUnit, key: string) => {
  const v = u.properties.get(key);
  return v && { bytes: v.bytes.toString("hex"), known: v.known.toString("hex"), sources: v.sources.map((s) => s.from === "product" ? s.what : s.line) };
};

corpusDescribe("a unit from its product alone", () => {
  test("takes the mask, the manufacturer and what the application's compares expect, each with its source", () => {
    const meanwell = productUnit(app(MEANWELL));
    expect([meanwell.mask, [...meanwell.properties.keys()]]).toEqual([0x07b0, ["0/12"]]);
    expect(given(meanwell, "0/12")).toEqual({ bytes: "0162", known: "ffff", sources: ["the application's manufacturer M-0162"] });
    const dali = productUnit(app(DALI));
    expect(given(dali, "0/12")!.sources).toEqual(["the application's manufacturer M-0048, made for M-00EF"]);
    expect(given(dali, "0/78")).toEqual({ bytes: "00907092910000000000", known: "ffffffffffffffffffff", sources: ["LdCtrlCompareProp 0/78 00907092910000000000"] });
    // A masked compare gives only the bits it compares.
    expect(given(productUnit(app(ABB)), "3/13")).toEqual({ bytes: "0000a00100", known: "0000ffff00", sources: ["LdCtrlCompareProp 3/13 0000a00100 mask 0000ffff00"] });
  });

  test("refuses a compare it would read as more than it says", () => {
    const withCompare = (attrs: string) => app(MEANWELL).replace("</LoadProcedure>", `<LdCtrlCompareProp ObjIdx="0" PropId="78" ${attrs} /></LoadProcedure>`);
    expect(() => productUnit(withCompare('StartElement="2" InlineData="1234"'))).toThrow("element addressing");
    expect(() => productUnit(withCompare('InlineData="1234" Mask="gg"'))).toThrow("which is no mask");
    expect(() => productUnit(withCompare('InlineData="1234" Count="2"'))).toThrow("declares Count");
    // A compare that contradicts the application's manufacturer.
    expect(() => productUnit(app(MEANWELL).replace("</LoadProcedure>", '<LdCtrlCompareProp ObjIdx="0" PropId="12" InlineData="0048" /></LoadProcedure>'))).toThrow("property 0/12: octet 0 is 01");
    expect(() => productUnit(app(MEANWELL).replace("</LoadProcedure>", '<LdCtrlCompareMem Address="16384" InlineData="00" /></LoadProcedure>'))).toThrow("holds LdCtrlCompareMem");
    // A BCU1 keeps its identity in memory, not in a device object.
    expect(() => productUnit(app("M-0083_A-0138-21-F18E-O0072.xml.gz"))).toThrow("of family system-1");
    expect(given(productUnit(withCompare('InlineData="1234" Mask="ff"')), "0/78")).toEqual({ bytes: "1200", known: "ff00", sources: ["LdCtrlCompareProp 0/78 1234 mask ff"] });
  });
});

corpusDescribe("the identity loop's rerun step", () => {
  const meanwell = () => productUnit(app(MEANWELL));
  const ok = (r: ReturnType<typeof rerunIdentity>) => { if ("refused" in r) throw new Error(r.refused); return r; };

  test("takes what ETS required where the product does not give it, with the line as its source", () => {
    const line = at("SystemProperty(0/78)[$0000]:  instead of 620100000004");
    const r = ok(rerunIdentity(meanwell(), `${line}\n`));
    expect(given(r.identity, "0/78")).toEqual({ bytes: "620100000004", known: "ffffffffffff", sources: [line] });
    expect(r.learned.map((m) => m.line)).toEqual([line]);
  });

  test("refuses a run whose log names no mismatch, or one it cannot read", () => {
    expect(rerunIdentity(meanwell(), "2026-11-20 10:00:00,000 [12] ERROR Knx.Ets.Hawk.LoadDeviceTask - Timeout")).toEqual({ refused: "the run's ETS6.log names no required data: its failure is not the identity" });
    expect((rerunIdentity(meanwell(), at("SystemProperty(0/78)[$0000]: 00 instead of 6")) as { refused: string }).refused).toContain("does not read");
  });

  test("refuses a mismatch against the product, between two lines, or of another run", () => {
    const refused = (u: ProductUnit, ...lines: string[]) => (rerunIdentity(u, lines.join("\n")) as { refused?: string }).refused;
    // The DALI-Gateway's application gives 0/78 in full.
    expect(refused(productUnit(app(DALI)), at("SystemProperty(0/78)[$0000]: 00907092910000000000 instead of 009070929101"))).toContain("octet 5 is 00");
    expect(refused(meanwell(), at("SystemProperty(0/78)[$0000]:  instead of 620100000004"), at("SystemProperty(0/78)[$0000]:  instead of 620100000005"))).toContain("octet 5 is 04");
    expect(refused(meanwell(), at("SystemProperty(0/12)[$0000]: 0048 instead of 0162"))).toContain("which this identity does not answer");
    expect(refused(meanwell(), at("SystemProperty(0/12)[$0000]: 0162 instead of 0162"))).toContain("which this identity already answers");
    // Each line is checked against the run's identity, also one whose required value an earlier line already gave.
    expect(refused(meanwell(), at("SystemProperty(0/15)[$0000]:  instead of 0102"), at("SystemProperty(0/15)[$0000]: ff instead of 0102"))).toContain("which this identity does not answer");
  });
});

// The simulated units, each with the collection it is simulated from.
const UNITS: { id: string; collection: string; catalogue: string; stateInCaptures?: StateInCaptures }[] =
  SIM_UNITS.map((s) => ({ id: s.id, collection: s.collection, catalogue: s.catalogue, stateInCaptures: s.memoryMapped || s.propertyMapped ? undefined : s.behaviour.stateInCaptures }));

// What a unit from the product alone gets wrong against the unit from its collection, every difference: the
// manufacturer is right on all of them (on the Jung, the Gira and the DALI-Gateway too, whose applications were made
// for another manufacturer); what the compares give is right but for its length where the unit answers fewer
// octets than the compare declares (the DALI-Gateway, the two MDTs) and the bits a mask leaves out (the ABB); everything
// else a unit answers ETS before a download (serial 0/11, order info 0/15, version 0/25, hardware type 0/78 where no
// compare names it, device control 0/14, maximum APDU 0/56, the load states and tables, the descriptions) the
// product does not give.
const EXPECTED: Record<string, string[]> = {
  "meanwell-knx40e": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/19 0/25 0/51 0/54 0/56 0/78 0/83 0/240 1/1 1/5 1/7 1/23 1/27 2/1 2/5 2/7 2/23 2/27 3/1 3/5 3/7 3/23 3/27 4/1 4/5 4/6 4/7 4/13 4/27 5/1 5/5 5/6 5/13 6/1 7/1 7/51 7/52 7/53 7/60",
    "descriptions not given: 110 for 64 object indices",
  ],
  "theben-dali-gateway": [
    "given as the unit holds them: 0/12",
    "0/78 length: product 10 octets 00907092910000000000, unit 6 octets 009070929100",
    "properties not given: 0/1 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/51 0/52 0/54 0/56 0/57 0/58 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 6/202 6/203 6/204 6/205 6/206 6/207 6/208 6/209 6/210 6/211 6/213 6/214 6/216 6/217 6/218 6/219 6/220 6/221 6/224 6/225 6/226 6/227 6/228",
    "descriptions not given: 137 for 64 object indices",
  ],
  "openknx-raumcontroller": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/9 0/11 0/14 0/15 0/25 0/51 0/54 0/56 0/57 0/58 0/71 0/83 1/1 1/5 1/7 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/27 3/28 4/1 4/5 4/7 4/13 4/16 4/27 4/28 5/5 5/13",
    "descriptions not given: 101 for 64 object indices",
  ],
  "theben-mix2-hmg6t": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/78 0/83 0/85 0/86 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 7/1 7/5 7/7 7/27 7/52 7/53 7/54 8/1",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000",
  ],
  "jung-400021se": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/71 0/78 0/83 0/85 0/86 0/201 0/202 0/203 1/1 1/5 1/7 1/23 1/27 2/1 2/5 2/7 2/23 2/27 3/1 3/5 3/7 3/23 3/27 4/1 4/5 4/6 4/7 4/13 4/16 4/27 5/1 5/5 5/6 5/7 5/13 5/16 5/27 6/1 6/2 7/1 8/1 8/2 8/5 8/7 8/25 8/27 9/1 9/2 9/5 9/7 9/25 9/27 10/1",
    "descriptions not given: 150 for 64 object indices",
    "function-property states not given: 17/1/51 0000",
    "A_MemoryExtended_Read not given",
  ],
  "gvs-amma": [
    "given as the unit holds them: 0/12 4/66",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/78 0/83 0/196 0/197 0/198 0/201 0/203 0/204 0/205 0/206 0/224 1/1 1/5 1/7 1/23 1/27 2/1 2/5 2/7 2/23 2/27 3/1 3/5 3/7 3/23 3/27 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/67 5/1 5/5 5/6 5/13 5/27 6/1 7/1 7/222 11/1 11/222",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000",
  ],
  "abb-usu-4.2": [
    "given as the unit holds them: 0/12",
    "3/13 given in part: product ????a001??, unit 0002a00113",
    "properties not given: 0/1 0/9 0/11 0/14 0/15 0/16 0/25 0/56 0/78 1/1 1/5 1/7 2/1 2/5 2/7 3/1 3/5 3/6 3/7 3/16 3/20 3/204 4/1 4/13",
    "descriptions not given: 85 for 64 object indices",
  ],
  "theben-meteodata-140s": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/78 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/128 5/129 5/130 5/131 5/132 5/133 5/134 5/135 5/144 5/145 5/146 5/147 5/148 5/149 5/160 5/161 5/162 5/163 5/164 5/165 5/166 5/167 5/168 5/169 5/170 5/171 5/172",
    "descriptions not given: 121 for 64 object indices",
  ],
  "mdt-be02001": [
    "given as the unit holds them: 0/12",
    "0/78 length: product 10 octets 0000000002ac00000000, unit 6 octets 0000000002ac",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/19 0/25 0/54 0/56 0/83 0/240 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/51 5/52 5/53 5/60",
    "descriptions not given: 95 for 64 object indices",
  ],
  "gira-ts3": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/78 0/201 0/203 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27",
    "descriptions not given: 94 for 64 object indices",
  ],
  "theben-mix2-jmg4t": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/78 0/83 0/85 0/86 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 7/1 7/5 7/7 7/27 7/52 7/53 7/54 8/1",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000"
  ],
  "theben-mix2-rmg8t": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/78 0/83 0/85 0/86 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 7/1 7/5 7/7 7/27 7/52 7/53 7/54 8/1",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000"
  ],
  "auro-m0081": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/78 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27",
    "descriptions not given: 93 for 64 object indices"
  ],
  "theben-theluxa-p300": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/78 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/129",
    "descriptions not given: 95 for 64 object indices"
  ],
  "mdt-be06001": [
    "given as the unit holds them: 0/12",
    "0/78 length: product 10 octets 0000000002aa00000000, unit 6 octets 0000000002aa",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/19 0/25 0/54 0/56 0/83 0/240 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/51 5/52 5/53 5/60",
    "descriptions not given: 95 for 64 object indices"
  ],
};

corpusDescribe("the units from their product against their collection: every difference", () => {
  for (const u of UNITS) test(u.id, () => {
    const collection = JSON.parse(readFileSync(corpusPath(u.collection), "utf8")) as CollectPackage;
    const xml = app(u.catalogue);
    const unit = collectedUnit(collection, xml, (why) => { throw new Error(`${u.id}: ${why}`); }, u.stateInCaptures);
    expect(productAgainstUnit(productUnit(xml), unit)).toEqual(EXPECTED[u.id]);
  });
});
