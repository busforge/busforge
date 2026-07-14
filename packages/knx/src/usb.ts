import type { KnxTransport } from "./transport.ts";
import { parseCemiLData } from "./transport.ts";
import { CEMI, CEMI_CON_ERROR } from "./frame.ts";
import { KnxError } from "./errors.ts";

// KNX USB transport (KNX spec 9/3 "KNX USB Transfer Protocol"). A KNX-USB
// interface is a vendor-defined HID device exchanging fixed 64-byte reports.
// Each report carries:
//   KNX HID Report Header (3 bytes): report id, packet info, data length
//   KNX USB Transfer Protocol Header (8 bytes, in the start frame only)
//   body: either a cEMI frame (Protocol ID 0x01) or a Bus Access Server feature
//         service message (Protocol ID 0x0F)
// We never need fragmentation: management cEMI (T_Connect, memory read/write of
// <=12 bytes) always fits the 61-byte data field of one report. Reassembly on
// receive is still handled defensively.

const REPORT_ID = 0x01;
const PACKET_SINGLE = 0x13; // sequence 1, packet type start+end
const PROTO_VERSION = 0x00;
const HEADER_LEN = 0x08;
const PROTO_KNX_TUNNEL = 0x01; // body is an EMI/cEMI frame
const PROTO_BUS_ACCESS = 0x0f; // body is a Bus Access Server feature service
const EMI_CEMI = 0x03;
// Bus Access Server feature services (carried in the EMI-id byte for proto 0x0f)
const FEAT_GET = 0x01;
const FEAT_RESPONSE = 0x02;
const FEAT_SET = 0x03;
// feature identifiers
const FEAT_ACTIVE_EMI = 0x05;
// cEMI LOCAL device management (addresses the interface itself, never the bus)
const MPROP_WRITE_REQ = 0xf6;
const MPROP_WRITE_CON = 0xf5;
const MPROP_READ_REQ = 0xfc;
const MPROP_READ_CON = 0xfb;

// The cEMI server's communication mode decides what the interface does with an L_Data.req.
// Some interfaces come up with it UNSET (0xff) and then silently drop every frame we hand
// them: no error, no L_Data.con, nothing on the bus. Hardware-observed on a Weinzierl/ABB
// 147b:5120, where it is exactly why nothing ever reached the bus. So the mode is set, and
// verified, at connect time. Data Link Layer is the plain "put my frames on the bus" mode.
const IOT_CEMI_SERVER = 8;
const PID_COMM_MODE = 52;
const COMM_MODE_DATA_LINK_LAYER = 0x00;

// The interface's own identity, kept in its Device Object and readable over the same local
// device management. Its individual address is what a KNXnet/IP server built on top of this
// transport must hand out to a tunnelling client and advertise in discovery — 0.0.0 is not an
// address anything can answer to, so a bridge cannot be built on a guess.
const IOT_DEVICE = 0;
const PID_SERIAL_NUMBER = 11;
const PID_SUBNET_ADDR = 57; // area + line, the high byte of the individual address
const PID_DEVICE_ADDR = 58; // the low byte

// Weinzierl is the OEM behind most KNX-USB sticks (ABB, Gira, Jung, MDT, ...);
// the product string is the reliable discriminator across rebrands.
const KNOWN_KNX_VENDORS = new Set([0x147b]);

interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  product?: string;
  serialNumber?: string;
  path?: string;
  usagePage?: number;
}
interface HidDevice {
  on(ev: "data", cb: (d: Buffer) => void): void;
  on(ev: "error", cb: (e: Error) => void): void;
  write(data: number[]): number;
  close(): void;
}
interface NodeHid {
  HID: { new (path: string): HidDevice; new (vid: number, pid: number): HidDevice };
  devices(): HidDeviceInfo[];
}

// node-hid is a native module loaded only when a USB connection is actually
// used, so the IP-only deployment never touches it (it is an optionalDependency).
async function loadHid(): Promise<NodeHid> {
  return (await import("node-hid")).default as unknown as NodeHid;
}

function isKnxUsb(d: HidDeviceInfo): boolean {
  if (/knx/i.test(d.product ?? "")) return true;
  return KNOWN_KNX_VENDORS.has(d.vendorId) && d.usagePage === 0xff00;
}

export interface UsbInterfaceInfo {
  vendorId: number;
  productId: number;
  product: string;
  serial?: string;
  path?: string;
}

// Enumerate attached KNX-USB interfaces for the connection picker.
export async function listUsbInterfaces(): Promise<UsbInterfaceInfo[]> {
  const hid = await loadHid();
  return hid.devices()
    .filter(isKnxUsb)
    .map((d) => ({ vendorId: d.vendorId, productId: d.productId, product: d.product ?? "", serial: d.serialNumber, path: d.path }));
}

export class KnxUsbTransport implements KnxTransport {
  // The interface's own individual address, read from its Device Object at connect. Sending is
  // not what needs it: a cEMI with source 0.0.0 gets the interface's address substituted, which
  // is why point-to-point management over this transport worked all along while this field was
  // hardcoded to 0. What needs it is anything that has to NAME the interface on the bus — the
  // KNXnet/IP server hands this address to its tunnelling clients. It stays 0 if the interface
  // does not answer, and the server refuses to start on a 0 rather than advertise one.
  assignedIa = 0;
  // 6 bytes, KNX serial of the interface. Advertised in the server's device-information DIB.
  serialNumber: Buffer = Buffer.alloc(6);
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onRawCemi: ((cemi: Buffer) => void) | null = null;

  private dev: HidDevice | null = null;
  private rx = Buffer.alloc(0);
  private rxExpected = 0;
  private featResolve: ((body: Buffer) => void) | null = null;
  private conSettle: ((reachedBus: boolean) => void) | null = null;
  private propResolve: ((cemi: Buffer) => void) | null = null;

  // Identify the device by HID path (preferred, disambiguates multiple sticks)
  // or by vendor/product id. hidModule is a test seam; when omitted the real
  // node-hid module is loaded lazily as before.
  constructor(
    private readonly target: { path?: string; vendorId?: number; productId?: number },
    private readonly hidModule?: NodeHid,
  ) {}

  async connect(): Promise<void> {
    const hid = this.hidModule ?? (await loadHid());
    this.dev = this.target.path
      ? new hid.HID(this.target.path)
      : new hid.HID(this.target.vendorId!, this.target.productId!);
    this.dev.on("data", (d) => this.onData(d));
    this.dev.on("error", () => {});
    // Select cEMI as the active EMI type before any tunnelling. Best-effort:
    // some interfaces report 0 ("not set") yet accept cEMI regardless.
    try {
      this.setFeature(FEAT_ACTIVE_EMI, Buffer.from([EMI_CEMI]));
      await this.getFeature(FEAT_ACTIVE_EMI);
    } catch { /* interface may not implement the feature service */ }
    await this.enterDataLinkLayer();
    await this.readIdentity();
  }

  // Learn who the interface is on the bus. Deliberately non-fatal: every path that existed before
  // this read sends from 0.0.0 and works, so an interface that does not publish its Device Object
  // must keep working exactly as it did. The one caller that cannot proceed without a real address
  // is the KNXnet/IP server, and it refuses there, where the address is actually required.
  private async readIdentity(): Promise<void> {
    try {
      const subnet = (await this.propRead(IOT_DEVICE, 1, PID_SUBNET_ADDR))[0] ?? 0;
      const device = (await this.propRead(IOT_DEVICE, 1, PID_DEVICE_ADDR))[0] ?? 0;
      this.assignedIa = (subnet << 8) | device;
    } catch { /* keep 0: sending still works, the interface substitutes its own address */ }
    try {
      const serial = await this.propRead(IOT_DEVICE, 1, PID_SERIAL_NUMBER);
      if (serial.length >= 6) this.serialNumber = Buffer.from(serial.subarray(0, 6));
    } catch { /* the serial is cosmetic: it only decorates the discovery response */ }
  }

  // Put the cEMI server into Data Link Layer mode, i.e. "put the frames I hand you on the bus".
  //
  // This is NOT optional and NOT best-effort. A Weinzierl/ABB 147b:5120 comes up with its
  // communication mode UNSET (reads 0xff) and then accepts every L_Data.req we send, confirms
  // nothing, and puts nothing on the bus. Silence, no error. Setting the mode is what makes the
  // interface actually transmit (hardware-verified: the first L_Data.con this transport ever saw
  // arrived immediately after this write). If we cannot establish the mode, we refuse to connect
  // rather than hand back a transport that will swallow everything written to it.
  private async enterDataLinkLayer(): Promise<void> {
    let mode: number | undefined;
    try {
      mode = (await this.propRead(IOT_CEMI_SERVER, 1, PID_COMM_MODE))[0];
      if (mode === COMM_MODE_DATA_LINK_LAYER) return; // interface already transmits
      await this.propWrite(IOT_CEMI_SERVER, 1, PID_COMM_MODE, Buffer.from([COMM_MODE_DATA_LINK_LAYER]));
      mode = (await this.propRead(IOT_CEMI_SERVER, 1, PID_COMM_MODE))[0];
    } catch (e) {
      throw new KnxError("USB_LINK_LAYER_UNAVAILABLE",
        `the USB interface did not answer local device management, so its communication mode could not be established (${e instanceof Error ? e.message : String(e)}); refusing to use an interface that may silently drop every frame`);
    }
    if (mode !== COMM_MODE_DATA_LINK_LAYER) {
      throw new KnxError("USB_LINK_LAYER_UNAVAILABLE",
        `the USB interface refused Data Link Layer mode (its communication mode still reads 0x${(mode ?? 0xff).toString(16)}); in this state it accepts frames and puts none of them on the bus, so refusing to use it`);
    }
  }

  // ---- cEMI local device management (talks to the INTERFACE, never to the bus) ----
  private devMgmt(req: Buffer, conCode: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => { this.propResolve = null; reject(new KnxError("USB_SEND_NOT_CONFIRMED", "the USB interface did not answer a local property request")); }, 1500);
      this.propResolve = (cemi) => {
        if (cemi[0] !== conCode) return; // a different confirmation; keep waiting
        clearTimeout(t); this.propResolve = null;
        // Header: code | IOT(2) | OI(1) | PID(1) | nrOfElem(high nibble) + startIndex. A zero
        // element count means the interface REFUSED and the body is an error code, not data.
        if ((cemi[5] & 0xf0) === 0) { reject(new KnxError("USB_LINK_LAYER_UNAVAILABLE", `the interface rejected a property access (error 0x${(cemi[7] ?? 0).toString(16)})`)); return; }
        resolve(cemi.subarray(7));
      };
      this.transfer(PROTO_KNX_TUNNEL, EMI_CEMI, req);
    });
  }
  private propRead(iot: number, instance: number, pid: number): Promise<Buffer> {
    return this.devMgmt(Buffer.from([MPROP_READ_REQ, (iot >> 8) & 0xff, iot & 0xff, instance, pid, 0x10, 0x01]), MPROP_READ_CON);
  }
  private propWrite(iot: number, instance: number, pid: number, data: Buffer): Promise<Buffer> {
    return this.devMgmt(Buffer.concat([Buffer.from([MPROP_WRITE_REQ, (iot >> 8) & 0xff, iot & 0xff, instance, pid, 0x10, 0x01]), data]), MPROP_WRITE_CON);
  }

  async sendCemi(cemi: Buffer): Promise<void> {
    // Wait for the interface's L_Data.con: its LOCAL confirmation about the frame we handed it,
    // independent of whether any device answers.
    //
    // There are three outcomes, and only one of them is success:
    //   - no .con at all      -> the interface swallowed the frame
    //   - .con with error set -> the interface TRIED and the frame did not reach the bus: no line
    //                            power, a shorted or disconnected bus, or nobody acknowledged it
    //   - .con, error clear   -> the frame is on the bus
    // Treating a negative .con as success (which this transport did) makes a dead bus look exactly
    // like a live bus full of silent devices: every read reports "device not answering", and the
    // diagnosis points at the device instead of at the cable. So the confirm bit is read, and a
    // frame that did not reach the bus is a failure with a name.
    const con = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { this.conSettle = null; reject(new KnxError("USB_SEND_NOT_CONFIRMED", "the USB interface did not confirm the frame reached the bus (no L_Data.con)")); }, 1500);
      this.conSettle = (reachedBus) => {
        clearTimeout(t); this.conSettle = null;
        if (reachedBus) { resolve(); return; }
        reject(new KnxError("BUS_SEND_FAILED", "the KNX interface reports that the telegram did not reach the bus (negative L_Data.con); the line is dead, disconnected, or no device acknowledged the frame"));
      };
    });
    this.transfer(PROTO_KNX_TUNNEL, EMI_CEMI, cemi);
    await con;
  }

  async disconnect(): Promise<void> {
    try { this.dev?.close(); } catch { /* already gone */ }
    this.dev = null;
  }

  // ---- feature service (used during connect / introspection) ----
  private getFeature(featureId: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.featResolve = resolve;
      setTimeout(() => reject(new Error("USB feature timeout")), 2000);
      this.transfer(PROTO_BUS_ACCESS, FEAT_GET, Buffer.from([featureId]));
    });
  }
  private setFeature(featureId: number, value: Buffer): void {
    this.transfer(PROTO_BUS_ACCESS, FEAT_SET, Buffer.concat([Buffer.from([featureId]), value]));
  }

  // ---- wire framing ----
  private transfer(protocolId: number, emiOrService: number, body: Buffer): void {
    const h = Buffer.alloc(HEADER_LEN);
    h[0] = PROTO_VERSION;
    h[1] = HEADER_LEN;
    h.writeUInt16BE(body.length, 2);
    h[4] = protocolId;
    h[5] = emiOrService;
    // h[6..7] = manufacturer code, 0
    this.writeReport(Buffer.concat([h, body]));
  }

  private writeReport(payload: Buffer): void {
    if (!this.dev) throw new Error("USB not connected");
    if (payload.length > 61) throw new Error(`USB payload ${payload.length}B exceeds single report (fragmentation not implemented)`);
    const r = Buffer.alloc(64, 0);
    r[0] = REPORT_ID;
    r[1] = PACKET_SINGLE;
    r[2] = payload.length;
    payload.copy(r, 3);
    this.dev.write(Array.from(r));
  }

  private onData(report: Buffer): void {
    const packetType = report[1] & 0x0f;
    const dataLen = report[2];
    const data = report.subarray(3, 3 + dataLen);
    if (packetType & 0x01) {
      // start frame: transfer header present, body length in bytes 2..3
      this.rx = Buffer.from(data);
      this.rxExpected = HEADER_LEN + (data.length >= 4 ? data.readUInt16BE(2) : 0);
    } else if (this.rxExpected > 0) {
      // continuation only makes sense mid-frame; append to the started buffer
      this.rx = Buffer.concat([this.rx, data]);
    } else {
      return; // orphan continuation/end with no start in progress: nothing to reassemble
    }
    if (packetType & 0x02 && this.rx.length >= this.rxExpected) {
      const frame = this.rx;
      this.rx = Buffer.alloc(0);
      this.rxExpected = 0; // frame consumed; the next one must open with a start packet
      this.handleTransfer(frame);
    }
  }

  private handleTransfer(tbody: Buffer): void {
    const protocolId = tbody[4];
    const body = tbody.subarray(HEADER_LEN);
    if (protocolId === PROTO_BUS_ACCESS) {
      if (tbody[5] === FEAT_RESPONSE) { this.featResolve?.(body); this.featResolve = null; }
      return;
    }
    if (protocolId === PROTO_KNX_TUNNEL) {
      const cemi = body;
      // The confirm flag is the low bit of the first control field, which sits after the
      // variable-length additional-info block. Set means the frame did NOT reach the bus.
      if (cemi[0] === CEMI.LDATA_CON) {
        const ctrl1 = cemi[2 + cemi[1]];
        this.conSettle?.((ctrl1 & CEMI_CON_ERROR) === 0);
        this.conSettle = null;
        return;
      }
      // Local device-management confirmations are about the INTERFACE, not the bus. They must
      // not fall through to the L_Data parser, which would read their property header as a
      // source/destination address and deliver a phantom telegram to the upper layer.
      if (cemi[0] === MPROP_READ_CON || cemi[0] === MPROP_WRITE_CON) { this.propResolve?.(cemi); return; }
      if (cemi[0] !== CEMI.LDATA_IND) return; // anything else is not a bus telegram; drop it, don't misparse it
      this.onRawCemi?.(cemi);
      const { src, dst, tpdu, isGroup } = parseCemiLData(cemi);
      this.onCemi?.(src, dst, tpdu, isGroup);
    }
  }
}
