import { test, expect, describe } from "bun:test";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { storeZip, zipOf } from "../../../packages/project/test/ziputil.ts";
import { ZIP_ENTRY_LIMIT } from "../../../packages/project/src/zip.ts";
import { tempDir } from "../../../tools/test-temp.ts";
import en from "../../web/src/locales/en.ts";
import de from "../../web/src/locales/de.ts";

// The catalogue import reports a file that is no zip, and a zip without manufacturer products, as
// CATALOG_IMPORT_EMPTY, and an encrypted one as CATALOG_ENCRYPTED, since it takes no password; every other
// refusal of the archive keeps its own code, as the project import does.
const M = "M-0083";
const hardware = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><ManufacturerData><Manufacturer RefId="${M}"><Hardware>
  <Hardware Id="${M}_H-1-1" Name="Unit" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="false">
    <Products><Product Id="${M}_H-1-1_P-1" Text="Unit" OrderNumber="U-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="${M}_H-1-1_HP" MediumTypes="MT-0"/></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
const xml0 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><Project Id="P-0001"><Installations><Installation Name="">
  <Topology><Area Id="P-0001-0_A-1" Address="1"><Line Id="P-0001-0_L-1" Address="1"><Segment Id="P-0001-0_S-1" Number="0" MediumTypeRefId="MT-0"/></Line></Area></Topology>
</Installation></Installations></Project></KNX>`;

const entry = (name: string, text: string) => ({ name, data: Buffer.from(text) });
// Two entries of one name, and two whose names differ in case only.
const twoOfOneName = (extra: { name: string; data: Buffer }[] = []) => zipOf([entry(`${M}/Hardware.xml`, hardware), entry(`${M}/Hardware.xml`, hardware), ...extra]);
const twoInCase = (extra: Record<string, string> = {}) => storeZip({ [`${M}/Hardware.xml`]: hardware, [`${M}/hardware.xml`]: hardware, ...extra });
// An entry that declares more than Busforge unpacks; the zip reader refuses it on the declared size.
const tooLarge = (extra: { name: string; data: Buffer }[] = []) => zipOf([entry(`${M}/Hardware.xml`, hardware), { name: `${M}/big.bin`, data: Buffer.alloc(4), size: ZIP_ENTRY_LIMIT + 1 }, ...extra]);
// A manufacturer's Hardware.xml that does not parse.
const brokenHardware = (extra: Record<string, string> = {}) => storeZip({ [`${M}/Hardware.xml`]: "<KNX><<<", ...extra });
// A central directory whose sizes are ZIP64 sentinels.
function zip64(extra: Record<string, string> = {}): Buffer {
  const b = storeZip({ [`${M}/Hardware.xml`]: hardware, ...extra });
  b.writeUInt32LE(0xffffffff, b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 20);
  return b;
}

const fresh = (): AppState => createState({ dbPath: ":memory:", dataDir: tempDir("busforge-refusal-codes-"), now: () => 1000 });
async function codeOf(path: string, bytes: Buffer, name: string): Promise<{ status: number; code: string }> {
  const f = new FormData();
  f.set("file", new File([bytes], name));
  const r = (await handleApi(new Request(`http://x${path}`, { method: "POST", body: f }), fresh()))!;
  return { status: r.status, code: ((await r.json()) as { error: { code: string } }).error.code };
}

const refusals: [string, string, Buffer, Buffer][] = [
  ["two entries of one name", "ARCHIVE_DUPLICATE_ENTRY", twoOfOneName(), twoOfOneName([entry("P-0001/0.xml", xml0)])],
  ["two entries whose names differ in case only", "ARCHIVE_DUPLICATE_ENTRY", twoInCase(), twoInCase({ "P-0001/0.xml": xml0 })],
  ["an entry over the size limit", "ARCHIVE_TOO_LARGE", tooLarge(), tooLarge([entry("P-0001/0.xml", xml0)])],
  ["a ZIP64 archive", "ZIP64_UNSUPPORTED", zip64(), zip64({ "P-0001/0.xml": xml0 })],
  ["a Hardware.xml that does not parse", "HARDWARE_XML_MALFORMED", brokenHardware(), brokenHardware({ "P-0001/0.xml": xml0 })],
];

describe("an archive Busforge refuses keeps its code", () => {
  for (const [what, code, product, project] of refusals) {
    test(`${what}: the catalogue import refuses it with ${code}`, async () => {
      expect(await codeOf("/api/catalog/import", product, "x.knxprod")).toEqual({ status: 400, code });
    });
    for (const path of ["/api/projects/analyze", "/api/projects/import"]) {
      test(`${what}: ${path} refuses it with ${code}`, async () => {
        expect(await codeOf(path, project, "x.knxproj")).toEqual({ status: 400, code });
      });
    }
  }

  test("each code is localised", () => {
    for (const code of new Set([...refusals.map(([, c]) => c), "CATALOG_ENCRYPTED"])) {
      expect(en.errors[code as keyof typeof en.errors]).toBeString();
      expect(de.errors[code as keyof typeof de.errors]).toBeString();
    }
  });
});

// Product data that describe a Hardware2Program twice say no longer which program its devices run.
describe("product data that describe a Hardware2Program twice are refused", () => {
  const hw = hardware.slice(hardware.indexOf("  <Hardware Id="), hardware.indexOf("</Hardware></Manufacturer>"));
  const doubled = hardware.replace("</Hardware></Manufacturer>", `${hw}</Hardware></Manufacturer>`);
  const twice = storeZip({ [`${M}/Hardware.xml`]: doubled, "P-0001/0.xml": xml0 });
  for (const path of ["/api/projects/analyze", "/api/projects/import"]) {
    test(`${path} refuses it with HARDWARE_PROGRAM_DUPLICATE`, async () => {
      expect(await codeOf(path, twice, "x.knxproj")).toEqual({ status: 400, code: "HARDWARE_PROGRAM_DUPLICATE" });
    });
  }
  for (const [what, bytes] of [["a product database", storeZip({ [`${M}/Hardware.xml`]: doubled })], ["a plain manufacturer XML", Buffer.from(doubled)]] as const) {
    test(`the catalogue import refuses ${what} with HARDWARE_PROGRAM_DUPLICATE`, async () => {
      expect(await codeOf("/api/catalog/import", bytes, "x.knxprod")).toEqual({ status: 400, code: "HARDWARE_PROGRAM_DUPLICATE" });
    });
  }
  test("the code is localised", () => {
    expect(en.errors.HARDWARE_PROGRAM_DUPLICATE).toBeString();
    expect(de.errors.HARDWARE_PROGRAM_DUPLICATE).toBeString();
  });
});

describe("the catalogue import's own refusals", () => {
  test("an encrypted product database is CATALOG_ENCRYPTED", async () => {
    // A WinZip-AES entry: the AES extra field (id 0x9901, 7 bytes, key strength 3) and method 99.
    const extra = Buffer.alloc(11);
    extra.writeUInt16LE(0x9901, 0);
    extra.writeUInt16LE(7, 2);
    extra[8] = 3;
    const encrypted = zipOf([{ name: `${M}/Hardware.xml`, data: Buffer.alloc(64), method: 99, extra }]);
    expect(await codeOf("/api/catalog/import", encrypted, "x.knxprod")).toEqual({ status: 400, code: "CATALOG_ENCRYPTED" });
  });

  test("a product database with each Hardware.xml once is imported", async () => {
    const f = new FormData();
    f.set("file", new File([storeZip({ [`${M}/Hardware.xml`]: hardware })], "one.knxprod"));
    const r = (await handleApi(new Request("http://x/api/catalog/import", { method: "POST", body: f }), fresh()))!;
    expect({ status: r.status, body: await r.json() }).toEqual({ status: 201, body: { products: 1, programs: 0 } });
  });

  for (const [what, bytes] of [
    ["a file that is no zip", Buffer.from("not a zip")],
    ["a file that starts like a zip and is none", Buffer.from("PKnot a zip")],
    ["a document that does not parse", Buffer.from("<KNX><<<")],
    ["a zip without manufacturer products", storeZip({ "readme.txt": "hi" })],
  ] as const) {
    test(`${what} is CATALOG_IMPORT_EMPTY`, async () => {
      expect(await codeOf("/api/catalog/import", bytes, "x.knxprod")).toEqual({ status: 400, code: "CATALOG_IMPORT_EMPTY" });
    });
  }
});
