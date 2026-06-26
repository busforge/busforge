import type { KnxTransport } from "./transport.ts";
import { parseCemiLData } from "./transport.ts";

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
// cEMI message codes
const LDATA_CON = 0x2e;

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
  // The interface substitutes its own individual address when we send a cEMI
  // with source 0.0.0, so 0 is the correct source for management traffic.
  readonly assignedIa = 0;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;

  private dev: HidDevice | null = null;
  private rx = Buffer.alloc(0);
  private rxExpected = 0;
  private featResolve: ((body: Buffer) => void) | null = null;
  private conResolve: (() => void) | null = null;

  // Identify the device by HID path (preferred, disambiguates multiple sticks)
  // or by vendor/product id.
  constructor(private readonly target: { path?: string; vendorId?: number; productId?: number }) {}

  async connect(): Promise<void> {
    const hid = await loadHid();
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
  }

  async sendCemi(cemi: Buffer): Promise<void> {
    // Wait for the interface's L_Data.con (it acknowledges putting the frame on
    // the bus); resolve on timeout so a quiet/absent bus never hangs the caller.
    const con = new Promise<void>((res) => { this.conResolve = res; setTimeout(res, 1500); });
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
    } else {
      this.rx = Buffer.concat([this.rx, data]);
    }
    if (packetType & 0x02 && this.rx.length >= this.rxExpected) {
      const frame = this.rx;
      this.rx = Buffer.alloc(0);
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
      if (cemi[0] === LDATA_CON) { this.conResolve?.(); this.conResolve = null; return; }
      const { src, dst, tpdu, isGroup } = parseCemiLData(cemi);
      this.onCemi?.(src, dst, tpdu, isGroup);
    }
  }
}
