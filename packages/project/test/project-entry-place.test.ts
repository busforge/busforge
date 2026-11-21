import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKnxproj, readXml0, readBaggage } from "../src/knxproj.ts";
import { parseProject } from "../src/parse.ts";
import { KnxprojError } from "../src/errors.ts";
import { storeZip } from "./ziputil.ts";

// A project's 0.xml and project.xml are found by their place in the archive, never by how a name ends:
// an unencrypted export keeps them in the outer archive under P-XXXX/, next to the application programs
// (M-XXXX/M-XXXX_A-….xml), whose ids may end in 0; a password-protected one keeps them at the root of the
// inner archive P-XXXX.zip, which sits at the root of the outer one.
const xml0 = readFileSync(join(import.meta.dir, "fixtures", "sample-0.xml"), "utf8");
const devices = parseProject(xml0, undefined, "x").devices.length;
const projectXml = (name: string) => `<?xml version="1.0" encoding="utf-8"?><KNX xmlns="http://knx.org/xml/project/21"><Project Id="P-0001"><ProjectInformation Name="${name}" GroupAddressStyle="ThreeLevel"/></Project></KNX>`;
const app = `<?xml version="1.0" encoding="utf-8"?><KNX xmlns="http://knx.org/xml/project/21"><ManufacturerData><Manufacturer RefId="M-0048"><ApplicationPrograms><ApplicationProgram Id="M-0048_A-140C-14-EB70" Name="Meteodata"/></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const APP = "M-0048/M-0048_A-140C-14-EB70.xml";

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(KnxprojError); return (e as KnxprojError).code; }
  expect.unreachable("expected the call to throw");
}

describe("an unencrypted export: the outer archive's P-XXXX/", () => {
  test("an application program whose id ends in 0, listed before the project, is not read as its 0.xml", () => {
    expect(devices).toBeGreaterThan(0);
    const bytes = storeZip({ [APP]: app, "P-0001/0.xml": xml0, "P-0001/project.xml": projectXml("Sweep") });
    const p = loadKnxproj(bytes, undefined, "fallback");
    expect(p.devices).toHaveLength(devices);
    expect(p.name).toBe("Sweep");
    expect(readXml0(bytes, undefined)).toBe(xml0);
  });

  test("a product file whose name ends in project.xml, listed before the project's, is not read as it", () => {
    const bytes = storeZip({ "M-0048/Baggages/Help/project.xml": projectXml("Help"), "P-0001/0.xml": xml0, "P-0001/Project.xml": projectXml("Sweep") });
    expect(loadKnxproj(bytes, undefined, "fallback").name).toBe("Sweep");
  });

  test("an archive whose only file ending in 0.xml is an application program holds no project", () => {
    expect(codeOf(() => loadKnxproj(storeZip({ [APP]: app }), undefined, "x"))).toBe("INVALID_KNXPROJ");
    expect(codeOf(() => readXml0(storeZip({ [APP]: app, "P-0001/sub/0.xml": xml0 }), undefined))).toBe("INVALID_KNXPROJ");
  });

  test("two projects are refused, not one of them picked", () => {
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001/0.xml": xml0, "P-0002/0.xml": xml0 }), undefined, "x"))).toBe("KNXPROJ_SEVERAL_PROJECTS");
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001/0.xml": xml0, "P-0001/project.xml": projectXml("a"), "P-0002/project.xml": projectXml("b") }), undefined, "x"))).toBe("KNXPROJ_SEVERAL_PROJECTS");
    // One project's devices under another project's name.
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001/0.xml": xml0, "P-0002/project.xml": projectXml("b") }), undefined, "x"))).toBe("KNXPROJ_SEVERAL_PROJECTS");
  });

  test("a product's zip named P-….zip below the root is not taken for the inner archive", () => {
    const bytes = storeZip({ "M-0048/Baggages/P-Help.zip": storeZip({ "0.xml": "<KNX/>" }), "P-0001/0.xml": xml0 });
    expect(loadKnxproj(bytes, undefined, "x").devices).toHaveLength(devices);
  });
});

describe("a project with an inner archive: P-XXXX.zip at the outer root", () => {
  test("its root 0.xml and project.xml are read, not a user file whose name ends the same", () => {
    const inner = storeZip({ "UserFiles/app-v10.xml": app, "UserFiles/project.xml": projectXml("Help"), "0.xml": xml0, "project.xml": projectXml("Sweep") });
    const bytes = storeZip({ [APP]: app, "P-0001.zip": inner });
    const p = loadKnxproj(bytes, undefined, "fallback");
    expect(p.devices).toHaveLength(devices);
    expect(p.name).toBe("Sweep");
    expect(readXml0(bytes, undefined)).toBe(xml0);
  });

  test("an inner archive without a root 0.xml holds no project", () => {
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001.zip": storeZip({ "sub/0.xml": xml0 }) }), undefined, "x"))).toBe("INVALID_KNXPROJ");
  });

  test("two inner archives, or two names of project.xml in one, are refused", () => {
    const two = storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0 }), "P-0002.zip": storeZip({ "0.xml": xml0 }) });
    expect(codeOf(() => loadKnxproj(two, undefined, "x"))).toBe("KNXPROJ_SEVERAL_PROJECTS");
    expect(codeOf(() => readBaggage(two, undefined))).toBe("KNXPROJ_SEVERAL_PROJECTS");
    // project.xml and Project.xml differ in case only: one entry twice.
    const names = storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0, "project.xml": projectXml("a"), "Project.xml": projectXml("b") }) });
    expect(codeOf(() => loadKnxproj(names, undefined, "x"))).toBe("ARCHIVE_DUPLICATE_ENTRY");
  });

  test("an inner archive beside another project's P-XXXX/0.xml, or beside its own, is refused", () => {
    const inner = storeZip({ "0.xml": xml0 });
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001.zip": inner, "P-0002/0.xml": xml0 }), undefined, "x"))).toBe("KNXPROJ_SEVERAL_PROJECTS");
    expect(codeOf(() => readXml0(storeZip({ "P-0001.zip": inner, "P-0001/0.xml": xml0 }), undefined))).toBe("KNXPROJ_SEVERAL_PROJECTS");
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001.zip": inner, "P-0001/Project.xml": projectXml("b") }), undefined, "x"))).toBe("KNXPROJ_SEVERAL_PROJECTS");
  });
});

describe("a project's baggage: BinaryData/ and UserFiles/ at the inner archive's root", () => {
  const store = Buffer.from("real-store"), other = Buffer.from("decoy-store");
  for (const order of ["before", "after"] as const) {
    test(`a folder of that name below the root, listed ${order} the project's, is not read`, () => {
      const files = order === "before" ? { "Other/BinaryData/store.bin": other, "BinaryData/store.bin": store } : { "BinaryData/store.bin": store, "Other/BinaryData/store.bin": other };
      const baggage = readBaggage(storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0, ...files }) }), undefined);
      expect([...baggage]).toEqual([["store.bin", store]]);
    });
  }

  test("one path below both folders is refused, not one of the two files kept", () => {
    expect(codeOf(() => readBaggage(storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0, "BinaryData/store.bin": store, "UserFiles/store.bin": other }) }), undefined))).toBe("ARCHIVE_DUPLICATE_ENTRY");
  });

  test("the folders in another case are the project's", () => {
    const baggage = readBaggage(storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0, "binarydata/store.bin": store, "USERFILES/app.zip": other }) }), undefined);
    expect([...baggage]).toEqual([["store.bin", store], ["app.zip", other]]);
  });
});

describe("two entries whose names differ in case only", () => {
  test("are refused wherever they sit in the archive, not only at a place Busforge reads", () => {
    expect(codeOf(() => loadKnxproj(storeZip({ "P-0001/0.xml": xml0, "README.txt": "a", "readme.TXT": "b" }), undefined, "x"))).toBe("ARCHIVE_DUPLICATE_ENTRY");
    expect(codeOf(() => readBaggage(storeZip({ "P-0001.zip": storeZip({ "0.xml": xml0, "UserFiles/a.bin": "a", "userfiles/A.BIN": "b" }) }), undefined))).toBe("ARCHIVE_DUPLICATE_ENTRY");
  });
});
