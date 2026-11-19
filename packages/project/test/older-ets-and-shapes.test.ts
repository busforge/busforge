import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKnxproj, readXml0 } from "../src/knxproj.ts";
import { parseProject } from "../src/parse.ts";
import { readZip, zipEncryption } from "../src/zip.ts";
import { KnxprojError } from "../src/errors.ts";
import { storeZip } from "./ziputil.ts";

// Both fixtures are one synthetic ETS 4-shaped project (schema 11: Project.xml, <Connectors>,
// <Buildings>, "0"/"1" load flags), its 0.xml and Project.xml encrypted with traditional PKWARE
// encryption under the password "secret12" by an independent zip writer:
// - zipcrypto-crc-check.zip by 7-Zip (`7z a -tzip -psecret12 -mem=ZipCrypto -mm=Deflate`): no data
//   descriptor, so the header's check byte is the CRC's high byte, as in the inner archive of an
//   ETS 4 or 5 project;
// - zipcrypto-data-descriptor.zip by Info-ZIP (`zip -P secret12`): sizes and CRC in a data
//   descriptor (bit 3), so the check byte is the modification time's high byte.
const fixture = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n));
const knxproj = (inner: Buffer) => storeZip({ "P-0001.zip": inner });

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(KnxprojError); return (e as KnxprojError).code; }
  expect.unreachable("expected the call to throw");
}

describe("ETS 4/5 password projects (ZipCrypto)", () => {
  for (const name of ["zipcrypto-crc-check.zip", "zipcrypto-data-descriptor.zip"]) {
    test(`${name}: opens with the project password and imports the ETS 4 shapes`, () => {
      expect(zipEncryption(fixture(name))).toBe("zipcrypto");
      const p = loadKnxproj(knxproj(fixture(name)), "secret12", "fallback");
      // Project.xml (capital P) is read: name and the two-level style come from it.
      expect(p.name).toBe("Synthetic ETS4 project");
      expect(p.groupAddressLevels).toBe(2);
      expect(p.devices.map((d) => d.ia)).toEqual(["1.1.5"]);
      // <Send> first, then <Receive>; the key without the application program's prefix.
      expect(p.deviceLinks[0].links).toEqual([{ comObjRefId: "O-0_R-1", gaRaws: [2, 1] }]);
      expect(p.devices[0].etsLoaded).toEqual({ individualAddress: true, mediumConfig: true, application: true, parameters: true, communication: false });
      expect(p.locations).toHaveLength(1);
      expect(p.locations[0]).toMatchObject({ type: "Building", name: "House", deviceIds: [] });
      expect(p.locations[0].children[0]).toMatchObject({ type: "Room", name: "Kitchen", deviceIds: ["P-0001-0_DI-1"] });
    });
  }

  test("readXml0 decrypts the same 0.xml loadKnxproj reads", () => {
    const xml = readXml0(knxproj(fixture("zipcrypto-crc-check.zip")), "secret12");
    expect(xml).toContain(`<DeviceInstance Id="P-0001-0_DI-1"`);
  });

  test("a failing password with characters outside ASCII is refused as unproven, not as wrong", () => {
    for (const name of ["zipcrypto-crc-check.zip", "zipcrypto-data-descriptor.zip"]) {
      expect(codeOf(() => readZip(fixture(name), "secret12ä"))).toBe("ZIPCRYPTO_PASSWORD_ENCODING");
    }
  });

  test("without a password it asks for one", () => {
    expect(codeOf(() => loadKnxproj(knxproj(fixture("zipcrypto-crc-check.zip")), undefined, "x"))).toBe("PASSWORD_REQUIRED");
  });

  test("a wrong password is refused, never inflated into a zlib error", () => {
    for (const name of ["zipcrypto-crc-check.zip", "zipcrypto-data-descriptor.zip"]) {
      for (const pw of ["secret13", "wrong", "Secret12", "x"]) {
        const code = codeOf(() => readZip(fixture(name), pw)) ?? "";
        expect(["WRONG_PASSWORD", "DECRYPT_FAILED"]).toContain(code);
      }
    }
  });

  test("a wrong password that passes the one-byte check is still refused", () => {
    // The header check is one byte, so about one password in 256 passes it. Find such a password
    // for this fixture and show that inflating or the CRC catches it.
    const buf = fixture("zipcrypto-crc-check.zip");
    let passing: string | undefined;
    for (let i = 0; i < 5000 && !passing; i++) {
      if (codeOf(() => readZip(buf, `pw${i}`)) === "DECRYPT_FAILED") passing = `pw${i}`;
    }
    expect(passing).toBeDefined();
  });

  test("an entry that inflates but fails its CRC is refused", () => {
    // Flip the CRC's low bit in the central directory: the header check byte (the CRC's high byte)
    // still passes with the right password and the entry inflates, so only the CRC catches it.
    const zip = Buffer.from(fixture("zipcrypto-crc-check.zip"));
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE((zip.readUInt32LE(cd + 16) ^ 1) >>> 0, cd + 16);
    expect(codeOf(() => readZip(zip, "secret12"))).toBe("DECRYPT_FAILED");
  });

  test("PKWARE strong encryption is refused with its own code", () => {
    const zip = Buffer.from(fixture("zipcrypto-crc-check.zip"));
    // Set bit 6 in every central-directory entry's flags.
    for (let off = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); off >= 0; off = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), off + 4)) {
      zip.writeUInt16LE(zip.readUInt16LE(off + 8) | 0x40, off + 8);
    }
    expect(codeOf(() => readZip(zip, "secret12"))).toBe("ZIP_ENCRYPTION_UNSUPPORTED");
  });
});

const doc = (installations: string) => `<?xml version="1.0"?>
<KNX><Project Id="P-0001"><Installations>${installations}</Installations></Project></KNX>`;
const device = (id: string, addr: number, refs: string, extra = "") =>
  `<DeviceInstance Id="${id}" Address="${addr}" ProductRefId="M-00FA_H-1_P-1" Hardware2ProgramRefId="M-00FA_H-1_HP-0001-01-0000"${extra}>${refs}</DeviceInstance>`;
const gas = (prefix: string, ...addrs: number[]) =>
  `<GroupAddresses><GroupRanges><GroupRange Name="R" RangeStart="1" RangeEnd="2047">${addrs.map((a, i) => `<GroupAddress Id="${prefix}_GA-${i + 1}" Address="${a}" Name="GA ${a}"/>`).join("")}</GroupRange></GroupRanges></GroupAddresses>`;

describe("ETS 4/5 <Connectors> links", () => {
  const connectors = (body: string) => `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="M-00FA_A-0001-01-0000_O-3_R-3"><Connectors>${body}</Connectors></ComObjectInstanceRef></ComObjectInstanceRefs>`;
  const project = (body: string) => parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, connectors(body))}</Line></Area></Topology>${gas("P-0001-0", 10, 20, 30)}</Installation>`), undefined, "x");

  test("the <Send> address comes first, the <Receive> addresses after it in document order", () => {
    const p = project(`<Send GroupAddressRefId="P-0001-0_GA-3"/><Receive GroupAddressRefId="P-0001-0_GA-1"/><Receive GroupAddressRefId="P-0001-0_GA-2"/>`);
    expect(p.deviceLinks[0].links).toEqual([{ comObjRefId: "O-3_R-3", gaRaws: [30, 10, 20] }]);
    expect(p.linksWithoutSender).toBe(0);
  });

  test("connectors without a single <Send> are counted, not imported in a guessed order", () => {
    const receiveOnly = project(`<Receive GroupAddressRefId="P-0001-0_GA-1"/><Receive GroupAddressRefId="P-0001-0_GA-2"/>`);
    expect(receiveOnly.deviceLinks[0].links).toEqual([]);
    expect(receiveOnly.linksWithoutSender).toBe(2);
    const twoSends = project(`<Send GroupAddressRefId="P-0001-0_GA-1"/><Send GroupAddressRefId="P-0001-0_GA-2"/>`);
    expect(twoSends.deviceLinks[0].links).toEqual([]);
    expect(twoSends.linksWithoutSender).toBe(2);
    expect(receiveOnly.droppedLinks).toEqual([{ deviceId: "P-0001-0_DI-1", comObjRefId: "O-3_R-3", reason: "noSingleSender", gas: [{ etsId: "GA-1", raw: 10 }, { etsId: "GA-2", raw: 20 }] }]);
    expect(twoSends.droppedLinks.map((l) => l.reason)).toEqual(["noSingleSender"]);
  });

  test("an assignment whose sending address is not in the project is not imported at all", () => {
    const p = project(`<Send GroupAddressRefId="P-0001-0_GA-9"/><Receive GroupAddressRefId="P-0001-0_GA-1"/>`);
    expect(p.deviceLinks[0].links).toEqual([]);
    expect(p.unresolvedLinks).toBe(1);
    expect(p.linksWithoutSender).toBe(1);
    const links = parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="O-3_R-3" Links="GA-9 GA-1 GA-2"/></ComObjectInstanceRefs>`)}</Line></Area></Topology>${gas("P-0001-0", 10, 20)}</Installation>`), undefined, "x");
    expect(links.deviceLinks[0].links).toEqual([]);
    expect(links.unresolvedLinks).toBe(1);
    expect(links.linksWithoutSender).toBe(2);
    expect(p.droppedLinks).toEqual([{ deviceId: "P-0001-0_DI-1", comObjRefId: "O-3_R-3", reason: "senderNotInProject", gas: [{ etsId: "GA-9" }, { etsId: "GA-1", raw: 10 }] }]);
    expect(links.droppedLinks).toEqual([{ deviceId: "P-0001-0_DI-1", comObjRefId: "O-3_R-3", reason: "senderNotInProject", gas: [{ etsId: "GA-9" }, { etsId: "GA-1", raw: 10 }, { etsId: "GA-2", raw: 20 }] }]);
  });

  test("a receiving connector to an address not in the project is counted as unresolved", () => {
    const p = project(`<Send GroupAddressRefId="P-0001-0_GA-1"/><Receive GroupAddressRefId="P-0001-0_GA-9"/>`);
    expect(p.deviceLinks[0].links).toEqual([{ comObjRefId: "O-3_R-3", gaRaws: [10] }]);
    expect(p.unresolvedLinks).toBe(1);
    expect(p.droppedLinks).toEqual([{ deviceId: "P-0001-0_DI-1", comObjRefId: "O-3_R-3", reason: "addressNotInProject", gas: [{ etsId: "GA-1", raw: 10 }, { etsId: "GA-9" }] }]);
  });

  test("the entry of a com-object two refs share carries the ETS addresses of both, the counts stay per ref", () => {
    const refs = `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="O-3_R-3" Links="GA-1 GA-9"/><ComObjectInstanceRef RefId="O-3_R-3" Links="GA-2 GA-1"/></ComObjectInstanceRefs>`;
    const p = parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, refs)}</Line></Area></Topology>${gas("P-0001-0", 10, 20)}</Installation>`), undefined, "x");
    expect(p.unresolvedLinks).toBe(1);
    expect(p.droppedLinks).toEqual([{ deviceId: "P-0001-0_DI-1", comObjRefId: "O-3_R-3", reason: "addressNotInProject", gas: [{ etsId: "GA-1", raw: 10 }, { etsId: "GA-9" }, { etsId: "GA-2", raw: 20 }] }]);
  });

  test("two refs on one com-object merge their links in ETS order without a duplicate", () => {
    const p = (refs: string) => parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, `<ComObjectInstanceRefs>${refs}</ComObjectInstanceRefs>`)}</Line></Area></Topology>${gas("P-0001-0", 10, 20, 30)}</Installation>`), undefined, "x");
    const ref = (links: string) => `<ComObjectInstanceRef RefId="O-3_R-3" Links="${links}"/>`;
    expect(p(ref("GA-1 GA-9") + ref("GA-2 GA-1")).deviceLinks[0].links).toEqual([{ comObjRefId: "O-3_R-3", gaRaws: [10, 20] }]);
    expect(p(ref("GA-1 GA-2") + ref("GA-2 GA-1 GA-3")).deviceLinks[0].links).toEqual([{ comObjRefId: "O-3_R-3", gaRaws: [10, 20, 30] }]);
    expect(p(ref("GA-3 GA-1") + ref("GA-1 GA-2")).deviceLinks[0].links).toEqual([{ comObjRefId: "O-3_R-3", gaRaws: [30, 10, 20] }]);
    // a duplicate inside one ref's own Links
    expect(p(ref("GA-1 GA-2 GA-1")).deviceLinks[0].links).toEqual([{ comObjRefId: "O-3_R-3", gaRaws: [10, 20] }]);
  });

  test("a com-object whose links all imported is not listed as dropped", () => {
    expect(project(`<Send GroupAddressRefId="P-0001-0_GA-1"/><Receive GroupAddressRefId="P-0001-0_GA-2"/>`).droppedLinks).toEqual([]);
  });

  test("com-object flags keyed by a prefixed ref are stored under the unprefixed key", () => {
    const p = parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="M-00FA_A-0001-01-0000_O-3_R-3" ReadFlag="Enabled"/></ComObjectInstanceRefs>`)}</Line></Area></Topology></Installation>`), undefined, "x");
    expect(p.deviceComObjOverrides[0].overrides).toEqual([{ comObjRefId: "O-3_R-3", attrs: { ReadFlag: "Enabled" } }]);
  });
});

describe("project shapes beyond a single installation and line", () => {
  test("only the first installation is imported, its links resolve inside it, and the rest is counted", () => {
    const first = `<Installation InstallationId="0" Name="Main"><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1"/></ComObjectInstanceRefs>`)}</Line></Area></Topology>${gas("P-0001-0", 100)}</Installation>`;
    // The second installation's GA-1 has another address; with the prefix stripped its id collides.
    const second = `<Installation InstallationId="1" Name="Annex"><Topology><Area Address="2"><Line Address="1">${device("P-0001-1_DI-1", 7, "")}</Line></Area></Topology>${gas("P-0001-1", 200)}</Installation>`;
    const p = parseProject(doc(first + second), undefined, "x");
    expect(p.skippedInstallations).toBe(1);
    expect(p.devices.map((d) => d.ia)).toEqual(["1.1.5"]);
    expect(p.groupAddresses.map((g) => g.raw)).toEqual([100]);
    expect(p.deviceLinks[0].links).toEqual([{ comObjRefId: "O-1_R-1", gaRaws: [100] }]);
  });

  test("devices ETS keeps outside the topology are counted", () => {
    const p = parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, "")}</Line></Area><UnassignedDevices>${device("P-0001-0_DI-2", 0, "")}${device("P-0001-0_DI-3", 0, "")}</UnassignedDevices></Topology></Installation>`), undefined, "x");
    expect(p.devices.map((d) => d.id)).toEqual(["P-0001-0_DI-1"]);
    expect(p.unassignedDevices).toBe(2);
    expect(p.skippedInstallations).toBe(0);
  });

  test("a device's LoadedImage and CheckSums arrive as written, and stay absent where ETS wrote none", () => {
    const p = parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, "", ` LoadedImage="AAECAw==" CheckSums="0102:abcd"`)}${device("P-0001-0_DI-2", 6, "")}</Line></Area></Topology></Installation>`), undefined, "x");
    expect(p.devices[0].etsLoadedImage).toBe("AAECAw==");
    expect(p.devices[0].etsCheckSums).toBe("0102:abcd");
    expect("etsLoadedImage" in p.devices[1]).toBe(false);
    expect("etsCheckSums" in p.devices[1]).toBe(false);
  });

  test("devices of every segment of a line are imported", () => {
    const p = parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1"><Segment Id="S-0" MediumTypeRefId="MT-0">${device("P-0001-0_DI-1", 5, "")}</Segment><Segment Id="S-1" MediumTypeRefId="MT-2">${device("P-0001-0_DI-2", 6, "")}</Segment></Line></Area></Topology></Installation>`), undefined, "x");
    expect(p.devices.map((d) => d.ia)).toEqual(["1.1.5", "1.1.6"]);
  });

  test("links of a com-object whose module instance the device no longer has are counted", () => {
    const refs = `<ModuleInstances><ModuleInstance Id="MD-1_M-1_MI-1" RefId="MD-1_M-1"/></ModuleInstances>
      <ComObjectInstanceRefs>
        <ComObjectInstanceRef RefId="MD-1_M-1_MI-1_O-2-1_R-1" Links="GA-1"/>
        <ComObjectInstanceRef RefId="MD-1_M-1_MI-2_O-2-1_R-1" Links="GA-1 GA-9"/>
      </ComObjectInstanceRefs>`;
    const p = parseProject(doc(`<Installation Name=""><Topology><Area Address="1"><Line Address="1">${device("P-0001-0_DI-1", 5, refs)}</Line></Area></Topology>${gas("P-0001-0", 10, 20)}</Installation>`), undefined, "x");
    expect(p.staleModuleLinks).toBe(2);
    expect(p.unresolvedLinks).toBe(0);
    expect(p.deviceLinks[0].links.map((l) => l.comObjRefId)).toEqual(["MD-1_M-1_MI-1_O-2-1_R-1", "MD-1_M-1_MI-2_O-2-1_R-1"]);
    expect(p.droppedLinks).toEqual([{ deviceId: "P-0001-0_DI-1", comObjRefId: "MD-1_M-1_MI-2_O-2-1_R-1", reason: "moduleInstanceGone", gas: [{ etsId: "GA-1", raw: 10 }, { etsId: "GA-9" }] }]);
  });
});
