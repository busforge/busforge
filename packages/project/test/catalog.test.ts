import { test, expect, describe } from "bun:test";
import { extractCatalogProducts, extractAppPrograms, appProgramId, appProgramName, appProgramMask } from "../src/index.ts";
import { storeZip } from "./ziputil.ts";

const hardwareXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20">
  <ManufacturerData>
    <Manufacturer RefId="M-0083">
      <Hardware>
        <Hardware Id="M-0083_H-SW4-1" Name="Switch 4-fold" VersionNumber="12">
          <Products>
            <Product Id="M-0083_H-SW4-1_P-prod" Text="Super Switch 4f" OrderNumber="SW-4F-001"/>
          </Products>
          <Hardware2Programs>
            <Hardware2Program Id="M-0083_H-SW4-1_HP-AAAA-1-0001">
              <ApplicationProgramRef RefId="M-0083_A-AAAA-1-0001"/>
            </Hardware2Program>
          </Hardware2Programs>
        </Hardware>
      </Hardware>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;

describe("extractCatalogProducts (catalog metadata ingest)", () => {
  test("pulls product name, order number and hardware version from Hardware.xml", () => {
    const zip = storeZip({ "M-0083/Hardware.xml": hardwareXml, "P-X.zip": "ignored" });
    const products = extractCatalogProducts(zip);
    expect(products).toHaveLength(1);
    expect(products[0]).toEqual({
      appRef: "M-0083_H-SW4-1_HP-AAAA-1-0001",
      productRef: "M-0083_H-SW4-1_P-prod",
      appProgramId: appProgramId("M-0083_H-SW4-1_HP-AAAA-1-0001"), // M-0083_A-AAAA-1-0001
      manufacturer: 0x83,
      name: "Super Switch 4f",
      orderNumber: "SW-4F-001",
      hwVersion: "12",
      hasApplication: true,
    });
  });

  test("a Hardware2Program without an ApplicationProgramRef is a product without an application program", () => {
    // The Hager TH001 as ETS converts it from Hager's ETS2 database: the hardware claims
    // HasApplicationProgram="true", the Hardware2Program names no program (private corpus
    // internal/captures/hager-th001/TH001-Capture.knxproj).
    const th001 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23">
  <ManufacturerData>
    <Manufacturer RefId="M-0009">
      <Hardware>
        <Hardware Id="M-0009_H-9.20.2F.2F.20TH001-1" Name="TH001 RS 232 modulaire" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
          <Products>
            <Product Id="M-0009_H-9.20.2F.2F.20TH001-1_P-TH001" Text="Modular RS 232" OrderNumber="TH001"/>
          </Products>
          <Hardware2Programs>
            <Hardware2Program Id="M-0009_H-9.20.2F.2F.20TH001-1_HP" MediumTypes="MT-0">
              <RegistrationInfo RegistrationStatus="Registered"/>
            </Hardware2Program>
          </Hardware2Programs>
        </Hardware>
      </Hardware>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;
    expect(extractCatalogProducts(storeZip({ "M-0009/Hardware.xml": th001 }))).toEqual([{
      appRef: "M-0009_H-9.20.2F.2F.20TH001-1_HP",
      productRef: "M-0009_H-9.20.2F.2F.20TH001-1_P-TH001",
      appProgramId: "",
      manufacturer: 9,
      name: "Modular RS 232",
      orderNumber: "TH001",
      hwVersion: "1",
      hasApplication: false,
    }]);
  });

  test("no Hardware.xml yields no catalog products", () => {
    expect(extractCatalogProducts(storeZip({ "M-X/M-X_A-1.xml": "<x/>" }))).toEqual([]);
  });

  test("pairs each product with each application program of the same hardware", () => {
    const twoPrograms = hardwareXml.replace(
      "</Hardware2Programs>",
      `  <Hardware2Program Id="M-0083_H-SW4-1_HP-BBBB-1-0002"><ApplicationProgramRef RefId="M-0083_A-BBBB-1-0002"/></Hardware2Program>
          </Hardware2Programs>`,
    );
    const products = extractCatalogProducts(storeZip({ "M-0083/Hardware.xml": twoPrograms }));
    expect(products).toHaveLength(2);
    expect(products.map((p) => p.appRef)).toEqual([
      "M-0083_H-SW4-1_HP-AAAA-1-0001",
      "M-0083_H-SW4-1_HP-BBBB-1-0002",
    ]);
  });
});

// A plain manufacturer XML: one document carrying Hardware AND the application program inline,
// with no zip around it. This is how OpenKNX ships, and it is not a corner case: they are not a
// KNX Association member, so they may not publish a signed .knxprod at all. Reading this shape
// directly is what lets an OpenKNX device be commissioned with no ETS anywhere in the chain.
const plainProductDb = (programs: string[]) => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20" CreatedBy="OpenKNXproducer">
  <ManufacturerData>
    <Manufacturer RefId="M-00FA">
      <Hardware>
        <Hardware Id="M-00FA_H-0xA012-1" Name="RaumController" VersionNumber="1">
          <Products>
            <Product Id="M-00FA_H-0xA012-1_P-OpenKnxRaumController" Text="OpenKNX: RaumController" OrderNumber="OpenKnxRaumController"/>
          </Products>
          <Hardware2Programs>
            <Hardware2Program Id="M-00FA_H-0xA012-1_HP-A012-55-0000">
              <ApplicationProgramRef RefId="M-00FA_A-A012-55-0000"/>
            </Hardware2Program>
          </Hardware2Programs>
        </Hardware>
      </Hardware>
      <ApplicationPrograms>
        ${programs.map((id) => `<ApplicationProgram Id="${id}" MaskVersion="MV-07B0" ApplicationNumber="40978" ApplicationVersion="85"><Static/></ApplicationProgram>`).join("\n        ")}
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`, "utf8");

describe("a plain manufacturer XML (no zip): the OpenKNX shape", () => {
  test("the product is extracted from the inline Hardware section", () => {
    const products = extractCatalogProducts(plainProductDb(["M-00FA_A-A012-55-0000"]));
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("OpenKNX: RaumController");
    expect(products[0].appProgramId).toBe("M-00FA_A-A012-55-0000");
    expect(products[0].manufacturer).toBe(0xfa);
  });

  test("the application program is the document itself, so the product is placeable", () => {
    const bytes = plainProductDb(["M-00FA_A-A012-55-0000"]);
    const products = extractCatalogProducts(bytes);
    const programs = extractAppPrograms(bytes, products.map((p) => p.appRef));
    expect([...programs.keys()]).toEqual(["M-00FA_A-A012-55-0000"]);
    expect(programs.get("M-00FA_A-A012-55-0000")).toContain("<ApplicationProgram");
  });

  test("a document with SEVERAL application programs is refused, not mis-placed", () => {
    // The parser takes the first ApplicationProgram it finds, so handing the whole document to
    // every product would silently give them all the same (wrong) application.
    const bytes = plainProductDb(["M-00FA_A-A012-55-0000", "M-00FA_A-B013-01-0000"]);
    const products = extractCatalogProducts(bytes);
    expect(() => extractAppPrograms(bytes, products.map((p) => p.appRef))).toThrow(/several|application programs/i);
  });
});

describe("appProgramName", () => {
  const doc = (program: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083"><ApplicationPrograms>${program}</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  test("is the program's own Name, entities decoded", () => {
    expect(appProgramName(doc(`<ApplicationProgram Id="M-0083_A-AAAA-1-0001" Name="Switch &amp; dim 4-fold" MaskVersion="MV-07B0"><Static/></ApplicationProgram>`), "M-0083_A-AAAA-1-0001")).toBe("Switch & dim 4-fold");
  });
  test("is empty where the document names no such program, or the program no name", () => {
    expect(appProgramName(doc(`<ApplicationProgram Id="M-0083_A-AAAA-1-0001" Name="Switch"/>`), "M-0083_A-BBBB-1-0001")).toBe("");
    expect(appProgramName(doc(`<ApplicationProgram Id="M-0083_A-AAAA-1-0001"/>`), "M-0083_A-AAAA-1-0001")).toBe("");
    expect(appProgramName("<ApplicationProgram/>", "M-0083_A-AAAA-1-0001")).toBe("");
  });
});

describe("appProgramMask", () => {
  test("reads the program's MaskVersion without parsing its content", () => {
    // Content Busforge's configuration parser refuses (an unknown byte order) does not matter here.
    const xml = `<KNX><ManufacturerData><Manufacturer RefId="M-X"><ApplicationPrograms>
      <ApplicationProgram Id="M-X_A-1" MaskVersion="MV-0012"><Static><Parameters><Parameter Id="p" ByteOrder="Weird"/></Parameters></Static></ApplicationProgram>
    </ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
    expect(appProgramMask(xml, "M-X_A-1")).toBe("MV-0012");
    expect(appProgramMask(xml, "M-X_A-2")).toBe("");
  });
});
