import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "../src/zip.ts";
import { parseProject } from "../src/parse.ts";
import { loadKnxproj, deriveWinzipPassword, extractAppPrograms, appProgramId } from "../src/knxproj.ts";

const fix = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n));
const xml0 = readFileSync(join(import.meta.dir, "fixtures", "sample-0.xml"), "utf8");

describe("zip reader", () => {
  test("reads a plain outer zip", () => {
    const files = readZip(fix("sample-plain.knxproj"));
    expect([...files.keys()].some((n) => n.endsWith("P-PLAIN.zip"))).toBe(true);
  });

  test("decrypts a WinZip-AES inner archive with the derived password", () => {
    const outer = readZip(fix("sample-encrypted.knxproj"));
    const innerName = [...outer.keys()].find((n) => /P-.*\.zip$/.test(n))!;
    const inner = readZip(outer.get(innerName)!, deriveWinzipPassword("tester12"));
    expect(inner.get("0.xml")!.toString("utf8")).toContain("Switch Actuator");
  });

  test("rejects a wrong AES password", () => {
    const outer = readZip(fix("sample-encrypted.knxproj"));
    const innerName = [...outer.keys()].find((n) => /P-.*\.zip$/.test(n))!;
    expect(() => readZip(outer.get(innerName)!, deriveWinzipPassword("nope"))).toThrow();
  });
});

describe("ETS password derivation", () => {
  test("is deterministic base64 of 32 bytes (44 chars)", () => {
    expect(deriveWinzipPassword("tester12")).toHaveLength(44);
    expect(deriveWinzipPassword("a")).toBe(deriveWinzipPassword("a"));
    expect(deriveWinzipPassword("a")).not.toBe(deriveWinzipPassword("b"));
  });
});

describe("0.xml parser", () => {
  const proj = parseProject(xml0, undefined, "fallback");

  test("uses the installation name", () => expect(proj.name).toBe("Demo"));

  test("builds topology with correct individual addresses", () => {
    expect(proj.devices.map((d) => d.ia)).toEqual(["1.1.10", "1.1.11"]);
    expect(proj.devices[0].name).toBe("Switch Actuator");
    expect(proj.devices[0].manufacturer).toBe(0x48);
    expect(proj.devices[1].manufacturer).toBe(0x83);
  });

  test("parses group addresses with 3-level address and DPT display", () => {
    expect(proj.groupAddresses).toHaveLength(2);
    expect(proj.groupAddresses[0]).toMatchObject({ address: "0/0/1", name: "Kitchen On/Off", dpt: "1.001" });
  });

  test("parses the building structure (Locations) into a space tree with device refs", () => {
    expect(proj.locations).toHaveLength(1);
    const building = proj.locations[0];
    expect(building).toMatchObject({ type: "Building", name: "Haus", deviceIds: [] });
    const floor = building.children[0];
    expect(floor).toMatchObject({ type: "Floor", name: "Erdgeschoss" });
    const room = floor.children[0];
    expect(room).toMatchObject({ type: "Room", name: "Küche", deviceIds: ["P-TEST-0_DI-1"] });
    expect(room.children).toEqual([]);
  });

  test("leaves Locations empty when the export has none", () => {
    const noLoc = parseProject(xml0.replace(/<Locations>[\s\S]*<\/Locations>/, ""), undefined, "fallback");
    expect(noLoc.locations).toEqual([]);
  });

  test("builds the named group-range tree", () => {
    expect(proj.groupRanges[0].name).toBe("Licht");
    expect(proj.groupRanges[0].children[0].name).toBe("Schalten");
    expect(proj.groupRanges[0].children[0].addresses).toHaveLength(2);
  });

  test("parses com-object -> GA links, resolving GA refs to raw addresses", () => {
    const di1 = proj.deviceLinks.find((d) => d.deviceId === "P-TEST-0_DI-1")!;
    // O-1_R-1 links GA-1 (raw 1) and GA-2 (raw 2); O-2_R-2 has no Links and is omitted
    expect(di1.links).toEqual([{ comObjRefId: "O-1_R-1", gaRaws: [1, 2] }]);
    expect(proj.deviceLinks.find((d) => d.deviceId === "P-TEST-0_DI-2")!.links).toEqual([]);
    expect(proj.unresolvedLinks).toBe(0); // every link token resolved to a GA in the tree
  });

  test("counts link tokens that reference a GA not in the tree instead of dropping them silently", () => {
    const p = parseProject(xml0.replace('Links="GA-1 GA-2"', 'Links="GA-1 GA-2 GA-999"'), undefined, "fallback");
    expect(p.unresolvedLinks).toBe(1); // GA-999 has no address; surfaced, not hidden
    // the resolvable tokens still import correctly
    expect(p.deviceLinks.find((d) => d.deviceId === "P-TEST-0_DI-1")!.links).toEqual([{ comObjRefId: "O-1_R-1", gaRaws: [1, 2] }]);
  });

  test("merges duplicate com-object RefIds instead of producing colliding rows that abort the import", () => {
    const dup = xml0.replace(
      '<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-2" />',
      '<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-2" /><ComObjectInstanceRef RefId="O-1_R-1" Links="GA-2" />',
    );
    const di1 = parseProject(dup, undefined, "fallback").deviceLinks.find((d) => d.deviceId === "P-TEST-0_DI-1")!;
    // one merged entry (slots 0,1,2 stay unique, so insertProject cannot collide on its PK)
    expect(di1.links).toEqual([{ comObjRefId: "O-1_R-1", gaRaws: [1, 2, 2] }]);
  });

  test("parses a secure device's <Security> tool key, omitting non-secure devices", () => {
    // Synthetic key/serial (never a real device's), injected as a <Security> child of DI-1.
    const secured = xml0.replace(
      'Hardware2ProgramRefId="M-0048_H-1_HP-1">',
      'Hardware2ProgramRefId="M-0048_H-1_HP-1" SerialNumber="AAECAwQF"><Security ToolKey="AAECAwQFBgcICQoLDA0ODw==" SequenceNumber="123456789012" />',
    );
    const p = parseProject(secured, undefined, "fallback");
    expect(p.deviceSecurity).toEqual([
      { deviceId: "P-TEST-0_DI-1", toolKey: "AAECAwQFBgcICQoLDA0ODw==", serialNumber: "AAECAwQF", sequenceNumber: "123456789012" },
    ]);
    // 16-byte AES-128 tool key, 6-byte device serial
    expect(Buffer.from(p.deviceSecurity[0].toolKey, "base64")).toHaveLength(16);
    expect(Buffer.from(p.deviceSecurity[0].serialNumber, "base64")).toHaveLength(6);
  });

  test("leaves deviceSecurity empty for a project with no secure devices", () => {
    expect(parseProject(xml0, undefined, "fallback").deviceSecurity).toEqual([]);
  });
});

describe("loadKnxproj (integration)", () => {
  test("loads an encrypted project with the right password", () => {
    const proj = loadKnxproj(fix("sample-encrypted.knxproj"), "tester12", "uploaded");
    expect(proj.devices).toHaveLength(2);
    expect(proj.groupAddresses).toHaveLength(2);
  });

  test("loads a plain (unencrypted) project ignoring the password", () => {
    const proj = loadKnxproj(fix("sample-plain.knxproj"), undefined, "uploaded");
    expect(proj.devices).toHaveLength(2);
  });

  test("throws a coded error on a missing password", () => {
    expect(() => loadKnxproj(fix("sample-encrypted.knxproj"), undefined, "x")).toThrow(/password/i);
    try { loadKnxproj(fix("sample-encrypted.knxproj"), undefined, "x"); }
    catch (e) { expect((e as { code?: string }).code).toBe("PASSWORD_REQUIRED"); }
  });

  test("throws a coded error on a wrong password", () => {
    try { loadKnxproj(fix("sample-encrypted.knxproj"), "wrong", "x"); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("WRONG_PASSWORD"); }
  });
});

describe("extractAppPrograms (catalog ingest)", () => {
  test("maps each device app ref to its application-program XML, deduped", () => {
    const bytes = fix("sample-config.knxproj");
    const proj = loadKnxproj(bytes, "tester12", "x");
    const refs = proj.devices.map((d) => d.appRef);
    expect(refs).toEqual(["M-TEST_H-1_HP-1"]);

    const programs = extractAppPrograms(bytes, refs);
    // keyed by application-program id, not the hardware app ref
    expect([...programs.keys()]).toEqual([appProgramId("M-TEST_H-1_HP-1")]); // "M-TEST_A-1"
    expect(programs.get("M-TEST_A-1")).toContain("<ApplicationProgram");

    // repeating a ref does not duplicate the entry (reads the zip once)
    expect(extractAppPrograms(bytes, [...refs, ...refs]).size).toBe(1);
  });
});
