import { test, expect, describe } from "bun:test";
import { KnxUsbTransport } from "../src/usb.ts";
import { KnxError } from "../src/errors.ts";
import { cemiLData, iaToNum } from "../src/frame.ts";

// Offline tests for KnxUsbTransport against a fake node-hid device. Every
// expected byte below is hand-derived from usb.ts's constants and builders:
//   REPORT_ID       = 0x01
//   PACKET_SINGLE   = 0x13  (packet info: high nibble = sequence 1,
//                            low nibble = packet type 3 = start|end)
//   transfer header = [PROTO_VERSION 0x00, HEADER_LEN 0x08,
//                      body length u16 BE, protocol id, EMI/service id,
//                      manufacturer u16 = 0x0000]
//   PROTO_KNX_TUNNEL = 0x01, PROTO_BUS_ACCESS = 0x0f, EMI_CEMI = 0x03
//   LDATA_CON        = 0x2e (cEMI message code)

// Mirrors usb.ts's HidDevice interface (the surface node-hid exposes):
// on("data"/"error", cb), write(number[]): number, close().
class FakeHidDevice {
  writes: number[][] = [];
  // The interface's cEMI server: its communication mode decides whether an L_Data.req is put
  // on the bus at all. A real Weinzierl/ABB 147b:5120 comes up UNSET (0xff), which is why
  // connect() has to establish Data Link Layer mode (0x00). See usb.ts enterDataLinkLayer.
  commMode = 0xff;
  acceptsCommMode = true;
  // The interface's own identity in its Device Object, here 1.2.250 (a real stick holds whatever
  // address it was given). publishesIdentity=false mimics an interface that does not expose it.
  publishesIdentity = true;
  subnet = 0x12;
  deviceAddr = 0xfa;
  serial = Buffer.from([0x00, 0xc5, 0x01, 0x02, 0x03, 0x04]);
  private dataCb: ((d: Buffer) => void) | null = null;
  on(ev: "data" | "error", cb: (arg: never) => void): void {
    if (ev === "data") this.dataCb = cb as unknown as (d: Buffer) => void;
  }
  write(d: number[]): number {
    this.writes.push(d);
    // Auto-answer the FEAT_GET(ACTIVE_EMI) that connect() sends, otherwise
    // connect() sits in the 2 s feature timeout. In the outgoing report the
    // transfer header starts at byte 3, so d[7] = protocol id and
    // d[8] = service id; FEAT_GET is protocol 0x0f service 0x01.
    if (d[7] === 0x0f && d[8] === 0x01) this.dataCb?.(featResponseReport());
    // Local device management (protocol 0x01 = KNX tunnel, but a cEMI M_Prop* message code):
    // the cEMI body starts at byte 11. Answer the comm-mode property the transport reads/writes.
    if (d[7] === 0x01 && (d[11] === 0xfc || d[11] === 0xf6)) this.dataCb?.(this.propAnswer(d));
    return d.length;
  }
  // M_PropRead.con (0xfb) / M_PropWrite.con (0xf5): echo IOT | OI | PID | nrOfElem+startIndex,
  // then the value (read) or nothing (write). A refusal is signalled by a ZERO element count.
  private propAnswer(d: number[]): Buffer {
    const [code, iotHi, iotLo, oi, pid] = [d[11], d[12], d[13], d[14], d[15]];
    const refused = Buffer.from([0xfb, iotHi, iotLo, oi, pid, 0x00, 0x01, 0x07]); // zero element count
    if (code === 0xf6) { // write
      if (!this.acceptsCommMode) return tunnelReport(Buffer.from([0xf5, iotHi, iotLo, oi, pid, 0x00, 0x01, 0x08])); // refused
      this.commMode = d[18];
      return tunnelReport(Buffer.from([0xf5, iotHi, iotLo, oi, pid, 0x10, 0x01]));
    }
    const read = (value: number[]) => tunnelReport(Buffer.from([0xfb, iotHi, iotLo, oi, pid, 0x10, 0x01, ...value]));
    // Device Object (IOT 0): the interface's own identity. cEMI Server Object (IOT 8): its mode.
    if (iotLo === 0x00) {
      if (!this.publishesIdentity) return tunnelReport(refused);
      if (pid === 57) return read([this.subnet]);
      if (pid === 58) return read([this.deviceAddr]);
      if (pid === 11) return read([...this.serial]);
      return tunnelReport(refused);
    }
    return read([this.commMode]);
  }
  close(): void {}
  inject(report: Buffer): void {
    this.dataCb!(report);
  }
}

// Like FakeHidDevice but never answers FEAT_GET (it throws on that write instead), so
// connect()'s feature handshake fails fast and the transport comes up with rxExpected==0
// (no frame ever completed). Mirrors a real interface that does not implement the Bus
// Access feature service, which connect() explicitly tolerates.
class FeatureLessHidDevice extends FakeHidDevice {
  write(d: number[]): number {
    if (d[7] === 0x0f && d[8] === 0x01) throw new Error("no feature service"); // FEAT_GET rejects
    return super.write(d); // cEMI device management is a separate service; it still answers that
  }
}

// node-hid module fake: new HID(...) returns the given device regardless of
// path/vid/pid form (a JS constructor may return any object).
function fakeHidModule(dev: FakeHidDevice) {
  const HID = function () {
    return dev;
  } as unknown as { new (path: string): FakeHidDevice; new (vid: number, pid: number): FakeHidDevice };
  return { HID, devices: () => [] };
}

// Wrap raw report bytes into a full 64-byte HID report buffer.
function report(bytes: number[]): Buffer {
  const r = Buffer.alloc(64, 0);
  Buffer.from(bytes).copy(r, 0);
  return r;
}

// Feature response for FEAT_GET(FEAT_ACTIVE_EMI 0x05) -> value cEMI (0x03):
//   [0] 0x01 report id
//   [1] 0x13 packet info (seq 1, start|end)
//   [2] 0x0a data length = 8 header + 2 body
//   [3] 0x00 protocol version, [4] 0x08 header length
//   [5..6] 0x00 0x02 body length 2
//   [7] 0x0f PROTO_BUS_ACCESS, [8] 0x02 FEAT_RESPONSE, [9..10] manufacturer 0
//   [11] 0x05 feature id ACTIVE_EMI, [12] 0x03 EMI_CEMI
function featResponseReport(): Buffer {
  return report([0x01, 0x13, 0x0a, 0x00, 0x08, 0x00, 0x02, 0x0f, 0x02, 0x00, 0x00, 0x05, 0x03]);
}

// Wrap a cEMI into a single (start|end) KNX tunnelling report, mirroring the
// framing usb.ts itself emits: 3-byte HID header + 8-byte transfer header.
function tunnelReport(cemi: Buffer): Buffer {
  return report([
    0x01, // report id
    0x13, // packet info: seq 1, start|end
    8 + cemi.length, // data length: transfer header + cEMI
    0x00, 0x08, // protocol version, header length
    (cemi.length >> 8) & 0xff, cemi.length & 0xff, // body length u16 BE
    0x01, 0x03, // PROTO_KNX_TUNNEL, EMI_CEMI
    0x00, 0x00, // manufacturer
    ...cemi,
  ]);
}

async function connected() {
  const dev = new FakeHidDevice();
  const t = new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev));
  await t.connect(); // FEAT_SET + FEAT_GET, then the comm-mode read/write/read
  expect(dev.commMode).toBe(0x00); // connect() put the interface into Data Link Layer mode
  dev.writes.length = 0; // only look at traffic after the connect handshake
  return { dev, t };
}

// sendCemi now queues (sends are serialised so their single L_Data.con cannot be clobbered by an
// overlapping send), so the actual transfer runs one microtask later. Flush it before injecting the
// con the transfer is waiting for. A macrotask tick drains every pending microtask deterministically.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("KnxUsbTransport", () => {
  test("sendCemi frames the cEMI into one 64-byte HID report", async () => {
    const { dev, t } = await connected();
    // cemiLData(0, 1.2.7, [0x80]) = T_Connect from source 0.0.0 (the
    // interface substitutes its own IA):
    //   11 00 bc 60 00 00 12 07 00 80   (10 bytes)
    const cemi = cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]));
    const p = t.sendCemi(cemi);
    await flush();
    // resolve the pending L_Data.con wait (con handling proven separately)
    dev.inject(tunnelReport(Buffer.from([0x2e, ...cemi.subarray(1)])));
    await p;

    expect(dev.writes.length).toBe(1);
    const r = dev.writes[0]!;
    expect(r.length).toBe(64);
    // HID report header
    expect(r[0]).toBe(0x01); // REPORT_ID
    expect(r[1]).toBe(0x13); // PACKET_SINGLE: sequence 1, packet type start|end
    expect(r[2]).toBe(18); // data length = 8 transfer header + 10 cEMI
    // KNX USB Transfer Protocol header
    expect(r[3]).toBe(0x00); // protocol version 0
    expect(r[4]).toBe(0x08); // header length 8
    expect(r[5]).toBe(0x00); // body length hi
    expect(r[6]).toBe(0x0a); // body length lo = 10 (the cEMI)
    expect(r[7]).toBe(0x01); // protocol id: KNX tunnel (body is EMI/cEMI)
    expect(r[8]).toBe(0x03); // EMI id: cEMI
    expect(r[9]).toBe(0x00); // manufacturer hi
    expect(r[10]).toBe(0x00); // manufacturer lo
    // body = the cEMI, then zero padding to 64
    expect(Buffer.from(r.slice(11, 21)).equals(cemi)).toBe(true);
    expect(r.slice(21).every((b) => b === 0)).toBe(true);
  });

  test("single-report L_Data.ind reaches onCemi with src/dst/tpdu", async () => {
    const { dev, t } = await connected();
    const calls: { src: number; dst: number; tpdu: Buffer; isGroup: boolean }[] = [];
    t.onCemi = (src, dst, tpdu, isGroup) => calls.push({ src, dst, tpdu, isGroup });

    // L_Data.ind: 29 00 bc 60 | src 12 07 (1.2.7) | dst 11 05 (1.1.5) |
    // len 03 | tpdu 42 40 00 00 (len byte = tpdu.length - 1)
    const tpdu = Buffer.from([0x42, 0x40, 0x00, 0x00]);
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0x60, 0x12, 0x07, 0x11, 0x05, 0x03, ...tpdu]);
    dev.inject(tunnelReport(cemi));

    expect(calls.length).toBe(1);
    expect(calls[0]!.src).toBe(iaToNum("1.2.7"));
    expect(calls[0]!.dst).toBe(iaToNum("1.1.5"));
    expect(calls[0]!.isGroup).toBe(false);
    expect(calls[0]!.tpdu.equals(tpdu)).toBe(true);
  });

  test("multi-report frame is reassembled into exactly one onCemi", async () => {
    const { dev, t } = await connected();
    const calls: Buffer[] = [];
    t.onCemi = (_s, _d, tpdu) => calls.push(tpdu);

    // A 70-byte cEMI (9-byte L_Data head + 61-byte TPDU) does not fit one
    // report (max data 61 = 8 header + 53 cEMI), so split 53 + 17.
    const tpdu = Buffer.alloc(61);
    tpdu[0] = 0x42;
    tpdu[1] = 0x40;
    for (let i = 2; i < 61; i++) tpdu[i] = i;
    const cemi = Buffer.concat([
      Buffer.from([0x29, 0x00, 0xbc, 0x60, 0x12, 0x07, 0x11, 0x05, 60]), // len byte = 61-1
      tpdu,
    ]);
    expect(cemi.length).toBe(70);

    // Start report: packet info 0x15 = seq 1, type 5 (start|partial).
    // Data = 8-byte transfer header (body length 70 = 0x0046) + cemi[0..53).
    const start = report([
      0x01, 0x15, 61,
      0x00, 0x08, 0x00, 0x46, 0x01, 0x03, 0x00, 0x00,
      ...cemi.subarray(0, 53),
    ]);
    // End report: packet info 0x26 = seq 2, type 6 (end|partial).
    // Data = remaining cemi[53..70) (17 bytes), no transfer header.
    const end = report([0x01, 0x26, 17, ...cemi.subarray(53)]);

    dev.inject(start);
    expect(calls.length).toBe(0); // start alone must not deliver
    dev.inject(end);
    expect(calls.length).toBe(1);
    expect(calls[0]!.equals(tpdu)).toBe(true);
  });

  test("an orphan continuation with no start in progress (rxExpected==0) is dropped, not parsed", async () => {
    // Bring the transport up against an interface that never answers FEAT_GET, so the
    // feature handshake fails and no frame ever completes: rxExpected stays 0. This is
    // the reachable-in-production precondition (an interface without the feature service),
    // and the one the old code got wrong: with rxExpected==0 it appended the orphan and
    // delivered it, since rx.length(>=1) >= 0 is always true, handing a bogus body to
    // handleTransfer (byte 4 read as protocol id, subarray(8) as an empty cEMI -> a
    // garbage onCemi). Guarded now: a continuation with no start in progress returns early.
    const dev = new FeatureLessHidDevice();
    const t = new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev));
    await t.connect(); // FEAT_GET throws -> handshake caught -> up with rxExpected 0
    const calls: Buffer[] = [];
    t.onCemi = (_s, _d, tpdu) => calls.push(tpdu);

    // end-packet (type 6), no preceding start (type 1/5): protocol id byte would be 0x01.
    dev.inject(report([0x01, 0x26, 5, 0xde, 0xad, 0xbe, 0xef, 0x01]));
    expect(calls.length).toBe(0);

    // And a well-formed frame afterwards still reassembles normally (the guard only drops
    // orphans, it does not wedge the receiver).
    const tpdu = Buffer.from([0x42, 0x40, 0x00, 0x00]);
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0x60, 0x12, 0x07, 0x11, 0x05, 0x03, ...tpdu]);
    dev.inject(tunnelReport(cemi));
    expect(calls.length).toBe(1);
    expect(calls[0]!.equals(tpdu)).toBe(true);
  });

  test("sendCemi resolves on L_Data.con, and the con is not surfaced via onCemi", async () => {
    const { dev, t } = await connected();
    const calls: Buffer[] = [];
    t.onCemi = (_s, _d, tpdu) => calls.push(tpdu);

    const cemi = cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]));
    let resolved = false;
    const p = t.sendCemi(cemi).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // still waiting for the con

    // L_Data.con = same frame with message code 0x2e
    dev.inject(tunnelReport(Buffer.from([0x2e, ...cemi.subarray(1)])));
    await p;
    expect(resolved).toBe(true);
    expect(calls.length).toBe(0); // con consumed internally, not delivered
  });

  // The one deliberately slow test: with no L_Data.con within ~1.5 s the interface never
  // confirmed the frame reached the bus, so sendCemi REJECTS with a coded error rather than
  // resolving (a silent success would resurface one layer up as a misleading timeout).
  test("sendCemi rejects with a coded error after ~1.5 s when no con arrives", async () => {
    const { dev, t } = await connected();
    const cemi = cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]));
    const t0 = Date.now();
    const err = await t.sendCemi(cemi).catch((e) => e);
    const dt = Date.now() - t0;
    expect(err).toBeInstanceOf(KnxError);
    expect(err.code).toBe("USB_SEND_NOT_CONFIRMED");
    expect(dt).toBeGreaterThanOrEqual(1400);
    expect(dt).toBeLessThan(3000);
    expect(dev.writes.length).toBe(1); // the report still went out before we gave up
  }, 5000);
});

describe("Data Link Layer mode (what makes the interface actually transmit)", () => {
  // HARDWARE-FOUND. A Weinzierl/ABB 147b:5120 comes up with its cEMI server's communication
  // mode UNSET (reads 0xff). In that state it accepts every L_Data.req, confirms nothing, and
  // puts nothing on the bus: no error anywhere, the frame simply evaporates. It is exactly why
  // this transport had never once reached a real device. Setting the mode is what fixed it (the
  // first L_Data.con this transport ever saw arrived immediately after that write), and it is
  // what the reference stack does too (calimero KNXNetworkLinkUsb.linkLayerMode()).

  test("connect() puts an UNSET interface into Data Link Layer mode", async () => {
    const dev = new FakeHidDevice();
    expect(dev.commMode).toBe(0xff); // as the real interface comes up
    await new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev)).connect();
    expect(dev.commMode).toBe(0x00); // Data Link Layer: "put my frames on the bus"

    // and it did so by writing the cEMI server object's comm-mode property (IOT 8, PID 52)
    const propWrite = dev.writes.find((w) => w[7] === 0x01 && w[11] === 0xf6);
    expect(propWrite).toBeDefined();
    expect(propWrite!.slice(12, 16)).toEqual([0x00, 0x08, 0x01, 0x34]); // IOT 8, instance 1, PID 52
    expect(propWrite![18]).toBe(0x00); // the value: Data Link Layer
  });

  test("an interface already in Data Link Layer mode is left alone", async () => {
    const dev = new FakeHidDevice();
    dev.commMode = 0x00; // already transmitting
    await new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev)).connect();
    expect(dev.writes.some((w) => w[7] === 0x01 && w[11] === 0xf6)).toBe(false); // no write needed
    expect(dev.commMode).toBe(0x00);
  });

  test("an interface that REFUSES the mode is refused right back, not used", async () => {
    // The alternative is a transport that swallows everything written to it while every layer
    // above reports "device not answering". Refuse to connect instead.
    const dev = new FakeHidDevice();
    dev.acceptsCommMode = false;
    const err = await new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev)).connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("USB_LINK_LAYER_UNAVAILABLE");
  });

  test("a device-management confirmation is never delivered as a bus telegram", async () => {
    // M_PropRead.con is about the INTERFACE, not the bus. Handing it to the L_Data parser would
    // read its property header as a source/destination address and invent a phantom telegram.
    const dev = new FakeHidDevice();
    const t = new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev));
    await t.connect();
    const seen: number[] = [];
    t.onCemi = (src) => { seen.push(src); };
    dev.inject(tunnelReport(Buffer.from([0xfb, 0x00, 0x08, 0x01, 0x34, 0x10, 0x01, 0x00]))); // M_PropRead.con
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]);
  });
});

describe("KnxUsbTransport: what the interface says about our frames", () => {
  test("connect() learns the interface's own address and serial from its Device Object", async () => {
    const { t } = await connected();
    // A real stick answers its own address here. Before this read the field was hardcoded to 0,
    // which is fine for SENDING (the interface substitutes its address) but is not an address a
    // KNXnet/IP server can hand to a tunnelling client.
    expect(t.assignedIa).toBe(iaToNum("1.2.250"));
    expect([...t.serialNumber]).toEqual([0x00, 0xc5, 0x01, 0x02, 0x03, 0x04]);
  });

  test("an interface that does not publish its address leaves it at 0 and still sends", async () => {
    const dev = new FakeHidDevice();
    dev.publishesIdentity = false;
    const t = new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev));
    await t.connect(); // must NOT throw: every path that predates the identity read sends from 0.0.0
    expect(t.assignedIa).toBe(0);

    const cemi = cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]));
    const p = t.sendCemi(cemi);
    await flush();
    dev.inject(tunnelReport(Buffer.from([0x2e, ...cemi.subarray(1)])));
    await p; // and it still works
  });

  test("a NEGATIVE L_Data.con is a failure, not a send that quietly went nowhere", async () => {
    const { dev, t } = await connected();
    const cemi = cemiLData(0, iaToNum("1.2.3"), Buffer.from([0x80]));

    const p = t.sendCemi(cemi);
    await flush();
    // The interface tried and failed: same frame, message code 0x2e, confirm bit SET in ctrl1.
    // A real one sends this when the line is dead or nothing acknowledged the telegram.
    const ctrl1 = cemi[2]! | 0x01;
    dev.inject(tunnelReport(Buffer.from([0x2e, cemi[1]!, ctrl1, ...cemi.subarray(3)])));

    // Treating this as success (which the transport used to do) turns a dead bus into a bus full
    // of silent devices: every read then reports "device not answering" and the diagnosis lands on
    // the device instead of on the cable. Hardware-observed on the bench.
    let refusal: unknown;
    try { await p; } catch (e) { refusal = e; }
    expect(refusal).toBeInstanceOf(KnxError);
    expect((refusal as KnxError).code).toBe("BUS_SEND_FAILED");
  });

  test("a POSITIVE L_Data.con still resolves", async () => {
    const { dev, t } = await connected();
    const cemi = cemiLData(0, iaToNum("1.2.3"), Buffer.from([0x80]));
    const p = t.sendCemi(cemi);
    await flush();
    dev.inject(tunnelReport(Buffer.from([0x2e, ...cemi.subarray(1)]))); // ctrl1 0xbc: confirm bit clear
    await p;
  });

  // Sends are serialised through a single-slot con wait, so a FAILED send must not wedge the queue:
  // the next send has to run and confirm normally. (If the chain caught nothing, one negative con
  // would freeze the whole transport.)
  test("a failed send does not block the next one", async () => {
    const { dev, t } = await connected();
    const a = cemiLData(0, iaToNum("1.2.3"), Buffer.from([0x80]));
    const pa = t.sendCemi(a);
    await flush();
    // negative con: send A rejects
    dev.inject(tunnelReport(Buffer.from([0x2e, a[1]!, a[2]! | 0x01, ...a.subarray(3)])));
    await pa.catch(() => {});

    const b = cemiLData(0, iaToNum("1.2.4"), Buffer.from([0x80]));
    const pb = t.sendCemi(b);
    await flush();
    dev.inject(tunnelReport(Buffer.from([0x2e, ...b.subarray(1)]))); // positive con
    await pb; // resolves: the queue survived A's failure
  });
});

// node-hid fake that records how the transport opened the device, over a given enumeration.
function enumeratingHid(list: { vendorId: number; productId: number; serialNumber?: string; path?: string }[]) {
  const opened: unknown[][] = [];
  const HID = function (...args: unknown[]) {
    opened.push(args);
    return new FakeHidDevice();
  } as unknown as { new (path: string): FakeHidDevice; new (vid: number, pid: number): FakeHidDevice };
  return { opened, hid: { HID, devices: () => list } };
}

describe("KnxUsbTransport: which of several identical interfaces it opens", () => {
  const twins = [
    { vendorId: 0x147b, productId: 0x5120, serialNumber: "000200000074", path: "/dev/hidraw0" },
    { vendorId: 0x147b, productId: 0x5120, serialNumber: "000200000075", path: "/dev/hidraw1" },
  ];

  test("opens the interface whose serial the connection names, by its path", async () => {
    const { opened, hid } = enumeratingHid(twins);
    await new KnxUsbTransport({ vendorId: 0x147b, productId: 0x5120, serial: "000200000075" }, hid).connect();
    expect(opened).toEqual([["/dev/hidraw1"]]);
  });

  test("refuses two identical interfaces it cannot tell apart, instead of opening the first", async () => {
    const { opened, hid } = enumeratingHid(twins);
    const e = await new KnxUsbTransport({ vendorId: 0x147b, productId: 0x5120 }, hid).connect().catch((x) => x);
    expect(e).toBeInstanceOf(KnxError);
    expect((e as KnxError).code).toBe("USB_INTERFACE_AMBIGUOUS");
    const same = enumeratingHid(twins.map((d) => ({ ...d, serialNumber: "X" })));
    const e2 = await new KnxUsbTransport({ vendorId: 0x147b, productId: 0x5120, serial: "X" }, same.hid).connect().catch((x) => x);
    expect((e2 as KnxError).code).toBe("USB_INTERFACE_AMBIGUOUS");
    expect([...opened, ...same.opened]).toEqual([]);
  });

  test("refuses a named serial that is not attached", async () => {
    const { opened, hid } = enumeratingHid(twins);
    const e = await new KnxUsbTransport({ vendorId: 0x147b, productId: 0x5120, serial: "NOPE" }, hid).connect().catch((x) => x);
    expect((e as KnxError).code).toBe("USB_INTERFACE_NOT_FOUND");
    expect(opened).toEqual([]);
  });

  test("a single matching interface opens without a serial", async () => {
    const { opened, hid } = enumeratingHid([twins[0], { vendorId: 0x0e77, productId: 0x0104, path: "/dev/hidraw7" }]);
    await new KnxUsbTransport({ vendorId: 0x147b, productId: 0x5120 }, hid).connect();
    expect(opened).toEqual([["/dev/hidraw0"]]);
  });

  test("an explicit path is opened as given", async () => {
    const { opened, hid } = enumeratingHid(twins);
    await new KnxUsbTransport({ path: "/dev/hidraw9" }, hid).connect();
    expect(opened).toEqual([["/dev/hidraw9"]]);
  });
});

// A stick that re-enumerates (replugged, or the host lost it) leaves the transport holding a dead
// HID handle: node-hid then throws "Cannot write to hid device" on every write, and may or may not
// emit 'error' from its read side. Both are the interface gone, not a bus fault.
class LosableHidDevice extends FakeHidDevice {
  gone = false;
  closed = 0;
  private errorCb: ((e: Error) => void) | null = null;
  override on(ev: "data" | "error", cb: (arg: never) => void): void {
    if (ev === "error") this.errorCb = cb as unknown as (e: Error) => void;
    else super.on(ev, cb);
  }
  override write(d: number[]): number {
    if (this.gone) throw new Error("Cannot write to hid device");
    return super.write(d);
  }
  override close(): void { this.closed++; }
  fail(message: string): void { this.errorCb!(new Error(message)); }
}

async function losable() {
  const dev = new LosableHidDevice();
  const t = new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev));
  await t.connect();
  dev.writes.length = 0;
  const closed: string[] = [];
  t.onClosed = (r) => closed.push(r);
  return { dev, t, closed };
}

describe("KnxUsbTransport: losing the interface", () => {
  test("a write the HID handle refuses is the interface lost, said once, and no later send touches the handle", async () => {
    const { dev, t, closed } = await losable();
    dev.gone = true;
    const e = await t.sendCemi(cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]))).catch((x) => x);
    expect(e).toBeInstanceOf(KnxError);
    expect((e as KnxError).code).toBe("USB_INTERFACE_LOST");
    expect(closed.length).toBe(1);
    expect(closed[0]).toContain("Cannot write to hid device");
    expect(dev.closed).toBe(1); // the dead handle is released, so a reopen can take the stick

    const e2 = await t.sendCemi(cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]))).catch((x) => x);
    expect((e2 as KnxError).code).toBe("USB_INTERFACE_LOST");
    expect(closed.length).toBe(1);
  });

  test("an error from the HID read side is the interface lost as well", async () => {
    const { dev, t, closed } = await losable();
    dev.fail("could not read from HID device");
    expect(closed).toEqual(["the USB interface reported an error: could not read from HID device"]);
    expect(dev.closed).toBe(1);
    const e = await t.sendCemi(cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]))).catch((x) => x);
    expect((e as KnxError).code).toBe("USB_INTERFACE_LOST");
    expect(dev.writes.length).toBe(0);
    dev.fail("again");
    expect(closed.length).toBe(1);
  });

  test("our own disconnect is not reported as a loss", async () => {
    const { dev, t, closed } = await losable();
    await t.disconnect();
    dev.fail("closed by us");
    expect(closed).toEqual([]);
  });
});

describe("KnxUsbTransport: losing the interface, edges", () => {
  test("a loss before anyone listens is told to the first listener", async () => {
    const dev = new LosableHidDevice();
    const t = new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev));
    await t.connect();
    dev.fail("gone before the bridge watched");
    const closed: string[] = [];
    t.onClosed = (r) => closed.push(r);
    expect(closed).toEqual(["the USB interface reported an error: gone before the bridge watched"]);
    t.onClosed = (r) => closed.push(r);
    expect(closed.length).toBe(1); // told once, not to every later listener
  });

  test("an HID error during connect fails connect with that error", async () => {
    const dev = new LosableHidDevice();
    const t = new KnxUsbTransport({ path: "fake" }, fakeHidModule(dev));
    const origWrite = dev.write.bind(dev);
    let failed = false;
    dev.write = (d: number[]) => {
      const n = origWrite(d);
      if (!failed) { failed = true; dev.fail("could not read from HID device"); }
      return n;
    };
    const e = await t.connect().catch((x) => x);
    expect((e as KnxError).code).toBe("USB_INTERFACE_LOST");
    expect((e as Error).message).toContain("could not read from HID device");
    expect(dev.closed).toBe(1);
  });

  test("a send waiting for its L_Data.con fails at once as lost, not 1.5 s later as unconfirmed", async () => {
    const { dev, t } = await losable();
    const started = Date.now();
    const p = t.sendCemi(cemiLData(0, iaToNum("1.2.7"), Buffer.from([0x80]))).catch((x) => x);
    await flush();
    dev.fail("could not read from HID device");
    const e = await p;
    expect((e as KnxError).code).toBe("USB_INTERFACE_LOST");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
