import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readKeyring, writeKeyring, type Keyring } from "../src/keyring.ts";
import { KnxprojError } from "../src/errors.ts";

// Known-answer files are real ETS 5.7 exports from xknx's test suite (MIT):
// https://github.com/XKNX/xknx/tree/main/test/secure_tests/resources (keyring.knxkeys, password "pwd";
// testcase.knxkeys, password "password"). keyring.knxkeys is the same file as Calimero's
// test/resources/KeyringTest.knxkeys. Expected plaintexts: xknx test/secure_tests/keyring_test.py and
// Calimero test/io/calimero/secure/KeyringTest.java.
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/knxkeys", name), "utf8");
const hex = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString("hex") : undefined);
const bytes = (h: string) => Buffer.from(h, "hex");

describe("readKeyring (ETS known-answer files)", () => {
  test("keyring.knxkeys: signature, tool key, sequence and group key", () => {
    const k = readKeyring(fixture("keyring.knxkeys"), "pwd");
    expect(k.created).toBe("2019-06-11T06:45:22");
    expect(k.project).toBe("KeyringTest");
    const d = k.devices.find((x) => x.individualAddress === "1.1.0")!;
    expect(hex(d.toolKey)).toBe("aeac47c4653ed0b25249b4ab3f474479");
    expect(d.sequenceNumber).toBe(108n);
    expect(k.devices.map((x) => x.individualAddress)).toEqual(["1.1.0", "1.1.10", "1.1.11"]);
    expect(k.groups).toHaveLength(1);
    expect(k.groups[0].address).toBe(2305); // 1/1/1
    expect(hex(k.groups[0].key)).toBe("e14343050f4377e3159b90afe0228216");
    const itf = (ia: string) => k.interfaces!.find((i) => i.individualAddress === ia)!;
    expect(k.interfaces).toHaveLength(10);
    expect(itf("1.1.1").groups).toEqual([{ address: 2305, senders: ["1.1.12"] }]);
    expect(itf("1.1.20").groups).toEqual([{ address: 2305, senders: ["1.1.1", "1.1.12"] }]);
    expect(itf("1.1.2").groups).toEqual([]);
  });

  test("testcase.knxkeys: signature and the large sequence number", () => {
    const k = readKeyring(fixture("testcase.knxkeys"), "password");
    const d = k.devices[0];
    expect(d.individualAddress).toBe("1.0.0");
    expect(hex(d.toolKey)).toBe("9bc4fc74043a332b80baa2c8fef72d9d");
    expect(d.sequenceNumber).toBe(133294561196n);
  });

  test("a wrong password is refused by the signature, not read as other keys", () => {
    expect(() => readKeyring(fixture("keyring.knxkeys"), "pwX")).toThrow(KnxprojError);
    try { readKeyring(fixture("keyring.knxkeys"), "pwX"); } catch (e) { expect((e as KnxprojError).code).toBe("KEYRING_SIGNATURE_MISMATCH"); }
  });

  test("an altered file is refused", () => {
    const altered = fixture("keyring.knxkeys").replace('SequenceNumber="108"', 'SequenceNumber="109"');
    expect(() => readKeyring(altered, "pwd")).toThrow(/signature/);
  });
});

describe("writeKeyring", () => {
  const base: Keyring = {
    project: "Bench", createdBy: "Busforge", created: "2026-10-02T08:00:00",
    devices: [{ individualAddress: "1.1.204", toolKey: bytes("00112233445566778899aabbccddeeff"), sequenceNumber: 0x011028n, serialNumber: bytes("0083a1b2c3d4"), fdsk: bytes("ffeeddccbbaa99887766554433221100") }],
    groups: [{ address: 1, key: bytes("0102030405060708090a0b0c0d0e0f10") }, { address: 2305, key: bytes("e14343050f4377e3159b90afe0228216") }],
    interfaces: [{ individualAddress: "1.1.100", groups: [{ address: 1, senders: ["1.1.204", "1.1.203"] }, { address: 2305, senders: [] }] }],
  };

  test("encrypts a key as ETS does: the group key of keyring.knxkeys under its Created and password", () => {
    const xml = writeKeyring({ created: "2019-06-11T06:45:22", devices: [], groups: [{ address: 2305, key: bytes("e14343050f4377e3159b90afe0228216") }] }, "pwd");
    expect(xml).toContain('<Group Address="2305" Key="iA2KpI19ZlW0jseoXSycAg==" />');
  });

  test("round-trips through the reader with every value", () => {
    const xml = writeKeyring(base, "bench-pw");
    expect(xml.startsWith("﻿<?xml")).toBe(true);
    expect(xml).toContain('xmlns="http://knx.org/xml/keyring/1"');
    expect(xml).toContain('SerialNumber="0083A1B2C3D4"');
    const k = readKeyring(xml, "bench-pw");
    expect(k.project).toBe("Bench");
    expect(k.created).toBe(base.created);
    expect(k.devices).toHaveLength(1);
    const d = k.devices[0];
    expect(d.individualAddress).toBe("1.1.204");
    expect(hex(d.toolKey)).toBe("00112233445566778899aabbccddeeff");
    expect(d.sequenceNumber).toBe(0x011028n);
    expect(hex(d.serialNumber)).toBe("0083a1b2c3d4");
    expect(hex(d.fdsk)).toBe("ffeeddccbbaa99887766554433221100");
    expect(k.groups.map((g) => [g.address, hex(g.key)])).toEqual([[1, "0102030405060708090a0b0c0d0e0f10"], [2305, "e14343050f4377e3159b90afe0228216"]]);
    expect(k.interfaces).toEqual([{ individualAddress: "1.1.100", groups: [{ address: 1, senders: ["1.1.204", "1.1.203"] }, { address: 2305, senders: [] }] }]);
  });

  test("escapes a project name and still verifies", () => {
    const xml = writeKeyring({ ...base, project: 'A & "B" <C>' }, "pw");
    expect(readKeyring(xml, "pw").project).toBe('A & "B" <C>');
  });

  test("keeps whitespace in a value exactly, as a conforming XML reader sees it", () => {
    // Raw tab, line feed and carriage return in an attribute are read as spaces by a conforming parser
    // (ElementTree in xknx), which would then sign another value: they must go out as references.
    const name = " lead\ttab\nline\r end ";
    const xml = writeKeyring({ ...base, project: name }, "pw");
    expect(xml).toContain('Project=" lead&#9;tab&#10;line&#13; end "');
    expect(readKeyring(xml, "pw").project).toBe(name);
    expect(() => writeKeyring({ ...base, project: "bell\x07" }, "pw")).toThrow(/control character/);
  });

  test("refuses what ETS's readers would take differently", () => {
    expect(() => writeKeyring(base, "")).toThrow(/password/);
    expect(() => writeKeyring(base, "pässword")).toThrow(/ASCII/);
    expect(() => writeKeyring({ ...base, created: "2026-10-02" }, "pw")).toThrow(/Created/);
    expect(() => writeKeyring({ ...base, groups: [{ address: 1, key: bytes("00") }] }, "pw")).toThrow(/16 bytes/);
    expect(() => writeKeyring({ ...base, groups: [{ address: 0, key: bytes("00112233445566778899aabbccddeeff") }] }, "pw")).toThrow(/group address/);
    expect(() => writeKeyring({ ...base, devices: [{ individualAddress: "16.1.1" }] }, "pw")).toThrow(/individual address/);
    expect(() => writeKeyring({ ...base, devices: [base.devices[0], base.devices[0]] }, "pw")).toThrow(/twice/);
    expect(() => writeKeyring({ ...base, devices: [{ individualAddress: "1.1.1", sequenceNumber: 2n ** 48n }] }, "pw")).toThrow(/range/);
  });
});
