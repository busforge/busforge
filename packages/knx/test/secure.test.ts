import { test, expect, describe } from "bun:test";
import { isSecureApdu, openSecureGroupTpdu, secureEncode, secureDecode, SCF_TOOL_DATA } from "../src/secure.ts";

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

// Known-answer vectors reproduced byte-for-byte from Calimero's SecureApplicationLayerTest:
// https://github.com/calimero-project/calimero-core/blob/118b2cb4db6782d76d218d07103589160e9f40a0/test/io/calimero/secure/SecureApplicationLayerTest.java
// (constants encryptedPropertyWrite / encryptedSyncReq, exercised by the encryptPropertyWrite
// and encryptSyncRequest test methods). The property-write bytes are the KNX AN158 v07
// "KNX Data Security AS" Annex A example (xknx quotes the same bytes with that attribution).
// These prove interop correctness (the device/ETS will accept our frames), not just
// self-consistency.
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

// Known-answer vectors for the GROUP-address path (S-A_Data, AT = 0x80 in B0[11],
// group key instead of tool key, SCF = 0x10). Calimero's test tree has NO group
// vector (checked test/io/calimero/secure/ at commit 118b2cb4), so these come from
// xknx, the other independent interoperating Data Secure implementation:
// https://github.com/XKNX/xknx/blob/0d41b0479b3ad0eab918ea1b26cd6c84314b5ea5/test/secure_tests/data_secure_test.py
// (test methods test_data_secure_group_send and test_data_secure_group_receive).
//
// The group key is the GA 1024 (0/4/0) entry of xknx's ETS-generated keyring
// https://github.com/XKNX/xknx/blob/918353c9f756d6fca8bd96e42f36cf02b9cab2cc/test/secure_tests/resources/SecureTest.knxkeys
// (Key="B8nWiBBMs/wH3I3aYKmHlw==", Created="2023-01-30T19:17:06", password "test").
// Regenerate: AES-128-CBC-decrypt(base64(Key)) with
//   key = PBKDF2-HMAC-SHA256("test", "1.keyring.ets.knx.org", 65536 iter, 16 bytes)
//   iv  = sha256("2023-01-30T19:17:06")[0..16]
// which yields dfdf23a59fbb40404091d1c162087e8b.
describe("KNX Data Secure CCM (xknx group-address known-answer vectors)", () => {
  const groupKey = Buffer.from("dfdf23a59fbb40404091d1c162087e8b", "hex");
  const ga = 0x0400; // 0/4/0 = raw 1024
  const aadFor = (scf: number) => Buffer.from([scf]);

  test("secured GroupValueRead 5.0.1 -> 0/4/0 (test_data_secure_group_send)", () => {
    // xknx: seq 160170101607, secured_apdu cd18, MAC 4afe5744, full L_Data payload
    // bce0500104000e_03f11000254ae1cb67cd184afe5744 (we check from the TPCI|APCI on).
    const body = secureEncode({
      key: groupKey, src: 0x5001, dst: ga, dstIsGroup: true,
      seq: Buffer.from("00254ae1cb67", "hex"), // 160170101607
      scf: 0x10, tpci: 0x03, aad: Buffer.from([0x10]),
      plaintext: Buffer.from("0000", "hex"), // GroupValueRead APDU
    });
    const wire = Buffer.concat([Buffer.from([0x03, 0xf1]), body]).toString("hex");
    expect(wire).toBe("03f110" + "00254ae1cb67" + "cd18" + "4afe5744");
  });

  test("secured GroupValueResponse 4.0.9 -> 0/4/0 decodes (test_data_secure_group_receive)", () => {
    // xknx cEMI 29003ce04009040011_03f1_10002446cfef4ac085e7092ab062b44d;
    // seq 155806854986, plaintext = GroupValueResponse (116, 41, 41).
    const body = Buffer.from("10" + "002446cfef4a" + "c085e7092a" + "b062b44d", "hex");
    const got = secureDecode(body, { key: groupKey, src: 0x4009, dst: ga, dstIsGroup: true, tpci: 0x03, aadFor });
    expect(got).not.toBeNull();
    expect(got!.seq.toString("hex")).toBe("002446cfef4a");
    expect(got!.plaintext.toString("hex")).toBe("0040742929"); // A_GroupValue_Response + 74 29 29
  });

  test("the AT bit is load-bearing: decoding the group vector as P2P fails the MAC", () => {
    const body = Buffer.from("10002446cfef4ac085e7092ab062b44d", "hex");
    expect(secureDecode(body, { key: groupKey, src: 0x4009, dst: ga, dstIsGroup: false, tpci: 0x03, aadFor })).toBeNull();
  });
});

describe("openSecureGroupTpdu (monitor view of a secured group telegram)", () => {
  const groupKey = Buffer.from("dfdf23a59fbb40404091d1c162087e8b", "hex");
  const ga = 0x0400;
  // xknx test_data_secure_group_receive, the TPDU from the TPCI|APCI on.
  const tpdu = () => Buffer.from("03f1" + "10" + "002446cfef4a" + "c085e7092a" + "b062b44d", "hex");

  test("recognizes A_Data_Secure and nothing else", () => {
    expect(isSecureApdu(tpdu())).toBe(true);
    expect(isSecureApdu(Buffer.from("0081", "hex"))).toBe(false); // GroupValueWrite 1
    expect(isSecureApdu(Buffer.from("03f0", "hex"))).toBe(false);
  });

  test("decrypts with the address's key into the inner group APDU and its sequence", () => {
    const got = openSecureGroupTpdu(0x4009, ga, tpdu(), groupKey);
    expect(got).toEqual({ state: "decrypted", apdu: Buffer.from("0040742929", "hex"), seq: 0x002446cfef4an });
  });

  test("no key is its own state, never a value", () => {
    expect(openSecureGroupTpdu(0x4009, ga, tpdu(), undefined)).toEqual({ state: "noKey" });
  });

  test("a wrong key or a flipped bit fails authentication", () => {
    const wrong = Buffer.from(groupKey); wrong[0] ^= 1;
    expect(openSecureGroupTpdu(0x4009, ga, tpdu(), wrong)).toEqual({ state: "authFailed" });
    const t = tpdu(); t[t.length - 1] ^= 0x01;
    expect(openSecureGroupTpdu(0x4009, ga, t, groupKey)).toEqual({ state: "authFailed" });
    expect(openSecureGroupTpdu(0x4008, ga, tpdu(), groupKey)).toEqual({ state: "authFailed" }); // source is authenticated
  });

  test("a secured frame this monitor does not decode is unsupported, not guessed", () => {
    for (const scf of [0x90 /* tool access */, 0x00 /* auth only */, 0x18 /* system broadcast */, 0x12 /* sync req */]) {
      const t = tpdu(); t[2] = scf;
      expect(openSecureGroupTpdu(0x4009, ga, t, groupKey)).toEqual({ state: "unsupported" });
    }
    expect(openSecureGroupTpdu(0x4009, ga, Buffer.from("03f110", "hex"), groupKey)).toEqual({ state: "unsupported" }); // truncated
  });
});
