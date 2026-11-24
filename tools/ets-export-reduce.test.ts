import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { appProgramId, loadKnxproj } from "../packages/project/src/index.ts";
import { readZip } from "../packages/project/src/zip.ts";
import { zipOf } from "../packages/project/test/ziputil.ts";
import { corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { reduceExport } from "./ets-export-reduce.ts";
import { SWEEP_DIR } from "./ets-sweep.ts";

const APP = "M-0083_A-00B6-32-9642";
const deflated = (s: string) => ({ data: deflateRawSync(Buffer.from(s)), method: 8, size: Buffer.byteLength(s) });
// An export of ETS's shape: the project, the master data, and three manufacturers' product data, of which the
// device's manufacturer holds its application, another application, baggages and a signature.
const EXPORT = zipOf([
  { name: "knx_master.xml", ...deflated("<KNX>master</KNX>") },
  { name: ".validation", data: Buffer.from("v") },
  { name: "P-0561.signature", data: Buffer.from("ps") },
  { name: "P-0561.certificate", data: Buffer.from("pc") },
  { name: "P-0561/", data: Buffer.alloc(0) },
  { name: "P-0561/0.xml", ...deflated("<KNX>project</KNX>") },
  { name: "M-0002.signature", data: Buffer.from("s2") },
  { name: "M-0002/", data: Buffer.alloc(0) },
  { name: "M-0002/Hardware.xml", data: Buffer.from("h2") },
  { name: "M-0002/M-0002_A-A001-13-63C2.xml", ...deflated("other manufacturer's application") },
  { name: "M-0083.signature", data: Buffer.from("s83") },
  { name: "M-0083/", data: Buffer.alloc(0) },
  { name: "M-0083/Hardware.xml", data: Buffer.from("h83") },
  { name: "M-0083/Catalog.xml", data: Buffer.from("c83") },
  { name: "M-0083/Baggages.xml", data: Buffer.from("b83") },
  { name: "M-0083/Baggages/", data: Buffer.alloc(0) },
  { name: "M-0083/Baggages/help.png", data: Buffer.from("png") },
  { name: `M-0083/${APP}.xml`, ...deflated("the device's application") },
  { name: "M-0083/M-0083_A-00B4-32-3919.xml", ...deflated("another application of the manufacturer") },
  { name: "M-0085/", data: Buffer.alloc(0) },
  { name: "M-0085/M-0085_A-0072-30-69AA.xml", data: Buffer.from("a85") },
]);

describe("an ETS export reduced to the device's product data", () => {
  test("keeps the project, the master data and the manufacturer's hardware, catalogue and the application, byte for byte", () => {
    const r = reduceExport(EXPORT, [APP]);
    const before = readZip(EXPORT), after = readZip(r.bytes);
    expect([...after.keys()]).toEqual([
      "knx_master.xml", ".validation", "P-0561.signature", "P-0561.certificate", "P-0561/0.xml",
      "M-0083/Hardware.xml", "M-0083/Catalog.xml", `M-0083/${APP}.xml`,
    ]);
    for (const [name, data] of after) expect(data.equals(before.get(name)!)).toBe(true);
    expect(r.dropped).toEqual([
      "M-0002.signature", "M-0002/", "M-0002/Hardware.xml", "M-0002/M-0002_A-A001-13-63C2.xml", "M-0083.signature",
      "M-0083/Baggages.xml", "M-0083/Baggages/", "M-0083/Baggages/help.png", "M-0083/M-0083_A-00B4-32-3919.xml",
      "M-0085/", "M-0085/M-0085_A-0072-30-69AA.xml",
    ]);
    // Each kept entry's local header and data are the export's bytes.
    for (const name of ["P-0561/0.xml", `M-0083/${APP}.xml`]) {
      // The first occurrence of the name is its local header's (the central directory follows the data).
      const local = (zip: Buffer) => { const at = zip.indexOf(Buffer.from(name)) - 30; return zip.subarray(at, at + 30 + name.length + zip.readUInt32LE(at + 18)); };
      expect(local(r.bytes).equals(local(EXPORT))).toBe(true);
    }
  });

  test("keeps the application whatever the case of its name in the archive", () => {
    expect([...readZip(reduceExport(EXPORT, [APP.toLowerCase()]).bytes).keys()]).toContain(`M-0083/${APP}.xml`);
  });

  test("refuses an application the export does not hold, applications of two manufacturers, and no application", () => {
    expect(() => reduceExport(EXPORT, ["M-0083_A-0137-20-7EB2"])).toThrow("the export holds no application program m-0083_a-0137-20-7eb2");
    expect(() => reduceExport(EXPORT, [APP, "M-0085_A-0072-30-69AA"])).toThrow("of 2 manufacturers");
    expect(() => reduceExport(EXPORT, [])).toThrow("no application to keep");
    expect(() => reduceExport(EXPORT, ["M-0083_H-1_HP-00B6-32-9642"])).toThrow("is no application program id");
  });

  test("refuses what is no zip", () => {
    expect(() => reduceExport(Buffer.from("no zip at all, just text"), [APP])).toThrow("no end of central directory record");
  });
});

// Two exports ETS wrote in the stage-1 sweep (one project with every earlier product, one with its own): the project
// reads the same from the reduced export as from ETS's.
corpusDescribe("a sweep row's export reduced", () => {
  for (const row of ["M-0162_A-0004-11-F245/defaults", "M-0002_A-A001-13-63C2/defaults"]) {
    test(`${row}: the project as in ETS's export`, () => {
      const bytes = readFileSync(corpusPath(`${SWEEP_DIR}/${row}/export.knxproj`));
      const conf = JSON.parse(readFileSync(corpusPath(`${SWEEP_DIR}/${row}/configuration.json`), "utf8")) as { appRef: string };
      const r = reduceExport(bytes, [appProgramId(conf.appRef)]);
      expect(r.bytes.length).toBeLessThan(bytes.length);
      expect(loadKnxproj(r.bytes, undefined, "export")).toEqual(loadKnxproj(bytes, undefined, "export"));
    });
  }
});
