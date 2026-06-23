import { test, expect, describe } from "bun:test";
import { extractCatalogProducts, appProgramId } from "../src/index.ts";
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
    });
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
