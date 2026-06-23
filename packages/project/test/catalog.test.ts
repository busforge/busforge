import { test, expect, describe } from "bun:test";
import { extractCatalogProducts, appProgramId } from "../src/index.ts";

// Build a minimal STORE (uncompressed) zip in memory. readZip does not verify
// CRCs, so a zero CRC is fine; this lets the test feed a synthetic .knxproj-shaped
// archive (the real fixtures omit the plaintext Hardware.xml we parse here).
function storeZip(files: Record<string, string>): Buffer {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = Buffer.from(enc.encode(name));
    const data = Buffer.from(enc.encode(content));
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 8); // method = STORE
    lfh.writeUInt32LE(0, 14); // crc32 (unchecked)
    lfh.writeUInt32LE(data.length, 18); // comp size
    lfh.writeUInt32LE(data.length, 22); // uncomp size
    lfh.writeUInt16LE(nameB.length, 26);
    const local = Buffer.concat([lfh, nameB, data]);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt32LE(0, 16); // crc32
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameB.length, 28);
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameB]));

    locals.push(local);
    offset += local.length;
  }
  const cdBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

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
