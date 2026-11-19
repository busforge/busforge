import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { iaToNum } from "../packages/knx/src/index.ts";
import { apciName, buildIndex, indexFile, indexText, INDEX_JSON, INDEX_MD, labelDisagrees, PCAP_CLIENT, renderMarkdown, type IndexedFile, type NotIndexed } from "./capture-index.ts";
import { captureText } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";

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
      tunnel("ETS->BRIDGE", REQ, "0.0.0", iaToNum("1.1.7"), [0x4f, 0xf1, 0x10]),                   // A_SecureService
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
    expect(f.secure).toEqual({ telegrams: 1, innerShown: 0 });
    expect(f.telegrams).toBe(9); // the confirmation repeats the request and is not counted
    expect(f.undecoded.count).toBe(0);
  });

  test("tells a Busforge run from the label the proxy gave it", () => {
    const text = tunnel("ETS->BRIDGE", REQ, "1.1.100", iaToNum("1.1.7"), [0x80], 0xbc);
    const f = indexed(indexText("x.log", text));
    expect(f.tools).toEqual(["ETS"]);
    expect(f.framesBuiltAs).toBe("Busforge");
    expect(labelDisagrees(f)).toBe(true);
    expect(renderMarkdown({ format: "busforge-capture-index/1", dirs: ["captures"], files: [f], notIndexed: [] }))
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
    const dir = mkdtempSync(join(tmpdir(), "capture-index-"));
    try {
      writeFileSync(join(dir, "ets.pcapng"), bytes);
      const f = indexed(indexFile(dir, "ets.pcapng"));
      expect(f.format).toBe("pcap");
      expect(f.tools).toEqual([PCAP_CLIENT]);
      expect(f.framesBuiltAs).toBe("ETS");
      expect(labelDisagrees(f)).toBe(false);
      expect(f.services).toEqual({ T_Connect: { sent: 1, received: 0 } });
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("its refusal is the reason a capture is not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-index-"));
    try {
      writeFileSync(join(dir, "x.pcap"), pcap([{ fromServer: false, payload: tunnelFrame(REQ, "0.0.0", iaToNum("1.1.7"), [0x80]) }]));
      expect(refused(indexFile(dir, "x.pcap"))).toStartWith("pcap capture tools/pcap.ts refuses: no datagram carries a server's answer");
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe("the corpus walk", () => {
  test("reads a gzipped log, leaves out the index's own files and lists the rest in path order", () => {
    const root = mkdtempSync(join(tmpdir(), "capture-index-"));
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
    } finally { rmSync(root, { recursive: true }); }
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
    expect(f.secure).toEqual({ telegrams: 4, innerShown: 3 });
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

  test("counts a link-layer line it cannot parse, and a property service naming no property", () => {
    const text = [
      `${at}Falcon.KnxStack.LL - [#1 0] Send Memory_Write_req to somewhere`,
      `${at}Falcon.KnxStack.LL - [#1 0] Send PropertyValue_Read_req -> 1.1.18 (hc=6, S=1) Object=0 Id=56`,
    ].join("\n");
    expect(indexed(indexText("x.txt", text)).undecoded).toEqual({ count: 2, lines: [1, 2] });
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
    ].join("\n");
    const f = indexed(indexText("x.log", text));
    expect(f.format).toBe("groupmonitor");
    expect(f.tools).toEqual([]);
    expect(f.services).toEqual({
      A_GroupValue_Read: { sent: 3, received: 0 }, A_GroupValue_Response: { sent: 0, received: 2 }, A_GroupValue_Write: { sent: 0, received: 1 },
    });
    expect(f.notOnBus).toBe(1);
    expect(f.groupAddresses).toBe(6);
    expect(f.undecoded).toEqual({ count: 2, lines: [5, 10] });
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
