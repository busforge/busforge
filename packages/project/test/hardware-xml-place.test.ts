import { test, expect, describe } from "bun:test";
import { loadKnxproj, extractCatalogProducts, hardwareApplications, readAppProgram } from "../src/index.ts";
import { KnxprojError } from "../src/errors.ts";
import { storeZip } from "./ziputil.ts";

// A manufacturer's Hardware.xml is found by its place, M-XXXX/Hardware.xml, in a .knxproj and a .knxprod
// alike, never by how a name ends: a file elsewhere in the archive (a baggage, a user file) may end in
// Hardware.xml too, and its products are none of the archive's.
const M = "M-0083";
const PRODUCT = `${M}_H-1-1_P-1`;
const HP = `${M}_H-1-1_HP-AAAA-01-0000`;
const hardware = (text: string, app: string, product = PRODUCT) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><ManufacturerData><Manufacturer RefId="${M}"><Hardware>
  <Hardware Id="${M}_H-1-1" Name="Unit" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
    <Products><Product Id="${product}" Text="${text}" OrderNumber="U-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="${HP}" MediumTypes="MT-0"><ApplicationProgramRef RefId="${app}"/></Hardware2Program></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
const real = hardware("Real unit", `${M}_A-AAAA-01-0000`);
// Same ids, another text and program: whichever of the two is read decides what the device shows.
const decoy = hardware("Decoy unit", `${M}_A-DDDD-01-0000`);
const xml0 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/21"><Project Id="P-0001"><Installations><Installation Name="">
  <Topology><Area Id="P-0001-0_A-1" Address="1"><Line Id="P-0001-0_L-1" Address="1"><Segment Id="P-0001-0_S-1" Number="0" MediumTypeRefId="MT-0">
    <DeviceInstance Id="P-0001-0_DI-1" Address="1" Name="" ProductRefId="${PRODUCT}" Hardware2ProgramRefId="${HP}"/>
  </Segment></Line></Area></Topology>
</Installation></Installations></Project></KNX>`;

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(KnxprojError); return (e as KnxprojError).code; }
  expect.unreachable("expected the call to throw");
}

// Decoys before and after the real file: a reader that takes the first or the last match is caught either way.
const decoys: [string, string][] = [
  ["a baggage of the manufacturer", `${M}/Baggages/Help/Hardware.xml`],
  ["a manufacturer directory below the root", `Other/${M}/Hardware.xml`],
  ["a file at the root", "Hardware.xml"],
  ["a file whose name ends in Hardware.xml", `${M}/OldHardware.xml`],
];

describe("Hardware.xml is read only at M-XXXX/Hardware.xml", () => {
  for (const [what, name] of decoys) {
    for (const order of ["before", "after"] as const) {
      const files = order === "before" ? { [name]: decoy, [`${M}/Hardware.xml`]: real } : { [`${M}/Hardware.xml`]: real, [name]: decoy };

      test(`a .knxprod: ${what}, listed ${order} the manufacturer's, is not read`, () => {
        const bytes = storeZip(files);
        expect(extractCatalogProducts(bytes).map((p) => [p.name, p.appProgramId])).toEqual([["Real unit", `${M}_A-AAAA-01-0000`]]);
        expect(hardwareApplications(bytes)).toEqual(new Map([[HP, `${M}_A-AAAA-01-0000`]]));
      });

      test(`a .knxproj: ${what}, listed ${order} the manufacturer's, is not read`, () => {
        const bytes = storeZip({ ...files, "P-0001/0.xml": xml0 });
        const [device] = loadKnxproj(bytes, undefined, "x").devices;
        expect(device.name).toBe("Real unit");
        expect(device.appProgramId).toBe(`${M}_A-AAAA-01-0000`);
      });
    }
  }

  test("only a decoy: the archive describes no product, and the device keeps its id's program", () => {
    const bytes = storeZip({ [`${M}/Baggages/Help/Hardware.xml`]: decoy, "P-0001/0.xml": xml0 });
    expect(extractCatalogProducts(bytes)).toEqual([]);
    expect(hardwareApplications(bytes).size).toBe(0);
    expect(loadKnxproj(bytes, undefined, "x").devices[0]).toMatchObject({ name: "", appProgramId: `${M}_A-AAAA-01-0000` });
  });

  test("each manufacturer's Hardware.xml is read", () => {
    const other = hardware("Other unit", "M-0002_A-BBBB-01-0000", "M-0002_H-1-1_P-1").replaceAll(`"${M}_H-1-1"`, `"M-0002_H-1-1"`).replace(`RefId="${M}"`, `RefId="M-0002"`);
    const bytes = storeZip({ [`${M}/Hardware.xml`]: real, "M-0002/Hardware.xml": other });
    expect(extractCatalogProducts(bytes).map((p) => p.name).sort()).toEqual(["Other unit", "Real unit"]);
  });
});

describe("two Hardware.xml at one place are refused", () => {
  // Paths that differ in case only are the same file on the file system ETS writes on, refused like two
  // entries of one name.
  for (const other of [`${M}/hardware.xml`, `${M.toLowerCase()}/Hardware.xml`]) {
    const bytes = storeZip({ [`${M}/Hardware.xml`]: real, [other]: decoy, "P-0001/0.xml": xml0 });
    test(`beside ${other}, by the catalogue readers`, () => {
      expect(codeOf(() => extractCatalogProducts(bytes))).toBe("ARCHIVE_DUPLICATE_ENTRY");
      expect(codeOf(() => hardwareApplications(bytes))).toBe("ARCHIVE_DUPLICATE_ENTRY");
      expect(codeOf(() => readAppProgram(bytes, HP))).toBe("ARCHIVE_DUPLICATE_ENTRY");
    });
    test(`beside ${other}, by the project reader`, () => {
      expect(codeOf(() => loadKnxproj(bytes, undefined, "x"))).toBe("ARCHIVE_DUPLICATE_ENTRY");
    });
  }
  test("a lone Hardware.xml in another case is the manufacturer's", () => {
    for (const name of [`${M}/hardware.xml`, `${M.toLowerCase()}/HARDWARE.XML`]) {
      expect(extractCatalogProducts(storeZip({ [name]: real })).map((p) => p.name)).toEqual(["Real unit"]);
    }
  });
});
