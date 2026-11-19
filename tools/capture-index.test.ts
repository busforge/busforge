import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { gaToNum, iaToNum } from "../packages/knx/src/index.ts";
import { secureEncode } from "../packages/knx/src/secure.ts";
import { writeKeyring } from "../packages/project/src/keyring.ts";
import { storeZip } from "../packages/project/test/ziputil.ts";
import { addKeys, corpusKeys, emptyKeys, parseKeyList, type SecureKeys } from "./secure-capture.ts";
import {
  apciName, BUSSARD_ROWS, buildIndex, INDEX_FORMAT, documentedKeyringPasswords, indexFile, propertyAnswerRows, propertyAnswersUnseen, renderPropertyAnswers, indexText, INDEX_JSON, INDEX_MD, labelDisagrees, PCAP_CLIENT, renderMarkdown, type CaptureIndex, type IndexedFile, type KeySources,
  type NotIndexed,
} from "./capture-index.ts";
import { BUSSARD_SYNTHETIC_DIR, captureText, corpusPath, corpusRoot } from "./corpus.ts";
import { corpusDescribe, corpusTest } from "./corpus-test.ts";
import { removeTempDir, tempDir } from "./test-temp.ts";

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

// One proxy log line carrying a TUNNELLING_REQUEST with an L_Data frame. `ctrl1` is the first cEMI control field
// (ETS 6 sends 0xB0, Busforge 0xBC); `group` sets the destination address type.
function tunnelFrame(code: number, src: string, dst: number, tpdu: number[], ctrl1 = 0xb0, group = false): Buffer {
  const cemi = [code, 0x00, ctrl1, group ? 0xe0 : 0x60, ...u16(iaToNum(src)), ...u16(dst), tpdu.length - 1, ...tpdu];
  const body = [0x04, 0x01, 0x00, 0x00, ...cemi];
  return Buffer.from([0x06, 0x10, 0x04, 0x20, ...u16(6 + body.length), ...body]);
}
function tunnel(dir: string, code: number, src: string, dst: number, tpdu: number[], ctrl1 = 0xb0, group = false): string {
  return `2000-01-01T00:00:00.000Z ${dir} TUNNELLING_REQ x | ${tunnelFrame(code, src, dst, tpdu, ctrl1, group).toString("hex")}`;
}
const proxyLine = (dir: string, frame: number[]) => `2000-01-01T00:00:00.000Z ${dir} x  | ${Buffer.from(frame).toString("hex")}`;

// A classic pcap file (little endian, raw IPv4) of UDP datagrams between a client and a KNXnet/IP server.
function pcap(datagrams: { fromServer: boolean; payload: Buffer }[]): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32LE(0xa1b2c3d4, 0); head.writeUInt16LE(2, 4); head.writeUInt16LE(4, 6); head.writeUInt32LE(65535, 16); head.writeUInt32LE(101, 20);
  const records = datagrams.map(({ fromServer, payload }) => {
    const client = [192, 168, 0, 2], server = [192, 168, 0, 1];
    const udp = Buffer.concat([Buffer.from([...u16(fromServer ? 3671 : 50000), ...u16(fromServer ? 50000 : 3671), ...u16(8 + payload.length), 0, 0]), payload]);
    const ip = Buffer.concat([Buffer.from([0x45, 0, ...u16(20 + udp.length), 0, 0, 0, 0, 64, 17, 0, 0, ...(fromServer ? server : client), ...(fromServer ? client : server)]), udp]);
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(ip.length, 8); rec.writeUInt32LE(ip.length, 12);
    return Buffer.concat([rec, ip]);
  });
  return Buffer.concat([head, ...records]);
}
const REQ = 0x11, CON = 0x2e, IND = 0x29;
const NO_KEYS: KeySources = { read: [], notRead: [], environment: [], deviceKeys: 0, groupKeys: 0 };

function indexed(r: IndexedFile | NotIndexed): IndexedFile {
  if ("reason" in r) throw new Error(`not indexed: ${r.reason}`);
  return r;
}
function refused(r: IndexedFile | NotIndexed): string {
  if (!("reason" in r)) throw new Error(`indexed as ${r.format}`);
  return r.reason;
}

describe("proxy logs", () => {
  test("reads an address assignment, the unit's descriptor, its properties and memory writes, each way", () => {
    const text = [
      "2000-01-01T00:00:00.000Z --- ETS connected, bridge up ---",
      tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, [0x00, 0xc0, ...u16(iaToNum("1.1.7"))], 0xb0, true), // A_IndividualAddress_Write
      tunnel("BRIDGE->ETS", CON, "1.1.100", 0, [0x00, 0xc0, ...u16(iaToNum("1.1.7"))], 0xb0, true),
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x80]),                               // T_Connect
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x43, 0x00]),                         // A_DeviceDescriptor_Read
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x43, 0x40, 0x07, 0x05]),           // ... Response 0705
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0xc2]),                             // T_Ack
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x47, 0xd7, 0x00, 0x36, 0x10, 0x01, 0x00]), // PropertyValue_Write 0/54
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x4a, 0x82, 0x40, 0x00, 0x01, 0x02]), // A_Memory_Write, 2 bytes
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x4f, 0xf1, 0x10, ...Array(12).fill(0)]), // A_SecureService: SCF 0x10, sequence, 2 octets, MAC
      tunnel("BRIDGE->ETS", IND, "1.1.9", 0x0a01, [0x00, 0x81], 0xbc, true),                        // someone's group write
      "=== second run",
    ].join("\n");
    const f = indexed(indexText("x.log", text));
    expect(f.format).toBe("knxproxy");
    expect(f.tools).toEqual(["ETS"]);
    expect(f.framesBuiltAs).toBe("ETS");
    expect(f.devices).toEqual([{ address: "1.1.7", descriptor0: ["0705"] }]);
    expect(f.assigned).toEqual(["1.1.7"]);
    expect(f.services).toEqual({
      A_DeviceDescriptor_Read: { sent: 1, received: 0 }, A_DeviceDescriptor_Response: { sent: 0, received: 1 },
      A_GroupValue_Write: { sent: 0, received: 1 }, A_IndividualAddress_Write: { sent: 1, received: 0 },
      A_Memory_Write: { sent: 1, received: 0 }, A_PropertyValue_Write: { sent: 1, received: 0 },
      A_SecureService: { sent: 1, received: 0 }, T_Ack: { sent: 0, received: 1 }, T_Connect: { sent: 1, received: 0 },
    });
    expect(f.properties).toEqual(["0/54"]);
    expect(f.groupAddresses).toBe(1);
    // No key given: the frame shows only its security control field (S-A_Data, no tool access) in clear.
    expect(f.secure).toEqual({ telegrams: 1, shown: 0, inside: { "S-A_Data (not opened)": { sent: 1, received: 0 } }, openedWith: [] });
    expect(f.telegrams).toBe(9); // the confirmation repeats the request and is not counted
    expect(f.undecoded.count).toBe(0);
  });

  test("tells a Busforge run from the label the proxy gave it", () => {
    const text = tunnel("ETS->BRIDGE", REQ, "1.1.100", iaToNum("1.1.7"), [0x80], 0xbc);
    const f = indexed(indexText("x.log", text));
    expect(f.tools).toEqual(["ETS"]);
    expect(f.framesBuiltAs).toBe("Busforge");
    expect(labelDisagrees(f)).toBe(true);
    expect(renderMarkdown({ format: INDEX_FORMAT, dirs: ["captures"], keys: NO_KEYS, files: [f], notIndexed: [] }))
      .toContain("- `x.log`: labelled ETS, frames built as Busforge's");
  });

  test("leaves the tool's group telegrams out of the frame check", () => {
    // ETS 6 sends a group read with 0xBC: it says nothing about whose builder the download's frames come from.
    const text = [
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x80]),
      tunnel("ETS->BRIDGE", REQ, "1.1.254", 0x0a01, [0x00, 0x00], 0xbc, true),
    ].join("\n");
    expect(indexed(indexText("x.log", text)).framesBuiltAs).toBe("ETS");
  });

  test("reads the interface's own properties from a cEMI local management request", () => {
    const text = "2000-01-01T00:00:00.000Z ETS->BRIDGE DEVICE_CONFIG_REQ  | 06100310001104030000fc000001381001";
    const f = indexed(indexText("x.log", text));
    expect(f.services).toEqual({ "M_PropRead.req": { sent: 1, received: 0 } });
    expect(f.properties).toEqual(["if t0.1/56"]);
  });

  test("counts a frame that does not decode, with its line, instead of skipping it", () => {
    const good = tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x80]);
    const shortened = good.slice(0, -2); // the frame's length field now names a byte that is not there
    const descriptorOfThree = tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x43, 0x40, 0x07, 0x05, 0x00]);
    const f = indexed(indexText("x.log", [good, shortened, descriptorOfThree].join("\n")));
    expect(f.undecoded).toEqual({ count: 2, lines: [2, 3] });
  });

  test("refuses a proxy log with lines that are neither frames nor markers", () => {
    const text = [tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x80]), "something else"].join("\n");
    expect(refused(indexText("x.log", text))).toBe("proxy log lines mixed with lines that are neither frames nor markers (first at line 2)");
  });

  test("reads an address assignment by serial number and an extended property", () => {
    const serial = [0x00, 0x83, 0x7d, 0x40, 0x39, 0xdb];
    const text = [
      tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, [0x03, 0xde, ...serial, ...u16(iaToNum("1.1.30")), 0, 0, 0, 0], 0xb0, true),
      // A_PropertyExtValue_Read of object type 17, instance 1, PID 54
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.30"), [0x41, 0xcc, 0x00, 0x11, 0x00, 0x10, 0x36, 0x01, 0x00, 0x01]),
    ].join("\n");
    const f = indexed(indexText("x.log", text));
    expect(f.assigned).toEqual(["1.1.30 (serial 00837D4039DB)"]);
    expect(f.properties).toEqual(["t17.1/54"]);
    expect(Object.keys(f.services)).toEqual(["A_IndividualAddressSerialNumber_Write", "A_PropertyExtValue_Read"]);
  });

  test("counts a request the interface confirmed negatively as not on the bus", () => {
    const text = [
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x43, 0x81, 0x01, 0x00]),
      tunnel("BRIDGE->ETS", CON, "1.1.100", iaToNum("1.1.7"), [0x43, 0x81, 0x01, 0x00], 0xb1),
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x80]),
      tunnel("BRIDGE->ETS", CON, "1.1.100", iaToNum("1.1.7"), [0x80], 0xb0),
    ].join("\n");
    const f = indexed(indexText("x.log", text));
    expect(f.services["A_Restart (master reset)"]).toEqual({ sent: 1, received: 0 });
    expect(f.notOnBus).toBe(1);
  });

  test("counts a telegram whose data is short of its service's layout as undecoded", () => {
    const text = [
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x42, 0x81]),                    // A_Memory_Write of 1 byte, no address
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x43, 0xd6, 0x00, 0x0b]),       // property response: object and PID only
      tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, [0x03, 0xde, 0, 0x83, 0x7d, 0x40, 0x39, 0xdb, 0x11, 0x1e], 0xb0, true), // serial write, no reserved octets
      tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, [0x40, 0x81], 0xb0, true),                        // a group telegram with a sequence number
    ].join("\n");
    const f = indexed(indexText("x.log", text));
    expect(f.undecoded).toEqual({ count: 4, lines: [1, 2, 3, 4] });
    expect(f.properties).toEqual([]);
    expect(f.assigned).toEqual([]);
  });

  test("counts a KNXnet/IP service that is neither a telegram nor connection management as undecoded", () => {
    const routing = [0x06, 0x10, 0x05, 0x30, 0x00, 0x08, 0x00, 0x00]; // ROUTING_INDICATION
    const connect = [0x06, 0x10, 0x02, 0x05, 0x00, 0x08, 0x00, 0x00];
    const f = indexed(indexText("x.log", [proxyLine("ETS->BRIDGE", connect), proxyLine("BRIDGE->ETS", routing)].join("\n")));
    expect(f.undecoded).toEqual({ count: 1, lines: [2] });
  });
});

describe("pcap captures", () => {
  const connectRes = Buffer.from([0x06, 0x10, 0x02, 0x06, 0x00, 0x08, 0x01, 0x00]);
  test("are read through tools/pcap.ts, whatever their name says, with the client unnamed", () => {
    const bytes = pcap([
      { fromServer: true, payload: connectRes },
      { fromServer: false, payload: tunnelFrame(REQ, "0.0.0", iaToNum("1.1.7"), [0x80]) },
    ]);
    const dir = tempDir("capture-index-");
    try {
      writeFileSync(join(dir, "ets.pcapng"), bytes);
      const f = indexed(indexFile(dir, "ets.pcapng"));
      expect(f.format).toBe("pcap");
      expect(f.tools).toEqual([PCAP_CLIENT]);
      expect(f.framesBuiltAs).toBe("ETS");
      expect(labelDisagrees(f)).toBe(false);
      expect(f.services).toEqual({ T_Connect: { sent: 1, received: 0 } });
    } finally { removeTempDir(dir); }
  });

  test("its refusal is the reason a capture is not read", () => {
    const dir = tempDir("capture-index-");
    try {
      writeFileSync(join(dir, "x.pcap"), pcap([{ fromServer: false, payload: tunnelFrame(REQ, "0.0.0", iaToNum("1.1.7"), [0x80]) }]));
      expect(refused(indexFile(dir, "x.pcap"))).toStartWith("pcap capture tools/pcap.ts refuses: no datagram carries a server's answer");
    } finally { removeTempDir(dir); }
  });
});

// Made-up keys for frames this file builds; no device holds them.
const FDSK = Buffer.alloc(16, 0x11), TOOL_KEY = Buffer.alloc(16, 0x22), GROUP_KEY = Buffer.alloc(16, 0x33), OTHER_KEY = Buffer.alloc(16, 0x44);
const SERIAL = Buffer.from("000A31293319", "hex");
const seq = (n: number) => Buffer.from([0, 0, 0, 0, 0, n]);

// An A_Data_Secure TPDU: `tpci` is its first octet (0x03 unnumbered, 0x43 numbered data with sequence 0),
// authenticated for `src` -> `dst`. A Sync.req carries the target serial in clear behind the sequence; a Sync.res
// carries its random sequence XOR the request's challenge.
function secured(o: {
  key: Buffer; src: string; dst: number; group?: boolean; scf: number; seq: Buffer; plaintext: Buffer; tpci?: number;
  serial?: Buffer; challenge?: Buffer;
}): number[] {
  const tpci = o.tpci ?? 0x03;
  const aad = o.serial ? Buffer.concat([Buffer.from([o.scf]), o.serial]) : Buffer.from([o.scf]);
  let body = secureEncode({ key: o.key, src: iaToNum(o.src), dst: o.dst, dstIsGroup: !!o.group, seq: o.seq, scf: o.scf, tpci, aad, plaintext: o.plaintext });
  if (o.serial) body = Buffer.concat([body.subarray(0, 7), o.serial, body.subarray(7)]);
  if (o.challenge) for (let i = 0; i < 6; i++) body[1 + i] ^= o.challenge[i];
  return [tpci, 0xf1, ...body];
}

describe("secured telegrams of a proxy log", () => {
  const keys = (): SecureKeys => {
    const k = emptyKeys();
    addKeys(k, [{ name: "fdsk", key: FDSK }, { name: "tool", key: TOOL_KEY }], [{ raw: gaToNum("2/1/7"), key: { name: "group 2/1/7", key: GROUP_KEY } }]);
    return k;
  };
  const challenge = Buffer.from("a1a2a3a4a5a6", "hex");
  // A tool's request leaves its source 0.0.0; the confirmation names the tunnel's address it was authenticated with.
  const text = [
    tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x80]),
    tunnel("BRIDGE->ETS", CON, "1.1.100", iaToNum("1.1.7"), [0x80]),
    // ETS assigns a secure device its address by serial: a broadcast Sync under the device's FDSK ...
    tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, secured({ key: FDSK, src: "1.1.100", dst: 0, group: true, scf: 0x92, seq: seq(1), plaintext: challenge, serial: SERIAL }), 0xb0, true),
    tunnel("BRIDGE->ETS", IND, "15.15.255", 0, secured({ key: FDSK, src: "15.15.255", dst: 0, group: true, scf: 0x93, seq: seq(9), plaintext: Buffer.alloc(12, 1), challenge }), 0xb0, true),
    // ... then the serial-number write to the broadcast, tool access
    tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, secured({
      key: FDSK, src: "1.1.100", dst: 0, group: true, scf: 0x90, seq: seq(2), plaintext: Buffer.from([0x03, 0xde, ...SERIAL, ...u16(iaToNum("1.1.204")), 0, 0, 0, 0]),
    }), 0xb0, true),
    tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), secured({ key: TOOL_KEY, src: "1.1.100", dst: iaToNum("1.1.7"), scf: 0x90, seq: seq(3), tpci: 0x43, plaintext: Buffer.from([0x03, 0xd5, 0x00, 0x38, 0x10, 0x01]) })),
    tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), secured({ key: TOOL_KEY, src: "1.1.7", dst: iaToNum("1.1.100"), scf: 0x90, seq: seq(4), tpci: 0x43, plaintext: Buffer.from([0x03, 0x40, 0x07, 0xb0]) })),
    tunnel("BRIDGE->ETS", IND, "1.1.9", gaToNum("2/1/7"), secured({ key: GROUP_KEY, src: "1.1.9", dst: gaToNum("2/1/7"), group: true, scf: 0x10, seq: seq(5), plaintext: Buffer.from([0x00, 0x81]) }), 0xbc, true),
    // under a key nobody gave, and an answer to a Sync no key opened
    tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), secured({ key: OTHER_KEY, src: "1.1.100", dst: iaToNum("1.1.7"), scf: 0x90, seq: seq(6), tpci: 0x47, plaintext: Buffer.from([0x03, 0xd5, 0x00, 0x38, 0x10, 0x01]) })),
    tunnel("BRIDGE->ETS", IND, "1.1.8", iaToNum("1.1.100"), secured({ key: TOOL_KEY, src: "1.1.8", dst: iaToNum("1.1.100"), scf: 0x93, seq: seq(7), tpci: 0x43, plaintext: Buffer.alloc(12, 1), challenge })),
  ].join("\n");

  test("opens them with the keys it is given, the broadcast address assignment by serial among them", () => {
    const f = indexed(indexText("x.log", text, keys()));
    expect(f.undecoded.count).toBe(0);
    expect(f.secure).toEqual({
      telegrams: 8, shown: 6, openedWith: ["fdsk", "group 2/1/7", "tool"],
      inside: {
        "A_DeviceDescriptor_Response [tool access]": { sent: 0, received: 1 },
        "A_GroupValue_Write [group]": { sent: 0, received: 1 },
        "A_IndividualAddressSerialNumber_Write [tool access, broadcast]": { sent: 1, received: 0 },
        "A_PropertyValue_Read [tool access]": { sent: 1, received: 0 },
        "S-A_Data (not opened) [tool access]": { sent: 1, received: 0 },
        "Sync.req [tool access, broadcast]": { sent: 1, received: 0 },
        "Sync.res (not opened) [tool access]": { sent: 0, received: 1 },
        "Sync.res [tool access, broadcast]": { sent: 0, received: 1 },
      },
    });
    // An opened telegram's service is read like a plain one.
    expect(f.assigned).toEqual(["1.1.204 (serial 000A31293319)"]);
    expect(f.properties).toEqual(["0/56"]);
    expect(f.devices.find((d) => d.address === "1.1.7")).toEqual({ address: "1.1.7", descriptor0: ["07B0"] });
    expect(f.services["A_PropertyValue_Read"]).toEqual({ sent: 1, received: 0 });
    expect(f.services["A_SecureService"]).toEqual({ sent: 4, received: 4 });
    const md = renderMarkdown({ format: INDEX_FORMAT, dirs: ["captures"], keys: NO_KEYS, files: [f], notIndexed: [] });
    expect(md).toContain("- **A_IndividualAddressSerialNumber_Write [tool access, broadcast]** (1): `x.log`");
    expect(md).toContain("| 8 (6 shown) |");
  });

  test("without keys, counts each by what its frame shows in clear", () => {
    const f = indexed(indexText("x.log", text));
    expect(f.secure.shown).toBe(0);
    expect(f.secure.inside).toEqual({
      "S-A_Data (not opened) [group]": { sent: 0, received: 1 },
      "S-A_Data (not opened) [tool access, broadcast]": { sent: 1, received: 0 },
      "S-A_Data (not opened) [tool access]": { sent: 2, received: 1 },
      "Sync.req (not opened) [tool access, broadcast]": { sent: 1, received: 0 },
      "Sync.res (not opened) [tool access, broadcast]": { sent: 0, received: 1 },
      "Sync.res (not opened) [tool access]": { sent: 0, received: 1 },
    });
    expect(f.assigned).toEqual([]);
  });

  test("a secured request that comes before any confirmation waits for the tunnel address the confirmation names", () => {
    const f = indexed(indexText("x.log", [
      tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, secured({ key: FDSK, src: "1.1.100", dst: 0, group: true, scf: 0x92, seq: seq(1), plaintext: challenge, serial: SERIAL }), 0xb0, true),
      tunnel("BRIDGE->ETS", CON, "1.1.100", 0, [0x03, 0xf1, 0x92], 0xb0, true),
      tunnel("BRIDGE->ETS", IND, "15.15.255", 0, secured({ key: FDSK, src: "15.15.255", dst: 0, group: true, scf: 0x93, seq: seq(9), plaintext: Buffer.alloc(12, 1), challenge }), 0xb0, true),
      // the last line of the file, waiting for no confirmation: opened when the file ends, with the address line 2 set
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), secured({ key: TOOL_KEY, src: "1.1.100", dst: iaToNum("1.1.7"), scf: 0x90, seq: seq(3), tpci: 0x43, plaintext: Buffer.from([0x43, 0x00]) })),
    ].join("\n"), keys()));
    expect(f.secure.inside).toEqual({
      "S-A_Data (inner APDU malformed) [tool access]": { sent: 1, received: 0 },
      "Sync.req [tool access, broadcast]": { sent: 1, received: 0 }, "Sync.res [tool access, broadcast]": { sent: 0, received: 1 },
    });
    expect(f.undecoded).toEqual({ count: 1, lines: [4] });
  });

  test("a waiting request is opened before the next tunnel telegram, with the address known by then", () => {
    const syncReq = (n: number) => tunnel("ETS->BRIDGE", REQ, "0.0.0", 0, secured({ key: FDSK, src: "1.1.100", dst: 0, group: true, scf: 0x92, seq: seq(n), plaintext: challenge, serial: SERIAL }), 0xb0, true);
    const syncRes = tunnel("BRIDGE->ETS", IND, "15.15.255", 0, secured({ key: FDSK, src: "15.15.255", dst: 0, group: true, scf: 0x93, seq: seq(9), plaintext: Buffer.alloc(12, 1), challenge }), 0xb0, true);
    const con = tunnel("BRIDGE->ETS", CON, "1.1.100", 0, [0x03, 0xf1, 0x92], 0xb0, true);
    // Two requests before any confirmation: the first is opened when the second comes, with no address yet.
    const twice = indexed(indexText("x.log", [syncReq(1), syncReq(2), con, syncRes].join("\n"), keys()));
    expect(twice.secure.inside).toEqual({
      "Sync.req (not opened) [tool access, broadcast]": { sent: 1, received: 0 }, "Sync.req [tool access, broadcast]": { sent: 1, received: 0 },
      "Sync.res [tool access, broadcast]": { sent: 0, received: 1 },
    });
    // An answer before the confirmation: the request is opened first, still without the address, so neither opens.
    const early = indexed(indexText("x.log", [syncReq(1), syncRes, con].join("\n"), keys()));
    expect(early.secure.inside).toEqual({
      "Sync.req (not opened) [tool access, broadcast]": { sent: 1, received: 0 }, "Sync.res (not opened) [tool access, broadcast]": { sent: 0, received: 1 },
    });
  });

  test("a secured telegram shorter than its service's layout is counted as undecoded, not as one no key opens", () => {
    const f = indexed(indexText("x.log", tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x43, 0xf1, 0x92, 0, 0, 0, 0, 0, 1, 0, 0x0a]), keys()));
    expect(f.secure.inside).toEqual({ "Sync.req (truncated) [tool access]": { sent: 0, received: 1 } });
    expect(f.undecoded).toEqual({ count: 1, lines: [1] });
  });

  test("an opened telegram whose inner APDU carries transport bits is counted as undecoded", () => {
    const line = tunnel("ETS->BRIDGE", REQ, "1.1.100", iaToNum("1.1.7"), secured({ key: TOOL_KEY, src: "1.1.100", dst: iaToNum("1.1.7"), scf: 0x90, seq: seq(1), tpci: 0x43, plaintext: Buffer.from([0x43, 0x00]) }));
    const f = indexed(indexText("x.log", line, keys()));
    expect(f.secure.inside).toEqual({ "S-A_Data (inner APDU malformed) [tool access]": { sent: 1, received: 0 } });
    expect(f.undecoded).toEqual({ count: 1, lines: [1] });
  });
});

describe("the keys of the corpus", () => {
  test("come from its keyrings and projects with the passwords given, plus the environment's; one none opens is named", () => {
    const root = tempDir("capture-index-");
    try {
      for (const d of ["captures", "internal/captures", "collections"]) mkdirSync(join(root, d), { recursive: true });
      const keyring = (toolKey: Buffer, password: string) =>
        writeKeyring({ created: "2026-01-01T00:00:00", devices: [{ individualAddress: "1.1.7", toolKey }], groups: [] }, password);
      writeFileSync(join(root, "internal/captures/bench.knxkeys"), keyring(TOOL_KEY, "right"));
      writeFileSync(join(root, "collections/other.knxkeys"), keyring(OTHER_KEY, "unknown"));
      writeFileSync(join(root, "captures/run.log"), [
        tunnel("ETS->BRIDGE", REQ, "1.1.100", iaToNum("1.1.7"), secured({ key: TOOL_KEY, src: "1.1.100", dst: iaToNum("1.1.7"), scf: 0x90, seq: seq(1), tpci: 0x43, plaintext: Buffer.from([0x03, 0xd5, 0x00, 0x38, 0x10, 0x01]) })),
        tunnel("ETS->BRIDGE", REQ, "1.1.100", iaToNum("1.1.7"), secured({ key: FDSK, src: "1.1.100", dst: iaToNum("1.1.7"), scf: 0x92, seq: seq(2), tpci: 0x47, plaintext: Buffer.alloc(6, 7), serial: SERIAL })),
      ].join("\n"));
      // A password a keyring cannot hold (not printable ASCII) is passed over like a wrong one.
      const index = buildIndex(root, { passwords: ["pässword", "wrong", "right"], environment: [{ name: "bench FDSK", key: FDSK }] });
      expect(index.keys).toEqual({
        read: [{ file: "internal/captures/bench.knxkeys", deviceKeys: 1, groupKeys: 0, omitted: [] }],
        notRead: [{ file: "collections/other.knxkeys", reason: expect.stringMatching(/^KEYRING_SIGNATURE_MISMATCH: /) }],
        environment: ["bench FDSK"], deviceKeys: 2, groupKeys: 0,
      });
      const run = index.files.find((f) => f.file === "captures/run.log")!;
      expect(run.secure.shown).toBe(2);
      expect(run.secure.openedWith).toEqual(["bench FDSK", "internal/captures/bench.knxkeys tool key 1.1.7"]);
      const md = renderMarkdown(index);
      expect(md).toContain("- `internal/captures/bench.knxkeys`: 1 device, 0 group");
      expect(md).toContain("- from `CAPTURE_KEYS`: `bench FDSK`");
      expect(md).toContain("- `collections/other.knxkeys`: KEYRING_SIGNATURE_MISMATCH");
      // Nothing of a key or a plaintext reaches the index, in either case of hex or as base64.
      const written = md + JSON.stringify(index);
      for (const k of [TOOL_KEY, FDSK, OTHER_KEY]) {
        expect(written.toLowerCase()).not.toContain(k.toString("hex").slice(0, 16));
        expect(written).not.toContain(k.toString("base64").slice(0, 16));
      }
      expect(written.toLowerCase()).not.toContain("03d500381001"); // the opened A_PropertyValue_Read
      expect(written.toLowerCase()).not.toContain("070707070707"); // the Sync challenge
    } finally { removeTempDir(root); }
  });

  test("a project names the keys it holds but did not give: a device without a serial, a key that is not 16 bytes", () => {
    const root = tempDir("capture-index-");
    try {
      for (const d of ["captures", "internal/captures", "collections"]) mkdirSync(join(root, d), { recursive: true });
      // Synthetic keys: DI-1 has no serial, so the project reader gives no tool key for it; GA 1 carries 15 bytes.
      const xml = readFileSync(join(import.meta.dir, "../packages/project/test/fixtures/sample-0.xml"), "utf8")
        .replace('Hardware2ProgramRefId="M-0048_H-1_HP-1">', 'Hardware2ProgramRefId="M-0048_H-1_HP-1"><Security ToolKey="AAECAwQFBgcICQoLDA0ODw==" />')
        .replace('<GroupAddress Id="P-TEST-0_GA-1" Address="1"', '<GroupAddress Id="P-TEST-0_GA-1" Address="1" Key="AAECAwQFBgcICQoLDA0O"')
        .replace("</Installations>", '<Installation Name="Second" /></Installations>');
      writeFileSync(join(root, "captures/p.knxproj"), storeZip({ "P-TEST/0.xml": xml }));
      const index = buildIndex(root);
      expect(index.keys.read).toEqual([{
        file: "captures/p.knxproj", deviceKeys: 0, groupKeys: 0,
        omitted: ["1 unread installation(s) after the first", "the tool keys of 1 device(s) without a serial", "group key 0/0/1: 15 bytes, not 16"],
      }]);
      expect(renderMarkdown(index)).toContain("- `captures/p.knxproj`: 0 device, 0 group; not given: 1 unread installation(s) after the first, the tool keys of 1 device(s) without a serial, group key 0/0/1: 15 bytes, not 16");
    } finally { removeTempDir(root); }
  });

  test("a key the environment gives is 16 bytes of hex", () => {
    expect(parseKeyList("a=00112233445566778899aabbccddeeff, b=ffeeddccbbaa99887766554433221100")).toEqual([
      { name: "a", key: Buffer.from("00112233445566778899aabbccddeeff", "hex") }, { name: "b", key: Buffer.from("ffeeddccbbaa99887766554433221100", "hex") },
    ]);
    expect(() => parseKeyList("a=0011")).toThrow("key a is not 16 bytes of hex");
    expect(() => parseKeyList("00112233445566778899aabbccddeeff")).toThrow("key entry 1 is not name=<32 hex>");
  });
});

describe("the corpus walk", () => {
  test("reads a gzipped log, leaves out the index's own files and lists the rest in path order", () => {
    const root = tempDir("capture-index-");
    try {
      for (const d of ["captures", "internal/captures", "collections/b"]) mkdirSync(join(root, d), { recursive: true });
      const log = tunnel("Busforge->BRIDGE", REQ, "1.1.254", iaToNum("1.1.7"), [0x80], 0xbc);
      writeFileSync(join(root, "internal/captures/run.log.gz"), gzipSync(log));
      writeFileSync(join(root, "captures/a.log"), log);
      writeFileSync(join(root, "collections/b/collect.json"), "{}");
      writeFileSync(join(root, INDEX_MD), "old");
      writeFileSync(join(root, INDEX_JSON), "{}");
      const index = buildIndex(root);
      expect(index.files.map((f) => [f.file, f.tools, f.framesBuiltAs])).toEqual([
        ["captures/a.log", ["Busforge"], "Busforge"], ["internal/captures/run.log.gz", ["Busforge"], "Busforge"],
      ]);
      expect(index.notIndexed).toEqual([{ file: "collections/b/collect.json", reason: "not a telegram log (.json)" }]);
    } finally { removeTempDir(root); }
  });
});

describe("ETS 6 logs", () => {
  const at = "2026-01-01 00:00:00,000 [1] INFO  ";
  test("reads ETS's own decode, the telegram inside a secured one and its download actions", () => {
    const text = [
      `${at}Knx.Ets.ViewModel.OnlineOperations.Download.DownloadManager - StartLoadDevice(Partial) 1.1.18 Some unit`,
      `${at}Knx.Ets.Hawk.LoadDeviceTask - Begin LoadApplicationProgram 1.1.18 (PartialLoadParameters)`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send Connect_req -> 1.1.18 (hc=6)`,
      `${at}Falcon.KnxStack.LL - [#1 0] Sending Connect_req -> 1.1.18 (hc=6) succeeded`,
      `${at}Falcon.KnxStack.LL - [#1 0] Received DeviceDescriptor_Response_ind <- 1.1.18 (hc=6, S=0) DeviceDescriptor#0=07B0`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send next message from queue (age=14ms) Memory_Read_req -> 1.1.18 (hc=6, S=1)`,
      `${at}Falcon.KnxStack.LL - [#1 1] Send PropertyValue_Read_req -> 1.1.18 (hc=6, S=1) ObjectIndex=0 PID=56 NumberOfElements=1 StartIndex=1`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send Sec_req -> 1.1.18 (hc=6) SyncReq SourceSeqNr=004053896077 (encrypted)`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send Sec_req -> 1.1.18 (hc=6) SAI=A+C SeqNr=1  InnerTelegram=PropertyValue_Write_req -> 1.1.18 (hc=6, S=2) ObjectIndex=3 PID=5 NumberOfElements=1 StartIndex=1 Data=01`,
      `${at}Falcon.KnxStack.LL - [#1 0] Received GroupValue_Write_ind <- 1.1.24 -> 3/4/1 (hc=6) Value=02D0`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send IndividualAddress_Write_req -> Broadcast (hc=6) IA=1.1.206`,
      `${at}Falcon.KnxStack.LL - [#1 0] Received IndividualAddress_Response_ind <- 1.1.206 -> 0/0/0 (hc=6)`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send Sec_req -> 1.1.18 (hc=6) SAI=A+C SeqNr=2  InnerTelegram=PropertyExtValue_WriteCon_req -> 1.1.18 (hc=6, S=3) ObjectType=17 Instance=1 PID=51 Data=00`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send Sec_req -> 1.1.18 (hc=6) SAI=A+C SeqNr=3  InnerTelegram=ConfirmedRestart_req -> 1.1.18 (hc=6, S=4) EraseCode=ConfirmedRestart ChannelNumber=0`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send GroupValue_Read_req -> 1/2/3 (hc=6)`,
      `${at}Knx.Ets.ViewModel.OnlineOperations.Download.DownloadManager - StartResetDevice 1.1.18 Some unit`,
    ].join("\r\n"); // ETS writes its log on Windows
    const f = indexed(indexText("x.txt", text));
    expect(f.format).toBe("ets6log");
    expect(f.tools).toEqual(["ETS"]);
    expect(f.framesBuiltAs).toBeNull();
    expect(f.devices).toEqual([{ address: "1.1.18", descriptor0: ["07B0"] }, { address: "1.1.206", descriptor0: [] }]);
    expect(f.assigned).toEqual(["1.1.206"]);
    expect(f.properties).toEqual(["0/56", "3/5", "t17.1/51"]);
    expect(f.secure).toEqual({
      telegrams: 4, shown: 4, openedWith: [],
      inside: {
        "A_PropertyExtValue_WriteCon": { sent: 1, received: 0 }, "A_PropertyValue_Write": { sent: 1, received: 0 },
        "A_Restart (master reset)": { sent: 1, received: 0 }, "Sync.req": { sent: 1, received: 0 },
      },
    });
    expect(f.services["A_Restart (master reset)"]).toEqual({ sent: 1, received: 0 }); // the proxy reader's name for 0x381
    expect(f.services["A_GroupValue_Read"]).toEqual({ sent: 1, received: 0 });
    expect(f.services["A_PropertyValue_Write"]).toEqual({ sent: 1, received: 0 });
    expect(f.services["A_SecureService"]).toEqual({ sent: 4, received: 0 });
    expect(f.services["A_Memory_Read"]).toBeUndefined(); // the queue notice is not a telegram
    expect(f.groupAddresses).toBe(2);
    expect(f.etsActions).toEqual(["LoadApplicationProgram(PartialLoadParameters) 1.1.18", "StartLoadDevice(Partial) 1.1.18", "StartResetDevice 1.1.18"]);
    expect(f.telegrams).toBe(11);
    expect(f.undecoded.count).toBe(0);
  });

  test("names a secured telegram ETS logged encrypted, and a secured broadcast by its destination", () => {
    const text = [
      `${at}Falcon.KnxStack.LL - [#1 0] Received Sec_ind <- 1.1.203 (hc=6) SyncRes Encrypted:93DD58C5ABA4B824B89A0EED08517755284E126ECD16A4`,
      `${at}Falcon.KnxStack.LL - [#1 0] Received Sec_ind <- 1.1.203 (hc=6) SAI=A+C SeqNr=0000000E48D5  InnerTelegram=Encrypted: 44BC229A`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send Sec_req -> 0/0/0 (hc=6) SAI=A+C SeqNr=2  InnerTelegram=IndividualAddressSerialNumber_Read_req -> 0/0/0 (hc=6) SerialNumber=000A31293319`,
    ].join("\r\n");
    const f = indexed(indexText("x.txt", text));
    expect(f.secure).toEqual({
      telegrams: 3, shown: 2, openedWith: [],
      inside: {
        "A_IndividualAddressSerialNumber_Read [broadcast]": { sent: 1, received: 0 },
        "S-A_Data (not shown)": { sent: 0, received: 1 },
        "Sync.res": { sent: 0, received: 1 },
      },
    });
  });

  test("counts a link-layer line it cannot parse, and a property service naming no property", () => {
    const text = [
      `${at}Falcon.KnxStack.LL - [#1 0] Send Memory_Write_req to somewhere`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send PropertyValue_Read_req -> 1.1.18 (hc=6, S=1) Object=0 Id=56`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send Memory_Write_req`, // cut off
    ].join("\n");
    expect(indexed(indexText("x.txt", text)).undecoded).toEqual({ count: 3, lines: [1, 2, 3] });
  });

  test("names an ETS log without a telegram", () => {
    expect(refused(indexText("x.txt", `${at}Knx.Ets.ObjectModel.Persistence - persist project took 1s`))).toBe("ETS 6 log without a telegram line");
  });
});

describe("group monitors", () => {
  test("reads both listener shapes and checks the word against the telegram", () => {
    const text = [
      "2026-01-01T00:00:00.000Z connected as 1.1.100, 240s, reads: none",
      "2026-01-01T00:00:01.000Z GROUP 1.1.56 -> 0/0/21 WRITE 0081",
      "16:22:15.380 1.1.32 -> 2/0/12 00400d2d 1.1.32",
      "16:22:15.400 ANSWER 1.1.20 -> 15/7/250 0041",
      "2026-01-01T00:00:02.000Z GROUP 1.1.56 -> 0/0/21 READ 0081", // a write, not a read
      "RESULT 0/2/15 1.1.55 0040", // sums up an answer logged above
      "18:07:00.527 read 15/7/250 con OK",
      "2026-01-01T00:00:03.000Z SEND READ 1/3/2",
      "18:07:01.000 read 3/5/2 con NOK",
      "17:46:06.753 pulse 3/5/9 con OK", // names no service
      "00:00:01 GROUP 1.1.7 -> 0/0/2 WRITE 00ZZ", // not hex
      "00:00:02 GROUP 1.1.7 -> 0/0/1 WRITE 8081", // transport control, not group data
      "09:18:13 read before -> /some/path.json", // a note
    ].join("\n");
    const f = indexed(indexText("x.log", text));
    expect(f.format).toBe("groupmonitor");
    expect(f.tools).toEqual([]);
    expect(f.services).toEqual({
      A_GroupValue_Read: { sent: 3, received: 0 }, A_GroupValue_Response: { sent: 0, received: 2 }, A_GroupValue_Write: { sent: 0, received: 1 },
    });
    expect(f.notOnBus).toBe(1);
    expect(f.groupAddresses).toBe(7);
    expect(f.undecoded).toEqual({ count: 4, lines: [5, 10, 11, 12] });
  });
});

describe("files no reader takes", () => {
  test("are named with the reason", () => {
    const proxy = tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x80]);
    expect(refused(indexText("x.log", `${proxy}\n2026-01-01T00:00:01.000Z GROUP 1.1.56 -> 0/0/21 0081`))).toBe("mixed formats (groupmonitor, knxproxy): no single reader applies");
    expect(refused(indexText("x.lines", "4 REQ 1.1.100 1.1.201 apci=0x300"))).toBe("telegram-like lines in a format no reader here takes");
    expect(refused(indexText("x.txt", "12:11:02.190 -> T_CONNECT"))).toBe("telegram-like lines in a format no reader here takes");
    expect(refused(indexText("x.out", "memory: 2691 / 2691 bytes, 0 differ"))).toBe("text without telegram lines");
    expect(refused(indexFile("/nonexistent", "a/collect.json"))).toBe("not a telegram log (.json)");
    expect(refused(indexFile("/nonexistent", "a/gone.log"))).toStartWith("unreadable: ");
  });

  test("an APCI the standard table does not name is shown as its number", () => {
    expect(apciName(0x3c5)).toBe("apci 0x3c5");
    expect(apciName(0x24a)).toBe("A_Memory_Response");
    expect(apciName(0x1c8)).toBe("A_SystemNetworkParameter_Read");
    expect(apciName(0x1c3)).toBe("A_ADC_Response");
    expect(apciName(0x1d1)).toBe("apci 0x1d1"); // in the extended services' range, not an ADC channel
  });
});

// ETS's own log of a download and the proxy capture of the same download, read by the two readers: the
// services ETS sent agree, so the proxy decode counts what ETS says it did.
corpusDescribe("the proxy decode against ETS's own log of the same download", () => {
  for (const [proxy, own] of [
    ["auro-m0081-ets-fulldownload.log", "auro-m0081-ets6log-fulldownload.txt"],
    ["auro-m0081-ets-partial-links.log", "auro-m0081-ets6log-partial-links.txt"],
    ["theluxa-p300-ets-fulldownload.log", "theluxa-p300-ets6log-fulldownload.txt"],
    ["theluxa-p300-ets-partial-params.log", "theluxa-p300-ets6log-partial-params.txt"],
  ]) {
    test(proxy, () => {
      const sent = (f: IndexedFile) => Object.fromEntries(Object.entries(f.services).filter(([n, c]) => n.startsWith("A_") && c.sent > 0).map(([n, c]) => [n, c.sent]));
      const a = indexed(indexText(proxy, captureText(proxy))), b = indexed(indexText(own, captureText(own)));
      expect(a.undecoded.count).toBe(0);
      expect(b.undecoded.count).toBe(0);
      expect(a.framesBuiltAs).toBe("ETS");
      expect(Object.keys(sent(a)).length).toBeGreaterThan(3);
      expect(sent(a)).toEqual(sent(b));
      expect(a.devices.filter((d) => d.descriptor0.length)).toEqual(b.devices.filter((d) => d.descriptor0.length));
    });
  }
});

// bussard's synthetic secure captures (MIT, Tom Bocklisch) come with the keyring of their project, under the public
// password its oracle rows name: every secured telegram ETS sent and the simulator answered opens with it.
corpusDescribe("a secure ETS capture opened with the keyring beside it", () => {
  const dir = `${BUSSARD_SYNTHETIC_DIR}/captures/syn-secure/apply`;
  corpusTest(dir, () => {
    for (const f of [BUSSARD_ROWS, `${dir}/project.knxkeys`, `${dir}/ets.pcapng`]) corpusPath(f);
    const root = corpusRoot()!;
    const load = corpusKeys(root, [`${dir}/project.knxkeys`], documentedKeyringPasswords(root));
    expect(load.notRead).toEqual([]);
    expect(load.read).toEqual([{ file: `${dir}/project.knxkeys`, deviceKeys: 2, groupKeys: 3, omitted: [] }]);
    const f = indexed(indexFile(root, `${dir}/ets.pcapng`, load.keys));
    expect(f.undecoded.count).toBe(0);
    expect(f.secure.telegrams).toBeGreaterThan(50);
    expect(f.secure.shown).toBe(f.secure.telegrams);
    expect(f.secure.openedWith).toEqual([`${dir}/project.knxkeys tool key 1.1.1`]);
    expect(Object.keys(f.secure.inside).filter((s) => s.includes("not opened"))).toEqual([]);
    // ETS's secured load: a Sync, then the load-state machine and the tables through the extended property services.
    for (const s of ["Sync.req [tool access]", "Sync.res [tool access]", "A_PropertyExtValue_WriteCon [tool access]", "A_MemoryExtended_Write [tool access]"]) {
      expect((f.secure.inside[s]?.sent ?? 0) + (f.secure.inside[s]?.received ?? 0)).toBeGreaterThan(0);
    }
  });
});

describe("property answers", () => {
  test("are recorded per property, unit and element count, with the error octet, and queried across files", () => {
    const proxy = indexed(indexText("p.log", [
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x43, 0x40, 0x07, 0x05]), // descriptor 0: 0705
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x43, 0xd6, 0x00, 0x38, 0x00, 0x01]), // 0/56, no element
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x47, 0xd6, 0x00, 0x38, 0x00, 0x01]), // the same again
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x4b, 0xd6, 0x00, 0x0b, 0x00, 0x01, 0x07]), // 0/11, no element, error octet
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x4f, 0xd6, 0x00, 0x38, 0x10, 0x01, 0x00, 0xf8]), // 0/56, one element
      tunnel("BRIDGE->ETS", IND, "1.1.7", iaToNum("1.1.100"), [0x51, 0xcd, 0x00, 0x11, 0x00, 0x10, 0x33, 0x00, 0x00, 0x01, 0x07]), // t17.1/51, error code
    ].join("\n")));
    expect(proxy.undecoded.count).toBe(0);
    expect(proxy.propertyAnswers).toEqual([
      { property: "0/11", device: "1.1.7", elements: 0, errorOctet: true, count: 1 },
      { property: "0/56", device: "1.1.7", elements: 0, errorOctet: false, count: 2 },
      { property: "0/56", device: "1.1.7", elements: 1, errorOctet: false, count: 1 },
      { property: "t17.1/51", device: "1.1.7", elements: 0, errorOctet: true, count: 1 },
    ]);
    const at = "2026-01-01 00:00:00,000 [1] INFO  Falcon.KnxStack.LL - [#1 0] ";
    const ets = indexed(indexText("e.txt", [
      `${at}Received PropertyValue_Response_ind <- 1.1.18 (hc=6, S=1) ObjectIndex=0 PID=56 NumberOfElements=0 StartIndex=1 Data=`,
      `${at}Received PropertyExtValue_Response_ind <- 1.1.90 (hc=6, S=6) ObjectType=11 Instance=1 PID=64 NumberOfElements=1 StartIndex=1 Data=00FF 01`,
      `${at}Received PropertyValue_Response_ind <- 1.1.18 (hc=6, S=2) ObjectIndex=0 PID=56 NumberOfElements=1`, // no data field
      `${at}Received PropertyValue_Response_ind <- 1.1.18 (hc=6, S=3) ObjectIndex=0 PID=56 NumberOfElements=0 StartIndex=1 Data=ZZ`, // not hex
    ].join("\r\n")));
    expect(ets.propertyAnswers).toEqual([
      { property: "0/56", device: "1.1.18", elements: 0, errorOctet: false, count: 1 },
      { property: "t11.1/64", device: "1.1.90", elements: 1, errorOctet: false, count: 1 },
    ]);
    expect(ets.undecoded).toEqual({ count: 2, lines: [3, 4] });
    // Another capture whose unit 1.1.7 shows descriptor 0 07B0: the same address is another unit there.
    const other = indexed(indexText("q.log", [
      tunnel("BRIDGE->Busforge", IND, "1.1.7", iaToNum("1.1.254"), [0x43, 0x40, 0x07, 0xb0], 0xbc),
      tunnel("BRIDGE->Busforge", IND, "1.1.7", iaToNum("1.1.254"), [0x47, 0xd6, 0x00, 0x38, 0x00, 0x01], 0xbc),
    ].join("\n")));
    const index: CaptureIndex = {
      format: INDEX_FORMAT, dirs: ["captures"], keys: NO_KEYS, files: [proxy, ets, other],
      notIndexed: [{ file: "a.json", reason: "not a telegram log (.json)" }, { file: "b.lines", reason: "telegram-like lines in a format no reader here takes" }],
    };
    const rows = propertyAnswerRows(index, ["0/56", "t3.1/9"]);
    expect(rows).toEqual([
      { property: "0/56", elements: 0, errorOctet: false, device: "1.1.7", descriptor0: "0705", tool: "ETS", answers: 2, files: ["p.log"] },
      { property: "0/56", elements: 0, errorOctet: false, device: "1.1.7", descriptor0: "07B0", tool: "Busforge", answers: 1, files: ["q.log"] },
      { property: "0/56", elements: 0, errorOctet: false, device: "1.1.18", descriptor0: "?", tool: "ETS", answers: 1, files: ["e.txt"] },
      { property: "0/56", elements: 1, errorOctet: false, device: "1.1.7", descriptor0: "0705", tool: "ETS", answers: 1, files: ["p.log"] },
    ]);
    const md = renderPropertyAnswers(rows, ["0/56", "t3.1/9"], propertyAnswersUnseen(index));
    expect(md).toContain("| 0/56 | 0 | no | 1.1.7 | 0705 | ETS | 2 | `p.log` |");
    expect(md).toContain("No answer of t3.1/9 in the index.");
    // the ETS log lines without a readable data field are what the query cannot see
    expect(md).toContain("Not in the table: 0 secured telegrams whose service is not shown (not opened, ETS logged encrypted); 2 undecoded lines in 1 files (truncated secured telegrams among them); 1 files that may hold telegrams but no reader here takes; 0 projects and keyrings not read, so their keys were missing.");
    // every answer of the three files: four rows of p.log, two of e.txt, one of q.log
    expect(propertyAnswerRows(index)).toHaveLength(7);
    expect(() => propertyAnswerRows(index, ["0/056", "t17.01/51", "--x"])).toThrow("not a property as the index names it (<object index>/<PID>, t<type>.<instance>/<PID>): 0/056, t17.01/51, --x");
  });
});
