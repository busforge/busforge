import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { loadKnxproj } from "../packages/project/src/index.ts";
import { readZip } from "../packages/project/src/zip.ts";
import { zipOf } from "../packages/project/test/ziputil.ts";
import { corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { reduceExport, reduceProjectExport } from "./ets-export-reduce.ts";
import { SWEEP_DIR } from "./ets-sweep.ts";

const APP = "M-0083_A-00B6-32-9642";
const PEI = "M-0002_A-A001-13-63C2-O0001";
const deflated = (s: string) => ({ data: deflateRawSync(Buffer.from(s)), method: 8, size: Buffer.byteLength(s) });
// A Hardware.xml; a Hardware2Program without programs is written self-closing, as ETS writes it.
const hardware = (h2ps: Record<string, string[]>) => Buffer.from(`<KNX><ManufacturerData><Manufacturer><Hardware><Hardware><Hardware2Programs>${
  Object.entries(h2ps).map(([id, refs]) => refs.length === 0 ? `<Hardware2Program Id="${id}" MediumTypes="MT-0" />`
    : `<Hardware2Program Id="${id}" MediumTypes="MT-0">${refs.map((r) => `<ApplicationProgramRef RefId="${r}" />`).join("")}</Hardware2Program>`).join("")
}</Hardware2Programs></Hardware></Hardware></Manufacturer></ManufacturerData></KNX>`);
// The project's two devices: one of M-0083 with one application, one of M-0002 whose Hardware2Program names an
// application and a PEI program.
const DEVICES = [
  { ia: "1.1.1", productRef: "M-0083_H-1-P-1", appRef: "M-0083_H-1_HP-00B6-32-9642" },
  { ia: "1.1.2", productRef: "M-0002_H-2-P-2", appRef: "M-0002_H-2_HP-A001-13-63C2" },
];
// An export of ETS's shape: the project, the master data, and three manufacturers' product data, of which the
// devices' manufacturers hold other applications, baggages and signatures besides.
const ENTRIES = [
  { name: "knx_master.xml", ...deflated("<KNX>master</KNX>") },
  { name: ".validation", data: Buffer.from("v") },
  { name: "P-0561.signature", data: Buffer.from("ps") },
  { name: "P-0561.certificate", data: Buffer.from("pc") },
  { name: "P-0561/", data: Buffer.alloc(0) },
  { name: "P-0561/0.xml", ...deflated("<KNX>project</KNX>") },
  { name: "M-0002.signature", data: Buffer.from("s2") },
  { name: "M-0002/", data: Buffer.alloc(0) },
  { name: "M-0002/Hardware.xml", data: hardware({ "M-0002_H-2_HP-A001-13-63C2": ["M-0002_A-A001-13-63C2", PEI], "M-0002_H-3_HP-A002-10-0": ["M-0002_A-A002-10-0"] }) },
  { name: "M-0002/M-0002_A-A001-13-63C2.xml", ...deflated("the second device's application") },
  { name: `M-0002/${PEI}.xml`, ...deflated("the second device's PEI program") },
  { name: "M-0002/M-0002_A-A002-10-0.xml", ...deflated("an application no device runs") },
  { name: "M-0083.signature", data: Buffer.from("s83") },
  { name: "M-0083/", data: Buffer.alloc(0) },
  { name: "M-0083/Hardware.xml", data: hardware({ "M-0083_H-5_HP-0": [], "M-0083_H-1_HP-00B6-32-9642": [APP] }) },
  { name: "M-0083/Catalog.xml", data: Buffer.from("c83") },
  { name: "M-0083/Baggages.xml", data: Buffer.from("b83") },
  { name: "M-0083/Baggages/", data: Buffer.alloc(0) },
  { name: "M-0083/Baggages/help.png", data: Buffer.from("png") },
  { name: `M-0083/${APP}.xml`, ...deflated("the first device's application") },
  { name: "M-0083/M-0083_A-00B4-32-3919.xml", ...deflated("another application of the manufacturer") },
  { name: "M-0085/", data: Buffer.alloc(0) },
  { name: "M-0085/M-0085_A-0072-30-69AA.xml", data: Buffer.from("a85") },
];
const EXPORT = zipOf(ENTRIES);

describe("an ETS export reduced to the product data of its project's devices", () => {
  test("keeps an ETS app attached to the project only where a device of the project is of its manufacturer", () => {
    // ETS's names for an attached app (a DCA, as an earlier sweep row left one in the sweep project) and another file.
    const withApps = zipOf([...ENTRIES,
      { name: "P-0561/UserFiles/", data: Buffer.alloc(0) },
      { name: "P-0561/UserFiles/M0048-A00C8.etsapp", data: Buffer.from("an app of a manufacturer no device is of") },
      { name: "P-0561/UserFiles/M0083-A0011.etsapp", data: Buffer.from("an app of the first device's manufacturer") },
      { name: "P-0561/UserFiles/notes.pdf", data: Buffer.from("a file the project carries") },
    ]);
    const r = reduceExport(withApps, DEVICES);
    expect([...readZip(r.bytes).keys()].filter((n) => n.includes("UserFiles"))).toEqual(["P-0561/UserFiles/M0083-A0011.etsapp", "P-0561/UserFiles/notes.pdf"]);
    expect(r.dropped).toContain("P-0561/UserFiles/M0048-A00C8.etsapp");
  });

  test("keeps the project, the master data, the devices' manufacturers' hardware and catalogue and the programs their Hardware2Program entries name, byte for byte", () => {
    const r = reduceExport(EXPORT, DEVICES);
    const before = readZip(EXPORT), after = readZip(r.bytes);
    expect([...after.keys()]).toEqual([
      "knx_master.xml", ".validation", "P-0561.signature", "P-0561.certificate", "P-0561/0.xml",
      "M-0002/Hardware.xml", "M-0002/M-0002_A-A001-13-63C2.xml", `M-0002/${PEI}.xml`,
      "M-0083/Hardware.xml", "M-0083/Catalog.xml", `M-0083/${APP}.xml`,
    ]);
    for (const [name, data] of after) expect(data.equals(before.get(name)!)).toBe(true);
    expect(r.dropped).toEqual([
      "M-0002.signature", "M-0002/M-0002_A-A002-10-0.xml", "M-0083.signature",
      "M-0083/Baggages.xml", "M-0083/Baggages/", "M-0083/Baggages/help.png", "M-0083/M-0083_A-00B4-32-3919.xml",
      "M-0085/", "M-0085/M-0085_A-0072-30-69AA.xml",
    ]);
    // Each kept entry's local header and data are the export's bytes.
    for (const name of ["P-0561/0.xml", `M-0083/${APP}.xml`]) {
      // The first occurrence of the name is its local header's (the central directory follows the data).
      const local = (zip: Buffer) => { const at = zip.indexOf(Buffer.from(name)) - 30; return zip.subarray(at, at + 30 + name.length + zip.readUInt32LE(at + 18)); };
      expect(local(r.bytes).equals(local(EXPORT))).toBe(true);
    }
    // A reduced export reduces to itself.
    expect(reduceExport(r.bytes, DEVICES)).toEqual({ bytes: r.bytes, dropped: [] });
  });

  test("keeps the program a device's Hardware2Program id names where no Hardware.xml describes it", () => {
    const r = reduceExport(EXPORT, [{ ia: "1.1.3", productRef: "M-0085_H-9-P-9", appRef: "M-0085_H-9_HP-0072-30-69AA" }]);
    expect([...readZip(r.bytes).keys()].filter((n) => n.startsWith("M-"))).toEqual(["M-0085/M-0085_A-0072-30-69AA.xml"]);
  });

  test("keeps a program its product's manufacturer names in another manufacturer's directory", () => {
    const oem = zipOf([
      { name: "P-0001/0.xml", data: Buffer.from("project") },
      { name: "M-00C8/Hardware.xml", data: hardware({ "M-00C8_H-1_HP-0001-10-AAAA": [APP] }) },
      { name: "M-0083/", data: Buffer.alloc(0) },
      { name: `M-0083/${APP}.xml`, data: Buffer.from("the OEM product's application") },
      { name: "M-0083/Hardware.xml", data: Buffer.from("the program's manufacturer's own hardware") },
    ]);
    const r = reduceExport(oem, [{ ia: "1.1.6", productRef: "M-00C8_H-1-P-1", appRef: "M-00C8_H-1_HP-0001-10-AAAA" }]);
    expect([...readZip(r.bytes).keys()]).toEqual(["P-0001/0.xml", "M-00C8/Hardware.xml", `M-0083/${APP}.xml`]);
    expect(r.dropped).toEqual(["M-0083/Hardware.xml"]);
  });

  test("keeps no program for a device whose Hardware2Program names none", () => {
    const r = reduceExport(EXPORT, [{ ia: "1.1.5", productRef: "M-0083_H-5-P-5", appRef: "M-0083_H-5_HP-0" }]);
    expect([...readZip(r.bytes).keys()].filter((n) => n.startsWith("M-"))).toEqual(["M-0083/Hardware.xml", "M-0083/Catalog.xml"]);
  });

  test("refuses a device whose application program the export does not hold, and a project without devices", () => {
    expect(() => reduceExport(EXPORT, [{ ia: "1.1.4", productRef: "M-0083_H-1-P-1", appRef: "M-0083_H-4_HP-0137-20-7EB2" }])).toThrow("the export holds no application program M-0083_A-0137-20-7EB2 (the device 1.1.4)");
    expect(() => reduceExport(EXPORT, [])).toThrow("the project holds no device whose product data to keep");
  });

  test("refuses an archive whose entries overlap or leave a gap, which copying by spans would corrupt", () => {
    const zip = zipOf([{ name: "P-0561/0.xml", data: Buffer.from("project") }, { name: `M-0083/${APP}.xml`, data: Buffer.from("application") }]);
    const device = [{ ia: "1.1.1", productRef: "M-0083_H-1-P-1", appRef: "M-0083_H-1_HP-00B6-32-9642" }];
    // The first entry (STORE) declared longer, into the next local header, or shorter, leaving a gap: both read.
    const declare = (n: number) => {
      const z = Buffer.from(zip), cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      for (const at of [18, 22, cd + 20, cd + 24]) z.writeUInt32LE(n, at);
      return z;
    };
    expect(readZip(declare(9)).get("P-0561/0.xml")!.length).toBe(9);
    expect(reduceExport(declare(7), device).bytes.length).toBe(zip.length);
    expect(() => reduceExport(declare(9), device)).toThrow("P-0561/0.xml (local header at 0, data to 51) does not end where the next entry begins (49)");
    expect(() => reduceExport(declare(5), device)).toThrow("P-0561/0.xml (local header at 0, data to 47) does not end where the next entry begins (49)");
  });

  test("refuses what is no zip", () => {
    expect(() => reduceExport(Buffer.from("no zip at all, just text"), DEVICES)).toThrow("no end of central directory record");
  });

  test("refuses a Hardware2Program described twice or naming a program without its RefId: which programs to keep is not said", () => {
    const device = [DEVICES[0]];
    const withHardware = (...docs: [string, Buffer][]) => zipOf([{ name: "P-0001/0.xml", data: Buffer.from("project") }, ...docs.map(([name, data]) => ({ name, data })), { name: `M-0083/${APP}.xml`, data: Buffer.from("application") }]);
    const h2p = { [DEVICES[0].appRef]: [APP] };
    expect(() => reduceExport(withHardware(["M-0083/Hardware.xml", hardware(h2p)], ["M-0084/Hardware.xml", hardware(h2p)]), device)).toThrow(`the product data describe the Hardware2Program ${DEVICES[0].appRef} twice`);
    expect(() => reduceExport(withHardware(["M-0083/Hardware.xml", hardware({ [DEVICES[0].appRef]: [APP, ""] })]), device)).toThrow(`the Hardware2Program ${DEVICES[0].appRef} names an application program without its RefId`);
  });

  test("its command refuses a password variable that is not set", () => {
    const run = Bun.spawnSync([process.execPath, "run", fileURLToPath(new URL("./ets-export-reduce.ts", import.meta.url)), "in.knxproj", "out.knxproj", "--password-env", "BUSFORGE_NO_SUCH_VARIABLE"], { env: { PATH: process.env.PATH ?? "" } });
    expect([run.exitCode, run.stderr.toString().trim()]).toEqual([2, "ets-export-reduce: --password-env BUSFORGE_NO_SUCH_VARIABLE: the variable is not set"]);
  });
});

// Two exports of the corpus's sweep rows (one project that holds every product it ever held, one with its own):
// the project reads the same from the reduced export as from the export.
corpusDescribe("a sweep row's export reduced", () => {
  for (const row of ["M-0162_A-0004-11-F245/defaults", "M-0002_A-A001-13-63C2/defaults"]) {
    test(`${row}: the project as in the export`, () => {
      const bytes = readFileSync(corpusPath(`${SWEEP_DIR}/${row}/export.knxproj`));
      const r = reduceProjectExport(bytes, undefined);
      expect(loadKnxproj(r.bytes, undefined, "export")).toEqual(loadKnxproj(bytes, undefined, "export"));
      expect(reduceProjectExport(r.bytes, undefined).bytes.equals(r.bytes)).toBe(true);
    });
  }
});
