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
    return d.length;
  }
  close(): void {}
  inject(report: Buffer): void {
    this.dataCb!(report);
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
  await t.connect(); // writes FEAT_SET + FEAT_GET, fake answers the GET
  expect(dev.writes.length).toBe(2);
  dev.writes.length = 0; // only look at traffic after the feature handshake
  return { dev, t };
}

describe("KnxUsbTransport", () => {
  test("sendCemi frames the cEMI into one 64-byte HID report", async () => {
    const { dev, t } = await connected();
    // cemiLData(0, 1.2.17, [0x80]) = T_Connect from source 0.0.0 (the
    // interface substitutes its own IA):
    //   11 00 bc 60 00 00 12 11 00 80   (10 bytes)
    const cemi = cemiLData(0, iaToNum("1.2.17"), Buffer.from([0x80]));
    const p = t.sendCemi(cemi);
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

    // L_Data.ind: 29 00 bc 60 | src 12 11 (1.2.17) | dst 11 05 (1.1.5) |
    // len 03 | tpdu 42 40 00 00 (len byte = tpdu.length - 1)
    const tpdu = Buffer.from([0x42, 0x40, 0x00, 0x00]);
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0x60, 0x12, 0x11, 0x11, 0x05, 0x03, ...tpdu]);
    dev.inject(tunnelReport(cemi));

    expect(calls.length).toBe(1);
    expect(calls[0]!.src).toBe(iaToNum("1.2.17"));
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
      Buffer.from([0x29, 0x00, 0xbc, 0x60, 0x12, 0x11, 0x11, 0x05, 60]), // len byte = 61-1
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

  test("a lone end-packet without a start does not deliver a frame", async () => {
    const { dev, t } = await connected();
    const calls: Buffer[] = [];
    t.onCemi = (_s, _d, tpdu) => calls.push(tpdu);

    // Actual current behavior, derived from usb.ts onData(): a continuation
    // packet is appended to the (empty) rx buffer and only delivered once
    // rx.length >= rxExpected. rxExpected is NOT reset after a completed
    // frame; the feature-response frame during connect() left it at
    // 8 + 2 = 10, so this 5-byte orphan stays below the threshold and is
    // silently buffered, never delivered. (Residual gap, noted, not "fixed"
    // by the test: on a transport that never completed any frame,
    // rxExpected is 0 and an orphan end-packet would reach handleTransfer,
    // where only the protocol-id byte check stands between it and a bogus
    // parse.)
    const orphanEnd = report([0x01, 0x26, 5, 0xde, 0xad, 0xbe, 0xef, 0x01]);
    dev.inject(orphanEnd);
    expect(calls.length).toBe(0);
  });

  test("sendCemi resolves on L_Data.con, and the con is not surfaced via onCemi", async () => {
    const { dev, t } = await connected();
    const calls: Buffer[] = [];
    t.onCemi = (_s, _d, tpdu) => calls.push(tpdu);

    const cemi = cemiLData(0, iaToNum("1.2.17"), Buffer.from([0x80]));
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
    const cemi = cemiLData(0, iaToNum("1.2.17"), Buffer.from([0x80]));
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
