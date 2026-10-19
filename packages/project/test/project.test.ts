import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "../src/zip.ts";
import { parseProject } from "../src/parse.ts";
import { loadKnxproj, deriveWinzipPassword, extractAppPrograms, appProgramId, busInterfaceIndexes } from "../src/knxproj.ts";

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

  test("reads whether ETS loaded a device's application program", () => {
    expect(proj.devices.map((d) => d.applicationProgramLoaded)).toEqual([true, true]);
    // ETS leaves the attribute off a device it never downloaded.
    const xml = xml0.replace(/(Id="P-TEST-0_DI-2"[^>]*?) ApplicationProgramLoaded="true"/, "$1");
    expect(xml).not.toBe(xml0);
    expect(parseProject(xml, undefined, "fallback").devices.map((d) => d.applicationProgramLoaded)).toEqual([true, false]);
    const explicitFalse = xml0.replace(/(Id="P-TEST-0_DI-2"[^>]*?) ApplicationProgramLoaded="true"/, '$1 ApplicationProgramLoaded="false"');
    expect(parseProject(explicitFalse, undefined, "fallback").devices[1].applicationProgramLoaded).toBe(false);
  });

  test("parses group addresses with 3-level address and DPT display", () => {
    expect(proj.groupAddresses).toHaveLength(2);
    expect(proj.groupAddresses[0]).toMatchObject({ address: "0/0/1", name: "Kitchen On/Off", dpt: "1.001" });
    expect(proj.groupAddressLevels).toBe(3); // no GroupAddressStyle present -> ETS default
  });

  test("a TwoLevel GroupAddressStyle formats addresses as m/s, not a phantom middle group", () => {
    // Same 0.xml, but the project.xml declares a two-level group-address style. The raw
    // address 1 must render "0/1" (main 0, sub 1), not the three-level "0/0/1". This is the
    // core of the two-level rendering bug: the style is read from ProjectInformation, and
    // formatGa uses it, instead of hardcoding three levels.
    const projectXml = `<KNX xmlns="http://knx.org/xml/project/23"><Project Id="P"><ProjectInformation Name="X" GroupAddressStyle="TwoLevel" /></Project></KNX>`;
    const two = parseProject(xml0, projectXml, "fallback");
    expect(two.groupAddressLevels).toBe(2);
    expect(two.groupAddresses[0].address).toBe("0/1");
  });

  test("GroupAddressStyle also read from the 0.xml Installation as a fallback", () => {
    // Some exports carry the style on <Installation> in 0.xml rather than in project.xml.
    const twoLevel0 = xml0.replace('<Installation Name="Demo"', '<Installation GroupAddressStyle="TwoLevel" Name="Demo"');
    const p = parseProject(twoLevel0, undefined, "x");
    expect(p.groupAddressLevels).toBe(2);
    expect(p.groupAddresses[0].address).toBe("0/1");
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

  test("drops a device with no Id and surfaces the count instead of importing a phantom that silently loses its data", () => {
    const noId = parseProject(xml0.replace('Id="P-TEST-0_DI-1" ', ""), undefined, "fallback");
    expect(noId.malformedDevices).toBe(1);
    expect(noId.devices.map((d) => d.id)).toEqual(["P-TEST-0_DI-2"]); // the id-less device is gone, not an "" phantom
    expect(noId.devices.some((d) => d.id === "")).toBe(false);
  });

  test("drops a device with a missing address (unreachable NaN IA) and counts it", () => {
    const noAddr = parseProject(xml0.replace('Address="10" ', ""), undefined, "fallback");
    expect(noAddr.malformedDevices).toBe(1);
    expect(noAddr.devices.every((d) => !d.ia.includes("NaN"))).toBe(true);
  });

  test("a well-formed project reports zero malformed devices", () => {
    expect(proj.malformedDevices).toBe(0);
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

  test("keeps the com-object flags and priority the project sets on a device, verbatim, linked or not", () => {
    const set = xml0.replace(
      '<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-2" />',
      '<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-2" ReadFlag="Enabled" TransmitFlag="Disabled" Text="ignored" /><ComObjectInstanceRef RefId="O-2_R-2" Priority="High" UpdateFlag="Enabled" />',
    );
    const p = parseProject(set, undefined, "fallback");
    expect(p.deviceComObjOverrides).toEqual([{ deviceId: "P-TEST-0_DI-1", overrides: [
      { comObjRefId: "O-1_R-1", attrs: { ReadFlag: "Enabled", TransmitFlag: "Disabled" } },
      { comObjRefId: "O-2_R-2", attrs: { UpdateFlag: "Enabled", Priority: "High" } },
    ] }]);
    // the link of the overridden object is still imported
    expect(p.deviceLinks.find((d) => d.deviceId === "P-TEST-0_DI-1")!.links).toEqual([{ comObjRefId: "O-1_R-1", gaRaws: [1, 2] }]);
    expect(proj.deviceComObjOverrides).toEqual([]);
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

  test("a secure device ETS never commissioned (a tool key, no serial) is counted, not imported with a key it cannot use", () => {
    const secured = xml0.replace(
      'Hardware2ProgramRefId="M-0048_H-1_HP-1">',
      'Hardware2ProgramRefId="M-0048_H-1_HP-1"><Security ToolKey="AAECAwQFBgcICQoLDA0ODw==" />',
    );
    const p = parseProject(secured, undefined, "fallback");
    expect(p.deviceSecurity).toEqual([]);
    expect(p.secureDevicesWithoutSerial).toBe(1);
  });

  test("leaves deviceSecurity empty for a project with no secure devices", () => {
    expect(parseProject(xml0, undefined, "fallback").deviceSecurity).toEqual([]);
  });

  test("parses a secured group address's key apart from the address itself", () => {
    // Synthetic key, never a real project's.
    const secured = xml0.replace(
      'Address="2" Name="Living Room On/Off" DatapointType="DPST-1-1" />',
      'Address="2" Name="Living Room On/Off" DatapointType="DPST-1-1" Key="EBESExQVFhcYGRobHB0eHw==" />',
    );
    const p = parseProject(secured, undefined, "fallback");
    expect(p.groupKeys).toEqual([{ raw: 2, key: "EBESExQVFhcYGRobHB0eHw==" }]);
    // The address model never carries the key to a client.
    expect(JSON.stringify(p.groupAddresses)).not.toContain("EBESExQV");
    expect(parseProject(xml0, undefined, "fallback").groupKeys).toEqual([]);
  });

  // ETS 6.4.1 export: "Automatisch" writes no Security attribute, "Erzwungen an"
  // Security="On" beside the Key, "Erzwungen aus" Security="Off" and drops the Key.
  test("reads a group address's security mode, auto when ETS writes none", () => {
    const withMode = (mode: string) => parseProject(xml0.replace(
      'Address="2" Name="Living Room On/Off" DatapointType="DPST-1-1" />',
      `Address="2" Name="Living Room On/Off" DatapointType="DPST-1-1" Security="${mode}" />`,
    ), undefined, "fallback").groupAddresses.find((g) => g.raw === 2)!.security;
    expect(withMode("On")).toBe("on");
    expect(withMode("Off")).toBe("off");
    expect(withMode("Auto")).toBe("auto");
    expect(parseProject(xml0, undefined, "fallback").groupAddresses.map((g) => g.security)).toEqual(["auto", "auto"]);
    expect(() => withMode("Sometimes")).toThrow(/security mode "Sometimes"/);
  });
});

describe("secured senders (a bus interface assigned to a group address)", () => {
  // The shape ETS 6.4.1 writes when a tunnelling channel of an IP router is made a sender of a
  // secured address: the connector sits on the device's BusInterface, and
  // the channel's address is the device's AdditionalAddresses entry at the BusInterface's AddressIndex.
  const router = `<DeviceInstance Id="P-TEST-0_DI-7" Address="0" ProductRefId="M-0083_H-9_P-9" Hardware2ProgramRefId="M-0083_H-9_HP-9">
                  <AdditionalAddresses><Address Address="250" Name="" /><Address Address="254" Name="" /></AdditionalAddresses>
                  <BusInterfaces>
                    <BusInterface RefId="M-0083_A-9_BI-1" Password="x"><Connectors><Connector GroupAddressRefId="P-TEST-0_GA-2" /></Connectors></BusInterface>
                    <BusInterface RefId="M-0083_A-9_BI-2" Password="x" />
                  </BusInterfaces>
                </DeviceInstance>`;
  const withRouter = xml0.replace("</Segment>", `${router}</Segment>`);

  test("resolves the connector to the channel's individual address and the group address", () => {
    const p = parseProject(withRouter, undefined, "fallback", new Map(), new Map([["M-0083_A-9_BI-1", 1], ["M-0083_A-9_BI-2", 2]]));
    expect(p.secureSenders).toEqual([{ gaRaw: 2, ia: "1.1.250", deviceId: "P-TEST-0_DI-7", busInterfaceRefId: "M-0083_A-9_BI-1" }]);
    expect(p.unresolvedSenders).toBe(0);
  });

  test("a bus interface whose address index is unknown is counted, never guessed", () => {
    const p = parseProject(withRouter, undefined, "fallback");
    expect(p.secureSenders).toEqual([]);
    expect(p.unresolvedSenders).toBe(1);
  });

  test("address index 0 is the device's own address", () => {
    const p = parseProject(withRouter, undefined, "fallback", new Map(), new Map([["M-0083_A-9_BI-1", 0]]));
    expect(p.secureSenders.map((s) => s.ia)).toEqual(["1.1.0"]);
  });

  test("a project without bus interfaces has no senders", () => {
    const p = parseProject(xml0, undefined, "fallback");
    expect(p.secureSenders).toEqual([]);
    expect(p.unresolvedSenders).toBe(0);
  });

  test("the address index comes from the application's BusInterface declaration", () => {
    const app = `<BusInterfaces><BusInterface Id="M-0083_A-9_BI-1" AddressIndex="1" AccessType="Tunneling" /><BusInterface Id="M-0083_A-9_BI-2" AddressIndex="2" /></BusInterfaces>`;
    expect(busInterfaceIndexes([app])).toEqual(new Map([["M-0083_A-9_BI-1", 1], ["M-0083_A-9_BI-2", 2]]));
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
