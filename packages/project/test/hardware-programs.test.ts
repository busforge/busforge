import { test, expect, describe } from "bun:test";
import { extractCatalogProducts, extractAppPrograms, hardwareApplications, readAppProgram, appProgramId } from "../src/index.ts";
import { parseProject } from "../src/parse.ts";
import { storeZip } from "./ziputil.ts";

// Two-application hardware: a Hardware2Program naming an application and a PEI program. Its id carries
// both programs' parts, so it names neither; the application is the ApplicationProgramRef whose program
// declares ProgramType="ApplicationProgram". No product of the private corpus has one: synthetic data,
// in the id form two-program hardware takes.
const H2P = "M-0083_H-2P-1_HP-AAAA-01-0000-BBBB-01-0000";
const APP = "M-0083_A-AAAA-01-0000";
const PEI = "M-0083_A-BBBB-01-0000";

const hardware = (refs: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083"><Hardware>
  <Hardware Id="M-0083_H-2P-1" Name="Two programs" VersionNumber="1" HasIndividualAddress="true" HasApplicationProgram="true">
    <Products><Product Id="M-0083_H-2P-1_P-1" Text="Two-application unit" OrderNumber="TWO-1"/></Products>
    <Hardware2Programs><Hardware2Program Id="${H2P}" MediumTypes="MT-0">${refs.map((r) => `<ApplicationProgramRef RefId="${r}"/>`).join("")}</Hardware2Program></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
const program = (id: string, type: string | undefined) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083"><ApplicationPrograms>
  <ApplicationProgram Id="${id}"${type ? ` ProgramType="${type}"` : ""} ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" Name="${id}"><Static/></ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const archive = (refs: string[], programs: Record<string, string | undefined>) =>
  storeZip({ "M-0083/Hardware.xml": hardware(refs), ...Object.fromEntries(Object.entries(programs).map(([id, type]) => [`M-0083/${id}.xml`, program(id, type)])) });

describe("the application of two-application hardware comes from its ApplicationProgramRefs", () => {
  test("the id's own form names no program", () => {
    expect(appProgramId(H2P)).toBe("M-0083_A-AAAA-01-0000-BBBB-01-0000");
  });

  // The PEI program listed first: the order of the refs decides nothing.
  for (const refs of [[APP, PEI], [PEI, APP]]) {
    test(`resolves to the ApplicationProgram, refs ${refs.map((r) => r.slice(-14)).join(", ")}`, () => {
      const bytes = archive(refs, { [APP]: "ApplicationProgram", [PEI]: "PeiProgram" });
      expect(hardwareApplications(bytes)).toEqual(new Map([[H2P, APP]]));
      expect(extractCatalogProducts(bytes)).toEqual([{
        appRef: H2P, productRef: "M-0083_H-2P-1_P-1", appProgramId: APP, hasApplication: true, peiProgram: true,
        manufacturer: 0x83, name: "Two-application unit", orderNumber: "TWO-1", hwVersion: "1",
      }]);
      expect(readAppProgram(bytes, H2P)).toBe(program(APP, "ApplicationProgram"));
      expect([...extractAppPrograms(bytes, [APP]).keys()]).toEqual([APP]);
    });
  }

  // Where the programs do not say which is the application, none is taken: the device then lists as
  // without its program (APP_PROGRAM_MISSING), never with the PEI program or a guessed one.
  const unresolved: [string, Record<string, string | undefined>][] = [
    ["the PEI program is not in the archive", { [APP]: "ApplicationProgram" }],
    ["the application is not in the archive", { [PEI]: "PeiProgram" }],
    ["both declare the application", { [APP]: "ApplicationProgram", [PEI]: "ApplicationProgram" }],
    ["both declare a PEI program", { [APP]: "PeiProgram", [PEI]: "PeiProgram" }],
    ["one declares no program type", { [APP]: undefined, [PEI]: "PeiProgram" }],
  ];
  for (const [name, programs] of unresolved) {
    test(`resolves to none where ${name}`, () => {
      const bytes = archive([APP, PEI], programs);
      expect(hardwareApplications(bytes).get(H2P)).toBe("");
      expect(extractCatalogProducts(bytes)[0]).toMatchObject({ appProgramId: "", hasApplication: true, peiProgram: true });
      expect(readAppProgram(bytes, H2P)).toBeNull();
    });
  }

  test("one-program hardware takes its one ApplicationProgramRef, whatever the program says or whether it is there", () => {
    const one = "M-0083_H-2P-1_HP-AAAA-01-0000";
    const bytes = storeZip({ "M-0083/Hardware.xml": hardware([APP]).replace(H2P, one) });
    expect(hardwareApplications(bytes)).toEqual(new Map([[one, APP]]));
    expect(extractCatalogProducts(bytes)[0]).toMatchObject({ appProgramId: APP, peiProgram: false });
  });

  test("a Hardware2Program no Hardware.xml describes reads the program its id names", () => {
    const bytes = storeZip({ "M-0083/M-0083_A-CCCC-01-0000.xml": program("M-0083_A-CCCC-01-0000", "ApplicationProgram") });
    expect(hardwareApplications(bytes).size).toBe(0);
    expect(readAppProgram(bytes, "M-0083_H-9-1_HP-CCCC-01-0000")).toContain('Id="M-0083_A-CCCC-01-0000"');
  });
});

// The same Hardware2Program described twice, naming another program the second time: which one its devices
// run the product data do not say. No archive of the private corpus has one (tools/hardware-applications.test.ts
// loads every project of it).
describe("a Hardware2Program described twice is refused", () => {
  const OTHER = "M-0083_A-CCCC-01-0000";
  const twice = (where: "one Hardware.xml" | "two Hardware.xml") => {
    const first = hardware([APP]), second = hardware([OTHER]);
    if (where === "two Hardware.xml") return storeZip({ "M-0083/Hardware.xml": first, "M-0001/Hardware.xml": second.replace('RefId="M-0083"', 'RefId="M-0001"') });
    const hw = second.slice(second.indexOf("  <Hardware Id="), second.indexOf("</Hardware></Manufacturer>"));
    return storeZip({ "M-0083/Hardware.xml": first.replace("</Hardware></Manufacturer>", `${hw}</Hardware></Manufacturer>`) });
  };
  const refused = expect.objectContaining({ code: "HARDWARE_PROGRAM_DUPLICATE" });
  for (const where of ["one Hardware.xml", "two Hardware.xml"] as const) {
    test(`in ${where}: the application of its devices, their program and the catalogue's products are not read`, () => {
      const bytes = twice(where);
      expect(() => hardwareApplications(bytes)).toThrow(refused);
      expect(() => readAppProgram(bytes, H2P)).toThrow(refused);
      expect(() => extractCatalogProducts(bytes)).toThrow(refused);
    });
  }
});

describe("a project device takes the application resolved for its Hardware2Program", () => {
  const xml0 = (refId: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><Project Id="P-0001"><Installations><Installation Name=""><Topology><Area Address="1"><Line Address="1">
  <DeviceInstance Id="P-0001-0_DI-1" Address="5" ProductRefId="M-0083_H-2P-1_P-1" Hardware2ProgramRefId="${H2P}">
    <ComObjectInstanceRefs><ComObjectInstanceRef RefId="${refId}" ReadFlag="Enabled"/></ComObjectInstanceRefs>
  </DeviceInstance>
</Line></Area></Topology></Installation></Installations></Project></KNX>`;

  test("its program id, and the com-object keys stripped against it, as ETS 4 prefixes them", () => {
    const p = parseProject(xml0(`${APP}_O-3_R-3`), undefined, "x", new Map(), new Map(), new Map(), new Map([[H2P, APP]]));
    expect(p.devices[0]).toMatchObject({ appRef: H2P, appProgramId: APP });
    expect(p.deviceComObjOverrides[0].overrides[0].comObjRefId).toBe("O-3_R-3");
  });

  test("none where its hardware's programs do not say which is the application", () => {
    const p = parseProject(xml0(`${APP}_O-3_R-3`), undefined, "x", new Map(), new Map(), new Map(), new Map([[H2P, ""]]));
    expect(p.devices[0].appProgramId).toBe("");
    expect(p.deviceComObjOverrides[0].overrides[0].comObjRefId).toBe(`${APP}_O-3_R-3`);
  });
});
