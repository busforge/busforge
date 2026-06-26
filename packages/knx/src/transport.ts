// Transport abstraction shared by every way Busforge reaches the KNX bus
// (KNXnet/IP tunnelling, KNX USB, ...). Everything above this layer (KnxDevice's
// connection-oriented management, the flash load procedures) speaks plain cEMI
// L_Data and never cares which physical medium carries it.
export interface KnxTransport {
  // Source individual address put into outgoing cEMI. For IP tunnelling this is
  // the gateway-assigned tunnel address; for USB the interface fills in its own
  // address when we send 0.0.0, so 0 is a valid value there.
  readonly assignedIa: number;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null;
  connect(): Promise<void>;
  sendCemi(cemi: Buffer): Promise<void>;
  disconnect(): Promise<void>;
}

// Decode an incoming cEMI L_Data frame (message code + additional info + L_Data)
// into the fields the upper layer needs. Identical wire format for IP and USB.
export function parseCemiLData(cemi: Buffer): { src: number; dst: number; tpdu: Buffer; isGroup: boolean } {
  const addIL = cemi[1];
  const off = 2 + addIL;
  const isGroup = (cemi[off + 1] & 0x80) !== 0;
  const src = cemi.readUInt16BE(off + 2);
  const dst = cemi.readUInt16BE(off + 4);
  const len = cemi[off + 6];
  const tpdu = cemi.subarray(off + 7, off + 7 + len + 1);
  return { src, dst, tpdu, isGroup };
}
