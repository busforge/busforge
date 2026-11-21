import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKnxproj, readXml0, extractAppPrograms, readAppProgram, extractCatalogProducts, extractPictureBaggage } from "../src/index.ts";
import { parseProject } from "../src/parse.ts";
import { KnxprojError } from "../src/errors.ts";
import { storeZip } from "./ziputil.ts";

// A manufacturer's application programs and its Baggages.xml are found by their place, as its Hardware.xml
// is: M-XXXX/M-XXXX_A-….xml under the program's own manufacturer, M-XXXX/Baggages.xml. Every place is
// compared in any case, the project's P-XXXX/ and the manufacturer's M-XXXX/ alike; two entries whose paths
// differ in case only are refused.
const M = "M-0083";
const APP = `${M}_A-AAAA-01-0000`;
const HP = `${M}_H-1-1_HP-AAAA-01-0000`;
const PRODUCT = `${M}_H-1-1_P-1`;
const hardware = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><ManufacturerData><Manufacturer RefId="${M}"><Hardware>
  <Hardware Id="${M}_H-1-1" Name="Unit" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
    <Products><Product Id="${PRODUCT}" Text="Unit" OrderNumber="U-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="${HP}" MediumTypes="MT-0"><ApplicationProgramRef RefId="${APP}"/></Hardware2Program></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
// The program declares a bus interface (its address index) and shows a picture: whichever program document
// is read decides the secured sender's address, the program's text and the image.
const program = (what: string, index: number, picture: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><ManufacturerData><Manufacturer RefId="${M}"><ApplicationPrograms><ApplicationProgram Id="${APP}" Name="${what}" ProgramType="ApplicationProgram"><Static>
  <ParameterTypes><ParameterType Id="${APP}_PT-A"><TypePicture RefId="${M}_BG--${picture}.2Epng"/></ParameterType></ParameterTypes>
  <BusInterfaces><BusInterface Id="${APP}_BI-1" AddressIndex="${index}" AccessType="Tunneling"/></BusInterfaces>
</Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const real = program("Real", 1, "real");
const decoy = program("Decoy", 2, "decoy");
const baggages = (...names: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><ManufacturerData><Manufacturer RefId="${M}"><Baggages>
${names.map((n) => `  <Baggage TargetPath="" Name="${n}.png" Id="${M}_BG--${n}.2Epng"><FileInfo TimeInfo="2020-01-01T00:00:00Z"/></Baggage>`).join("\n")}
</Baggages></Manufacturer></ManufacturerData></KNX>`;

// A device whose tunnelling channel sends on a secured address; its address is the AdditionalAddresses entry
// at the program's AddressIndex (1 -> 250, 2 -> 254).
const sample0 = readFileSync(join(import.meta.dir, "fixtures", "sample-0.xml"), "utf8");
const xml0 = sample0.replace("</Segment>", `<DeviceInstance Id="P-TEST-0_DI-7" Address="0" ProductRefId="${PRODUCT}" Hardware2ProgramRefId="${HP}">
  <AdditionalAddresses><Address Address="250" Name=""/><Address Address="254" Name=""/></AdditionalAddresses>
  <BusInterfaces><BusInterface RefId="${APP}_BI-1" Password="x"><Connectors><Connector GroupAddressRefId="P-TEST-0_GA-2"/></Connectors></BusInterface></BusInterfaces>
</DeviceInstance></Segment>`);
const devices = parseProject(xml0, undefined, "x").devices.length;
const senderOf = (bytes: Buffer) => loadKnxproj(bytes, undefined, "x").secureSenders.map((s) => s.ia);

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(KnxprojError); return (e as KnxprojError).code; }
  expect.unreachable("expected the call to throw");
}

const PLACE = `${M}/${APP}.xml`;
// Decoys before and after the real file: a reader that takes the first or the last match is caught either way.
const programDecoys: [string, string][] = [
  ["a file at the root", `${APP}.xml`],
  ["a manufacturer directory below another folder", `Other/${M}/${APP}.xml`],
  ["a baggage of the manufacturer", `${M}/Baggages/Help/${APP}.xml`],
  ["another manufacturer's directory", `M-0002/${APP}.xml`],
];

describe("an application program is read only at M-XXXX/M-XXXX_A-….xml", () => {
  for (const [what, name] of programDecoys) {
    for (const order of ["before", "after"] as const) {
      const files = order === "before" ? { [name]: decoy, [PLACE]: real } : { [PLACE]: real, [name]: decoy };
      const product = { [`${M}/Hardware.xml`]: hardware, [`${M}/Baggages.xml`]: baggages("real", "decoy"), [`${M}/Baggages/real.png`]: "real-image", [`${M}/Baggages/decoy.png`]: "decoy-image" };

      test(`a .knxprod: ${what}, listed ${order} the program, is not read`, () => {
        const bytes = storeZip({ ...product, ...files });
        const programs = extractAppPrograms(bytes, [APP]);
        expect(programs.get(APP)).toBe(real);
        expect(readAppProgram(bytes, HP)).toBe(real);
        expect(extractPictureBaggage(bytes, programs).get(APP)?.get(`${M}_BG--real.2Epng`)?.data.toString()).toBe("real-image");
      });

      test(`a .knxproj: ${what}, listed ${order} the program, does not declare the bus interface`, () => {
        expect(senderOf(storeZip({ ...product, ...files, "P-0001/0.xml": xml0 }))).toEqual(["1.1.250"]);
      });
    }
  }

  test("only a decoy: the archive carries no program", () => {
    for (const [, name] of programDecoys) {
      const bytes = storeZip({ [`${M}/Hardware.xml`]: hardware, [name]: decoy, "P-0001/0.xml": xml0 });
      expect(extractAppPrograms(bytes, [APP]).size).toBe(0);
      expect(readAppProgram(bytes, HP)).toBeNull();
      // The address index is the program's to declare: without it the sender is counted, not guessed.
      expect(senderOf(bytes)).toEqual([]);
      expect(loadKnxproj(bytes, undefined, "x").unresolvedSenders).toBe(1);
    }
  });

  test("a program in another case is the manufacturer's; two that differ in case only are refused", () => {
    const lower = `${M.toLowerCase()}/${APP.toLowerCase()}.xml`;
    const one = storeZip({ [`${M}/Hardware.xml`]: hardware, [lower]: real, "P-0001/0.xml": xml0 });
    expect(extractAppPrograms(one, [APP]).get(APP)).toBe(real);
    expect(readAppProgram(one, HP)).toBe(real);
    expect(senderOf(one)).toEqual(["1.1.250"]);
    const two = storeZip({ [`${M}/Hardware.xml`]: hardware, [PLACE]: real, [lower]: decoy, "P-0001/0.xml": xml0 });
    expect(codeOf(() => extractAppPrograms(two, [APP]))).toBe("ARCHIVE_DUPLICATE_ENTRY");
    expect(codeOf(() => readAppProgram(two, HP))).toBe("ARCHIVE_DUPLICATE_ENTRY");
    expect(codeOf(() => loadKnxproj(two, undefined, "x"))).toBe("ARCHIVE_DUPLICATE_ENTRY");
  });
});

describe("Baggages.xml is read only at M-XXXX/Baggages.xml", () => {
  const programs = new Map([[APP, real]]);
  const images = { [`${M}/Baggages/real.png`]: "real-image", [`${M}/Baggages/decoy.png`]: "decoy-image" };
  // The decoy names the real picture's id after the decoy file.
  const decoyBaggages = baggages("decoy").replaceAll(`${M}_BG--decoy.2Epng`, `${M}_BG--real.2Epng`);
  const picture = (bytes: Buffer) => extractPictureBaggage(bytes, programs).get(APP)?.get(`${M}_BG--real.2Epng`);
  for (const name of [`Other/${M}/Baggages.xml`, `${M}/Baggages/${M}/Baggages.xml`, "Baggages.xml"]) {
    for (const order of ["before", "after"] as const) {
      test(`${name}, listed ${order} the manufacturer's, is not read`, () => {
        const files = order === "before" ? { [name]: decoyBaggages, [`${M}/Baggages.xml`]: baggages("real") } : { [`${M}/Baggages.xml`]: baggages("real"), [name]: decoyBaggages };
        expect(picture(storeZip({ ...images, ...files }))).toEqual({ name: "real.png", data: Buffer.from("real-image") });
      });
    }
    test(`${name} alone gives no image, its own Baggages/ beside it neither`, () => {
      const own = `${name.slice(0, -"Baggages.xml".length)}Baggages/decoy.png`;
      expect(picture(storeZip({ ...images, [own]: "decoy-image", [name]: decoyBaggages }))).toBeUndefined();
    });
  }

  test("a Baggages.xml and its image in another case are the manufacturer's; two that differ in case only are refused", () => {
    const one = storeZip({ [`${M.toLowerCase()}/BAGGAGES.XML`]: baggages("real"), [`${M}/baggages/REAL.png`]: "real-image" });
    expect(picture(one)).toEqual({ name: "REAL.png", data: Buffer.from("real-image") });
    const two = storeZip({ ...images, [`${M}/Baggages.xml`]: baggages("real"), [`${M}/baggages.xml`]: decoyBaggages });
    expect(codeOf(() => extractPictureBaggage(two, programs))).toBe("ARCHIVE_DUPLICATE_ENTRY");
  });
});

describe("the project's P-XXXX/ in any case", () => {
  test("a lone P-XXXX directory, 0.xml or inner archive in another case is the project's", () => {
    for (const name of ["p-0001/0.xml", "P-0001/0.XML"]) {
      const bytes = storeZip({ [name]: xml0 });
      expect(loadKnxproj(bytes, undefined, "x").devices).toHaveLength(devices);
      expect(readXml0(bytes, undefined)).toBe(xml0);
    }
    expect(loadKnxproj(storeZip({ "p-0001.ZIP": storeZip({ "0.XML": xml0 }) }), undefined, "x").devices).toHaveLength(devices);
  });

  test("two paths of the project that differ in case only are refused", () => {
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001/0.xml": xml0, "p-0001/0.xml": xml0 }), undefined, "x"))).toBe("ARCHIVE_DUPLICATE_ENTRY");
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0, "0.XML": xml0 }) }), undefined, "x"))).toBe("ARCHIVE_DUPLICATE_ENTRY");
    // An inner archive and the outer P-XXXX/0.xml of one id in two cases are the project twice.
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0 }), "p-0001/0.xml": xml0 }), undefined, "x"))).toBe("KNXPROJ_SEVERAL_PROJECTS");
  });
});

describe("a backslash is no directory separator", () => {
  // The ZIP format writes "/"; an entry named with "\" sits at the root, not in a manufacturer directory.
  test("M-XXXX\\Hardware.xml, M-XXXX\\<program>.xml and M-XXXX\\Baggages.xml are not taken", () => {
    const bytes = storeZip({ [`${M}\\Hardware.xml`]: hardware, [`${M}\\${APP}.xml`]: real, [`${M}\\Baggages.xml`]: baggages("real"), [`${M}/Baggages/real.png`]: "real-image" });
    expect(extractCatalogProducts(bytes)).toEqual([]);
    expect(extractAppPrograms(bytes, [APP]).size).toBe(0);
    expect(extractPictureBaggage(bytes, new Map([[APP, real]])).size).toBe(0);
  });
});
