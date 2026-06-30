import { test, expect, describe } from "bun:test";
import { secureEncode, secureDecode, SCF_TOOL_DATA } from "../src/secure.ts";

const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const src = 0x1101; // 1.1.1
const dst = 0x125a; // 1.2.90
const seq = Buffer.from("000000000001", "hex");
const tpci = 0x43; // numbered T_Data_Connected (0x40) | top APCI bits of SecureService (0x03)
const plaintext = Buffer.from("0300", "hex"); // an A_DeviceDescriptor_Read service APDU

const fields = { key, src, dst, dstIsGroup: false, seq, scf: SCF_TOOL_DATA, tpci, aad: Buffer.from([SCF_TOOL_DATA]), plaintext };
const aadFor = (scf: number) => Buffer.from([scf]);

describe("KNX Data Secure CCM (round-trip)", () => {
  test("encode then decode recovers the plaintext and sequence", () => {
    const body = secureEncode(fields);
    expect(body[0]).toBe(SCF_TOOL_DATA);                 // SCF
    expect(body.subarray(1, 7)).toEqual(seq);            // 6-byte sequence
    expect(body.length).toBe(1 + 6 + plaintext.length + 4); // SCF + seq + ct + 4-byte MAC
    const got = secureDecode(body, { key, src, dst, dstIsGroup: false, tpci, aadFor });
    expect(got).not.toBeNull();
    expect(got!.plaintext).toEqual(plaintext);
    expect(got!.seq).toEqual(seq);
  });

  test("a tampered payload fails the MAC (returns null, never unauthenticated data)", () => {
    const body = secureEncode(fields);
    body[8] ^= 0xff; // flip a ciphertext byte
    expect(secureDecode(body, { key, src, dst, dstIsGroup: false, tpci, aadFor })).toBeNull();
  });

  test("a wrong key fails the MAC", () => {
    const body = secureEncode(fields);
    const wrong = Buffer.alloc(16, 0xab);
    expect(secureDecode(body, { key: wrong, src, dst, dstIsGroup: false, tpci, aadFor })).toBeNull();
  });

  test("ciphertext is not the plaintext (it is actually encrypted)", () => {
    const body = secureEncode(fields);
    const ct = body.subarray(7, 7 + plaintext.length);
    expect(ct).not.toEqual(plaintext);
  });
});

// Known-answer vectors reproduced byte-for-byte from Calimero's
// SecureApplicationLayerTest (calimero-project/calimero-core). These prove interop
// correctness (the device/ETS will accept our frames), not just self-consistency.
describe("KNX Data Secure CCM (Calimero known-answer vectors)", () => {
  const katKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

  test("S-A_Data tool access, AuthConf (encryptPropertyWrite)", () => {
    const body = secureEncode({
      key: katKey, src: 0xff67, dst: 0xff00, dstIsGroup: false,
      seq: Buffer.from("000000000004", "hex"), scf: 0x90, tpci: 0x03,
      aad: Buffer.from([0x90]),
      plaintext: Buffer.from("03d705351001202122232425262728292a2b2c2d2e2f", "hex"),
    });
    // Prefix the TPCI|APCI octets (03 f1) to match the full on-wire secured APDU.
    const wire = Buffer.concat([Buffer.from([0x03, 0xf1]), body]).toString("hex");
    expect(wire).toBe("03f190000000000004" + "6767242a2308ca76a11774214ee4cf5d94909f743d05" + "0d8fc168");
  });

  test("Sync_Req: serial in the AAD changes the MAC (encryptSyncRequest crypto bytes)", () => {
    const body = secureEncode({
      key: katKey, src: 0xff67, dst: 0xff00, dstIsGroup: false,
      seq: Buffer.from("000000000001", "hex"), scf: 0x92, tpci: 0x43,
      aad: Buffer.concat([Buffer.from([0x92]), Buffer.alloc(6)]), // SCF || 6-byte serial
      plaintext: Buffer.from("000000000003", "hex"),              // challenge = 3
    });
    // body = SCF | seq | encPayload(6) | encMac(4); the in-clear serial is added by the
    // wire layer (SecureSession), so the crypto bytes are what we check here.
    expect(body.subarray(0, 7).toString("hex")).toBe("92000000000001");
    expect(body.subarray(7).toString("hex")).toBe("c1cf4506f09b" + "d79fab55");
  });
});
