import { randomBytes } from "node:crypto";
import type { KnxTransport } from "./transport.ts";
import { KnxUsbTransport } from "./usb.ts";
import type { SecureSession } from "./secureSession.ts";
import { SECURE_APDU_OVERHEAD } from "./secure.ts";
import { cemiLData, tpConnect, tpDisconnect, tpAck, apdu, parseApdu, iaToNum, propertyExtHead, APCI, type ParsedApdu } from "./frame.ts";
import { KnxError } from "./errors.ts";
import { decodeDeviceDescriptorResponse, encodeAuthorizeFreeKey, decodeAuthorizeResponse, encodePropertyDescriptionRead, decodePropertyDescription, decodePropertyValueResponse, type PropertyDescription, type PropertyValueResponse } from "./rawcodec.ts";

// Interface-object property ids and standard table-object numbers used across the
// management/flash layer. Named once here so a transposed literal (5 vs 7 vs 13) in
// the least-debuggable layer becomes impossible.
export const PID = {
  DEVICE_CONTROL: 14,    // device object: programming mode, verify mode, ... (see VERIFY_MODE)
  LOAD_STATE_CONTROL: 5, // LSM events (write) / LSM state (read)
  TABLE_REFERENCE: 7,    // the table/segment base address of a load object
  PROGRAM_ID: 13,        // manufacturer+app+version stamp validated by LoadCompleted
  MCB_TABLE: 27,         // memory control block (per-segment CRC bookkeeping)
} as const;
// PID_DEVICE_CONTROL bit 2. With it set, the device answers EVERY A_Memory_Write with an
// A_Memory_Response carrying what actually ended up in its memory (thelsing/knx
// BauSystemB::memoryWriteIndication: `if (_deviceObj.verifyMode()) memoryReadIndication(...)`).
// This is what a load procedure's `LdCtrlWriteRelMem Verify="true"` asks for, and it is the only
// way to learn that a write did NOT land at the moment it happens rather than a thousand
// telegrams later.
export const VERIFY_MODE = 0x04;

// Chunk sizes (data bytes per request) for the A_MemoryExtended path. Classic memory is stuck at 12
// (small standard frames), but extended memory moves more per round trip, which matters for the large
// System B parameter segments it exists to reach (a 10 KB segment at 12 bytes is ~850 round trips over a
// tunnelled bench bridge — minutes). READ and WRITE have DIFFERENT ceilings because a read request is
// tiny (count + 3-byte address; the data comes back in the RESPONSE, which the transport reassembles on
// receive) while a write request CARRIES the data. Over the bench ABB KNX-USB stick, whose HID transport
// sends one report and does not fragment, the limits measured on a Jung 400021SE are: reads up to 48
// data bytes, writes up to 32 (a ~55-byte USB payload; 40+ overflows the single report and the send is
// dropped). Both are a safe default for a real KNX-IP interface too (it tolerates at least this). Capped
// at the 255 the single-octet count field allows; override to probe another interface's ceiling.
export const EXT_READ_CHUNK = Math.min(Math.max(1, Number(process.env.KNX_EXT_READ_CHUNK) || 48), 255);
export const EXT_WRITE_CHUNK = Math.min(Math.max(1, Number(process.env.KNX_EXT_WRITE_CHUNK) || 32), 255);
// A_MemoryExtended_Write spends 5 APDU octets besides the data: the APCI's second octet, the count and
// the 3-byte address. So a device's maximum APDU length minus 5 is the most one chunk may carry.
const EXT_WRITE_OVERHEAD = 5;
const PID_MAX_APDU_LENGTH = 56;
// Element count (one octet) and start index (two) of an extended property service. Masking a value
// out of range would address other elements, so it is refused.
function assertElements(start: number, count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > 0xff || !Number.isInteger(start) || start < 0 || start > 0xffff) {
    throw new KnxError("PROPERTY_ADDRESS_INVALID", `element count ${count} from ${start} does not fit an extended property service`);
  }
}

// A piece of a partial memory read: bytes the device gave, or a range it refused with its raw answer
// (hex, address echo included; for a joined refusal, the answer to each of its requests).
export type MemPiece = { address: number; length: number; bytes: Buffer } | { address: number; length: number; refused: string };
export interface PartialMemRead { pieces: MemPiece[]; stopped: { address: number; error: unknown } | null }

function serviceMismatch(what: string, got: number, want: number): KnxError {
  return new KnxError("PROPERTY_RESPONSE_MISMATCH", `${what} was answered with service 0x${got.toString(16)}, not 0x${want.toString(16)}`);
}

// The security interface object (KNX Data Secure) and its security-mode function property.
export const OBJECT_TYPE_SECURITY = 17;
// The KNXnet/IP parameter object (KNX 03_08_03 §2.5), reached by type through the extended services.
export const OBJECT_TYPE_KNXNETIP = 11;
// A property service's return code for an element or property the device does not have (E_ADDRESS_VOID;
// ETS 6 reports it as ResourceNotFound).
export const RETURN_CODE_ADDRESS_VOID = 0xfd;
// Properties of the security interface object that a secured download loads.
export const SECURITY_PID = {
  LOAD_STATE_CONTROL: 5,
  SECURITY_MODE: 51,
  GROUP_KEY_TABLE: 53,          // elements of address-table index (2) + key (16)
  SECURITY_IA_TABLE: 54,        // peers' individual addresses and sequence counters
  TOOL_KEY: 56,
  GO_SECURITY_FLAGS: 61,        // one byte per group object, element k = object k
} as const;
const PID_SECURITY_MODE = SECURITY_PID.SECURITY_MODE;

// Split whole elements of `elementSize` bytes, starting at element `start`, into requests of at
// most `budget` data bytes (and 255 elements, the count being one octet).
export function elementRuns(start: number, elementSize: number, data: Buffer, budget: number): { start: number; count: number; bytes: Buffer }[] {
  if (!Number.isInteger(elementSize) || elementSize < 1 || data.length % elementSize !== 0) {
    throw new KnxError("PROPERTY_ADDRESS_INVALID", `${data.length} bytes are not whole elements of ${elementSize}`);
  }
  const per = Math.min(0xff, Math.floor(budget / elementSize));
  if (per < 1) {
    throw new KnxError("PROPERTY_ELEMENT_TOO_LONG", `one ${elementSize}-byte element does not fit a request of ${budget} data bytes to this device`);
  }
  const runs: { start: number; count: number; bytes: Buffer }[] = [];
  for (let off = 0; off < data.length; off += per * elementSize) {
    const bytes = data.subarray(off, off + per * elementSize);
    runs.push({ start: start + off / elementSize, count: bytes.length / elementSize, bytes });
  }
  return runs;
}

// Data bytes per memory request, from the device's maximum APDU length (null when it declares none)
// and whether the session is secured. A_Memory_Read spends 3 octets besides the data, the extended
// read and write 5; the path limits above are for plain frames, so a secured session subtracts its
// framing from both (a Jung 400021SE over the bench answered no secured 48-byte read, and every
// 35-byte one). A secured write is held to the 40 octets ETS itself sends on that path (22-byte
// memory writes and 18-byte property elements in its secured download of the Jung, after longer
// requests went unanswered). A secured session needs the device's maximum APDU: a device that does
// not declare it is held to the 15-octet standard frame, which no secured request fits. Where the
// framing leaves no data byte, the request is refused rather than sent oversize into silence.
//
// The extended property services spend 4 octets more than the extended memory ones (object type,
// instance and PID in 5, count and start in 3, against count and address in 4), so their element
// data per request (`propRead`, `propWrite`) is the memory figure less 4; where that leaves no room
// for one element, the property request itself refuses.
const SECURE_WRITE_PATH_APDU = 40;
const PROP_EXTRA_OVERHEAD = 4;
export function transferChunks(maxApdu: number | null, secured: boolean): { classicRead: number; extRead: number; extWrite: number; propRead: number; propWrite: number } {
  const withProps = (c: { classicRead: number; extRead: number; extWrite: number }) =>
    ({ ...c, propRead: c.extRead - PROP_EXTRA_OVERHEAD, propWrite: c.extWrite - PROP_EXTRA_OVERHEAD });
  if (!secured) {
    return withProps({
      classicRead: maxApdu === null ? 12 : Math.max(12, Math.min(EXT_READ_CHUNK, maxApdu - 3)),
      extRead: EXT_READ_CHUNK,
      extWrite: maxApdu === null ? EXT_WRITE_CHUNK : Math.min(EXT_WRITE_CHUNK, maxApdu - EXT_WRITE_OVERHEAD),
    });
  }
  if (maxApdu === null) {
    throw new KnxError("SECURE_APDU_TOO_SHORT", "the device declares no maximum APDU length, so it takes standard frames only, and a secured memory request does not fit one");
  }
  const fit = (n: number, what: string) => {
    if (n - SECURE_APDU_OVERHEAD < 1) {
      throw new KnxError("SECURE_APDU_TOO_SHORT", `a secured ${what} does not fit the device's maximum APDU length of ${maxApdu}`);
    }
    return n - SECURE_APDU_OVERHEAD;
  };
  return withProps({
    classicRead: fit(Math.min(EXT_READ_CHUNK, maxApdu - 3), "memory read"),
    extRead: fit(Math.min(EXT_READ_CHUNK, maxApdu - EXT_WRITE_OVERHEAD), "extended memory read"),
    extWrite: fit(Math.min(SECURE_WRITE_PATH_APDU, maxApdu) - EXT_WRITE_OVERHEAD, "extended memory write"),
  });
}

// Data bytes per memory write in a plain session, as ETS 6 sizes them: the shorter of the device's and the
// interface's maximum APDU ("NegotiateMaxApduLength -> 210, restricted by ByInterface" on an MDT IP
// Interface/Router announcing 210; "-> 55, restricted by ByTargetDevice" on a Theben MIX 2) less the
// write's own octets, 5 for A_MemoryExtended_Write (205 data bytes on that interface, the OpenKNX
// captures), 3 for A_Memory_Write (52 on the Theben DALI-Gateway's 55), the latter capped at its 6-bit
// count. Where the interface announces nothing (a USB interface, or an IP one that does not answer the
// extended search), the path limit stays: 32 extended (EXT_WRITE_CHUNK, the knob above caps only that
// case), 12 classic.
export function writeChunks(deviceMax: number | null, interfaceMax: number | null): { classic: number; ext: number } {
  if (deviceMax === null || interfaceMax === null) return { classic: 12, ext: transferChunks(deviceMax, false).extWrite };
  const n = Math.min(deviceMax, interfaceMax);
  return { classic: Math.max(1, Math.min(63, n - 3)), ext: Math.max(1, Math.min(255, n - EXT_WRITE_OVERHEAD)) };
}

// A_Restart carries its type in the low bits of its APCI: 0 = a plain reboot, 1 = a master reset,
// which then takes an erase code saying how much to throw away.
export const RESTART_MASTER = 0x01;
// The response flag in the same low bits (A_Restart_Response).
const RESTART_RESPONSE = 0x20;
export const ERASE = {
  CONFIRMED_RESTART: 0x01,
  FACTORY_RESET: 0x02,          // everything, including the individual address
  RESET_IA: 0x03,
  RESET_APPLICATION: 0x04,
  RESET_PARAMETERS: 0x05,
  RESET_LINKS: 0x06,
  FACTORY_RESET_KEEP_IA: 0x07,
} as const;

export const OBJ = {
  ADDR_TABLE: 1,   // group address table
  ASSOC_TABLE: 2,  // association table
  COMOBJ_TABLE: 3, // com-object table
  APP_PROGRAM: 4,  // application program / parameter segment
  PEI_PROGRAM: 5,  // PEI program (interface object type 4 on MV-07B0)
} as const;

// Connection-oriented KNX management on top of the tunnel: T_Connect, numbered
// requests with T_ACK + retransmission, ACK-the-response-before-the-next-request.
// Reads are verified on real hardware; writes/flash are ported from the proven
// reference and the load procedure documented in docs/findings.md.
//
// With an optional SecureSession the same flow speaks KNX Data Secure: every
// management APDU is wrapped (and responses unwrapped) transparently, and connect()
// runs a Sync first to learn the device's tool-access sequence. Without it the path
// is byte-for-byte the plain one. Hardware-verified on an MDT IP interface.

// A_Memory_Read/Write carry a 2-BYTE address, so they reach 0x0000..0xFFFF and no further. A device
// that allocates a segment above that is handled by A_MemoryExtended: memRead/memWrite route any range
// whose last byte exceeds 0xFFFF to the extended path BEFORE this guard runs. So reaching here with a
// too-high last byte can only mean a negative (invalid) base address, never an unhandled high segment.
// Refuse it rather than truncate: a truncated address writes the right bytes to the WRONG place, which
// on a load-state machine means a device that comes up believing a table it never received.
function assertAddressable(addr: number, len: number, what: string): void {
  const last = addr + len - 1;
  if (addr < 0 || last > 0xffff) {
    throw new KnxError("MEMORY_ADDRESS_TOO_HIGH",
      `${what} at 0x${addr.toString(16)}..0x${last.toString(16)} is not a valid 16-bit memory address (a range past 0xFFFF is served by A_MemoryExtended before this guard)`);
  }
}

// The shortest time between two Sync requests to one device. The Jung 400021SE drops a Sync that
// arrives within about a second of the previous one (docs/findings.md §21: 900 ms ignored, 1000 ms
// answered), so every session a KnxDevice opens to a device it synced with shortly before waits,
// whichever transport it runs over: the server opens a new tunnel per operation, and two previews
// back to back (parameters, then group tables) met the window on 2026-09-30. Keyed by individual
// address alone, so the same address on another line in the same process waits needlessly, which
// costs at most the gap.
export const SYNC_GAP_MS = 1200;
// The slot is reserved before waiting, so two sessions starting together queue one gap apart.
const lastSync = new Map<number, number>();
async function waitForSyncGap(dst: number): Promise<void> {
  const at = Math.max(Date.now(), (lastSync.get(dst) ?? 0) + SYNC_GAP_MS);
  lastSync.set(dst, at);
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// How long a KnxDevice waits for the device, in milliseconds: its T_ACK of a request, the answer to
// it, the pause before repeating an unanswered request, the answer to a Sync request and the
// answer to a confirmed restart. Code that talks to a device on the bus takes these; a test whose
// scripted transport answers at once or never passes shorter ones, so a silence costs it no time.
// restartProofMs: after a negatively confirmed A_Restart, how long from the device's last frame to us a
// T_Disconnect still counts as its reboot (restart(), proveUnconfirmedRestart). It stays well below the
// 6 s after which a device closes an idle transport connection by itself.
export interface DeviceTimeouts { ackMs: number; responseMs: number; retryGapMs: number; syncResponseMs: number; restartAnswerMs: number; restartProofMs: number }
export const DEVICE_TIMEOUTS: Readonly<DeviceTimeouts> = { ackMs: 1500, responseMs: 2000, retryGapMs: 200, syncResponseMs: 3000, restartAnswerMs: 2000, restartProofMs: 4000 };

// A failure of the link between this tool and the interface (KNXnet/IP tunnel, USB), or one without a
// code: it says nothing about the device.
function isLinkFailure(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return typeof code !== "string" || code.startsWith("TUNNEL_") || code.startsWith("USB_");
}

export class KnxDevice {
  private dst: number;
  private seq = 0;
  private ackResolve: (() => void) | null = null;
  private respResolve: ((p: ParsedApdu) => void) | null = null;
  // Sequence number of the last numbered data frame taken from the device on this connection. A frame
  // with the same number is the device repeating it because our T_ACK did not reach it (the interface
  // answers L_Data.con negative): it is acknowledged again and dropped, never taken as the answer to
  // the request now in flight.
  private lastRxSeq: number | null = null;
  private peerClosed: (() => void) | null = null;
  // During the Sync handshake, raw frames are diverted here (the Sync response is not
  // a normal secure data frame, so it bypasses the request machinery).
  private rawInbox: Buffer[] | null = null;
  private rawNotify: (() => void) | null = null;

  private readonly timeouts: DeviceTimeouts;

  constructor(private tun: KnxTransport, ia: string, private secure?: SecureSession, timeouts: Partial<DeviceTimeouts> = {}) {
    this.dst = iaToNum(ia);
    this.timeouts = { ...DEVICE_TIMEOUTS, ...timeouts };
    tun.onCemi = (src, dst, tpdu, isGroup) => this.onCemi(src, dst, tpdu, isGroup);
  }
  private get me() { return this.tun.assignedIa; }

  private onCemi(src: number, dst: number, tpdu: Buffer, isGroup: boolean) {
    if (isGroup || src !== this.dst) return;
    // T_Connect/T_Disconnect from the device: unnumbered control frames, never acknowledged and
    // never an answer. A T_Disconnect to us ends the request in flight; one to another tool's
    // address is about that tool's connection, not ours.
    if ((tpdu[0] & 0xc0) === 0x80) {
      if ((tpdu[0] & 0x03) === 0x01 && dst === this.me) { this.peerClosedAt = Date.now(); this.peerClosed?.(); }
      return;
    }
    if (dst === this.me) this.lastFromDeviceAt = Date.now();
    if (this.rawInbox) { this.rawInbox.push(Buffer.from(tpdu)); this.rawNotify?.(); return; }
    const outer = parseApdu(tpdu);
    if (outer.control) {
      if (outer.seq === this.seq) { if ((tpdu[0] & 0x03) === 0x03) this.nakSeen = true; else this.ackSeen = true; this.ackResolve?.(); }
      return;
    }
    // For a secure session the data frame is a wrapped secure APDU: ACK the outer
    // numbered frame, then deliver the decrypted inner APDU. A failed MAC is dropped
    // (the request times out and can re-sync) rather than surfaced as fake data. A
    // MAC-valid REPLAY (a retransmission after our T_ACK was lost) is still ACKed so the
    // device stops retransmitting, but is not re-delivered.
    let p = outer;
    if (this.secure) {
      const inner = this.secure.unwrap(tpdu);
      if (inner.status === "invalid") { this.unauthentic++; return; }
      if (inner.status === "replay") { this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck(outer.seq))).catch(() => {}); return; }
      p = parseApdu(inner.apdu);
    } else if (outer.seq === this.lastRxSeq) {
      this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck(outer.seq))).catch(() => {});
      return;
    }
    // Taken only once our T_ACK is out: a frame whose T_ACK failed to send is not delivered, and the
    // device's repetition of it is then the only copy, which has to get through.
    const plain = !this.secure;
    this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck(outer.seq))).then(() => { if (plain) this.lastRxSeq = outer.seq; this.respResolve?.(p); }).catch(() => {});
  }

  // Open the KNXnet/IP link again after it went down, e.g. an interface that stopped serving and
  // dropped its tunnels (a USB link is not reopened: its errors carry no TUNNEL_* code). A secured session is bound to the tunnel's individual address;
  // a link that comes back under another one is refused, not carried on under the old address.
  async reopenTransport(): Promise<void> {
    try { await this.tun.disconnect(); } catch { /* the link is already gone */ }
    await this.tun.connect();
    if (this.secure && this.tun.assignedIa !== this.secure.src) {
      throw new KnxError("TUNNEL_ADDRESS_CHANGED", `the link came back as ${this.tun.assignedIa >> 12}.${(this.tun.assignedIa >> 8) & 15}.${this.tun.assignedIa & 255}, not the address the secured session is bound to`);
    }
  }

  async connect() {
    this.seq = 0;
    this.lastRxSeq = null;
    this.maxApdu = undefined;
    await this.tun.sendCemi(cemiLData(this.me, this.dst, tpConnect()));
    if (this.secure) await this.runSync(this.secure);
  }
  // Teardown. A T_Disconnect the device never sees is the same as one it did: the connection is
  // over either way, and there is nothing a caller could do about the failure.
  async disconnect() { try { await this.tun.sendCemi(cemiLData(this.me, this.dst, tpDisconnect())); } catch { /* the link may already be gone */ } }

  // Data Secure Sync: agree the live tool-access sequence before any secured request.
  private async runSync(sec: SecureSession): Promise<void> {
    const challenge = randomBytes(6);
    this.rawInbox = [];
    try {
      await waitForSyncGap(this.dst);
      await this.tun.sendCemi(cemiLData(this.me, this.dst, sec.buildSyncRequest(sec.serial, challenge, this.seq)));
      const rsp = await this.rawNext();
      await this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck((rsp[0] >> 2) & 0x0f))); // ACK the device's Sync.res
      if (!sec.applySyncResponse(rsp, challenge)) throw new KnxError("SECURE_SYNC_FAILED", "secure Sync failed (MAC mismatch)");
      this.seq = (this.seq + 1) & 0x0f; // the Sync request consumed this T-sequence
    } finally { this.rawInbox = null; this.rawNotify = null; }
  }

  // Next non-control (data) frame during Sync; skips the device's T_ACK.
  private rawNext(): Promise<Buffer> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.rawNotify = null; rej(new KnxError("SECURE_SYNC_NO_RESPONSE", "the device did not answer the secure Sync request; a wrong tool key, or a device that is not in secure mode, looks like this")); }, this.timeouts.syncResponseMs);
      const pump = () => {
        while (this.rawInbox?.length) {
          const f = this.rawInbox.shift()!;
          if ((f[0] & 0xc0) === 0xc0) continue; // skip T_ACK control frames
          clearTimeout(t); this.rawNotify = null; res(f); return;
        }
      };
      this.rawNotify = pump; pump();
    });
  }

  // A numbered APDU as it goes on the wire. Plain: as-is. Secure: stripped to the bare service APDU
  // (inner TPCI 0) and wrapped for its T-sequence; a device in secure mode acknowledges a plain
  // service on the transport layer and then ignores it.
  private onWire(tpdu: Buffer): Buffer {
    if (!this.secure) return tpdu;
    const svc = Buffer.from(tpdu); svc[0] &= 0x03;
    return this.secure.wrapManagement(svc, (tpdu[0] >> 2) & 0x0f);
  }
  // Answers dropped in the current try because they could not be authenticated (a failed MAC, or
  // an answer not secured at all). A replay is not counted: it is MAC-valid, and a stale
  // retransmission of an earlier answer is ordinary transport.
  private unauthentic = 0;
  // `afterWrap` runs once the request is framed for the wire and before it is sent, so an answer
  // that races the send is already taken under whatever it sets up.
  // `deviceAckSuffices`: the device's T_ACK proves the frame arrived, so the interface's L_Data.con
  // is not waited for once it is there, and its absence is no error (the confirmed restart, below).
  private async request(build: (seq: number) => Buffer, expectResponse: boolean, tries = Number(process.env.KNX_TRIES) || 3, afterWrap?: () => void, deviceAckSuffices = false): Promise<ParsedApdu | null> {
    try { return await this.requestTries(build, expectResponse, tries, afterWrap, deviceAckSuffices); }
    finally { this.peerClosed = null; }
  }
  private async requestTries(build: (seq: number) => Buffer, expectResponse: boolean, tries: number, afterWrap?: () => void, deviceAckSuffices = false): Promise<ParsedApdu | null> {
    // Whether the last try was acknowledged and then got only unauthentic answers: the device
    // answered and was not believed, which is a different failure from silence.
    let rejectedAfterAck = false;
    for (let i = 0; i < tries; i++) {
      this.unauthentic = 0;
      rejectedAfterAck = false;
      if (i > 0) await new Promise((r) => setTimeout(r, this.timeouts.retryGapMs));
      // The waiters are registered before the send, the device's timeouts start after it: over UDP
      // the send resolves on the tunnelling ACK, and a late ACK must not eat the device's time.
      let ackTimeout = (): void => undefined;
      let respTimeout = (): void => undefined;
      const ackP = new Promise<boolean>((res) => { this.ackResolve = () => res(true); ackTimeout = () => res(false); });
      const respP = expectResponse
        ? new Promise<ParsedApdu | null>((res) => { this.respResolve = (p) => res(p); respTimeout = () => res(null); })
        : Promise.resolve<ParsedApdu | null>(null);
      let closedByDevice = false;
      this.peerClosed = () => { closedByDevice = true; ackTimeout(); respTimeout(); };
      const tpdu = this.onWire(build(this.seq));
      afterWrap?.();
      try {
        const sent = this.tun.sendCemi(cemiLData(this.me, this.dst, tpdu));
        if (deviceAckSuffices) {
          sent.catch(() => undefined);
          await Promise.race([sent, ackP.then((acked) => (acked ? undefined : new Promise<never>(() => undefined)))]);
        } else await sent;
      } catch (e) {
        // A link to the interface that stalled or closed takes no retry: the frame may be stuck in
        // it, and a repetition would queue behind it.
        const code = (e as { code?: string }).code;
        if (code === "TUNNEL_CON_TIMEOUT" || code === "TUNNEL_CLOSED") throw e;
        // A negative L_Data.con (BUS_SEND_FAILED) or a tunnel ack timeout means the frame did not
        // reach the device this time. On a device that intermittently misses its L2-ACK window
        // (a busy single-core app), that is exactly what a retry is for. Retry until the budget is
        // spent, then surface the last error.
        if (i < tries - 1) continue;
        throw e;
      }
      setTimeout(ackTimeout, this.timeouts.ackMs);
      setTimeout(respTimeout, this.timeouts.responseMs);
      const acked = await ackP;
      if (!acked && !closedByDevice) continue;
      if (acked && !expectResponse) { this.seq = (this.seq + 1) & 0x0f; return null; }
      const r = await respP;
      // A device that closes its transport connection takes no further numbered frame, so asking
      // again is pointless. It is present, so this is not DEVICE_NOT_ANSWERING (silence).
      if (r === null && closedByDevice) throw new KnxError("DEVICE_CLOSED_CONNECTION", "the device closed the connection without answering");
      if (r === null) { rejectedAfterAck = this.unauthentic > 0; continue; }
      this.seq = (this.seq + 1) & 0x0f;
      return r;
    }
    if (rejectedAfterAck) {
      throw new KnxError("SECURE_ANSWER_REJECTED", `the device acknowledged the request and answered, but ${this.unauthentic} answer(s) could not be authenticated (a failed MAC, or an answer not secured at all); nothing from them was used`);
    }
    throw new KnxError("DEVICE_NOT_ANSWERING", "no reliable response (device not answering)");
  }

  // ---- reads (verified on hardware) ----
  async deviceDescriptor(): Promise<string> {
    const r = await this.request((s) => apdu(s, APCI.DEVICE_DESCRIPTOR_READ), true);
    return "MV-" + r!.data.toString("hex").toUpperCase();
  }
  async propRead(obj: number, pid: number, start = 1, count = 1): Promise<Buffer> {
    const tail = Buffer.from([obj, pid, (count << 4) | ((start >> 8) & 0x0f), start & 0xff]);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_READ, tail), true);
    return r!.data.subarray(4); // skip obj,pid,start echo
  }
  // ---- extended property services (object type + instance, see APCI.PROPERTY_EXT_*) ----
  // Each answer echoes the 5-octet property address; one for another property is refused, never
  // taken as this one's.
  private extEcho(r: ParsedApdu, expectApci: number, head: Buffer, what: string): Buffer {
    if (r.apci !== expectApci) {
      throw new KnxError("PROPERTY_RESPONSE_MISMATCH", `${what} was answered with service 0x${r.apci.toString(16)}, not 0x${expectApci.toString(16)}`);
    }
    if (r.data.length < head.length || !r.data.subarray(0, head.length).equals(head)) {
      throw new KnxError("PROPERTY_RESPONSE_MISMATCH", `${what} for ${head.toString("hex")} was answered for ${r.data.subarray(0, head.length).toString("hex")}`);
    }
    return r.data.subarray(head.length);
  }
  // The value of `count` elements from `start`; a device answers a property it lacks, or a read it
  // refuses, with zero elements, which is an error here rather than an empty value.
  async propExtRead(objectType: number, instance: number, pid: number, start = 1, count = 1): Promise<Buffer> {
    assertElements(start, count);
    const head = propertyExtHead(objectType, instance, pid);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_EXT_READ, Buffer.concat([head, Buffer.from([count, start >> 8, start & 0xff])])), true);
    const rest = this.extEcho(r!, APCI.PROPERTY_EXT_RESPONSE, head, "an extended property read");
    if (rest.length < 3 || rest[0] === 0) {
      throw new KnxError("PROPERTY_EXT_READ_REFUSED", `object type ${objectType} PID ${pid}: the device returned no element${rest.length > 3 ? ` (code 0x${rest[3].toString(16)})` : ""}`);
    }
    return rest.subarray(3);
  }
  // A confirmed write: the device answers with a return code, and anything but success is refused.
  // `tolerate`: the one return code a load procedure ignores for this write (an OnError Ignore); the
  // write then returns false, a success true.
  async propExtWriteCon(objectType: number, instance: number, pid: number, data: Buffer, start = 1, count = 1, tolerate?: number): Promise<boolean> {
    assertElements(start, count);
    const head = propertyExtHead(objectType, instance, pid);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_EXT_WRITE_CON, Buffer.concat([head, Buffer.from([count, start >> 8, start & 0xff]), data])), true);
    const rest = this.extEcho(r!, APCI.PROPERTY_EXT_WRITE_CON_RESP, head, "an extended property write");
    if (tolerate !== undefined && rest.length >= 4 && rest[3] === tolerate) return false;
    if (rest.length < 4 || rest[3] !== 0x00) {
      throw new KnxError("PROPERTY_EXT_WRITE_REFUSED", `object type ${objectType} PID ${pid} element ${start}: the device answered ${rest.toString("hex") || "nothing"}`);
    }
    return true;
  }
  // Function properties answer both the command and the state read with [returnCode, result...].
  async funcPropExtCommand(objectType: number, instance: number, pid: number, data: Buffer): Promise<{ returnCode: number; result: Buffer }> {
    return this.funcPropExt(APCI.FUNCTION_PROPERTY_EXT_COMMAND, objectType, instance, pid, data);
  }
  async funcPropExtStateRead(objectType: number, instance: number, pid: number, data: Buffer): Promise<{ returnCode: number; result: Buffer }> {
    return this.funcPropExt(APCI.FUNCTION_PROPERTY_EXT_STATE_READ, objectType, instance, pid, data);
  }
  private async funcPropExt(apci: number, objectType: number, instance: number, pid: number, data: Buffer): Promise<{ returnCode: number; result: Buffer }> {
    const head = propertyExtHead(objectType, instance, pid);
    const r = await this.request((s) => apdu(s, apci, Buffer.concat([head, data])), true);
    const rest = this.extEcho(r!, APCI.FUNCTION_PROPERTY_EXT_STATE_RESPONSE, head, "a function property");
    if (rest.length < 1) throw new KnxError("PROPERTY_RESPONSE_MISMATCH", `object type ${objectType} PID ${pid}: a function property answer without a return code`);
    return { returnCode: rest[0], result: rest.subarray(1) };
  }
  // Write a new tool key (PID 56 of the security object). The device answers this write already
  // under the new key, so the session switches keys once the write is framed under the old one. It is sent once and never
  // retried: a retry would go out under a key the device may not hold. A write that gets no answer
  // leaves it open which key the device holds, and the caller has to find out by trying both.
  async writeToolKey(key: Buffer): Promise<void> {
    const sec = this.secure;
    if (!sec) throw new KnxError("SECURE_SESSION_REQUIRED", "a tool key is only ever written inside a secured session");
    const head = propertyExtHead(OBJECT_TYPE_SECURITY, 1, SECURITY_PID.TOOL_KEY);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_EXT_WRITE_CON, Buffer.concat([head, Buffer.from([1, 0, 1]), key])), true, 1, () => sec.rekey(key));
    const rest = this.extEcho(r!, APCI.PROPERTY_EXT_WRITE_CON_RESP, head, "the tool key write");
    if (rest.length < 4 || rest[3] !== 0x00) {
      throw new KnxError("PROPERTY_EXT_WRITE_REFUSED", `the device refused the new tool key: ${rest.toString("hex") || "no return code"}`);
    }
  }
  // Whole elements written from `start`, as many per request as the path and the device take.
  async propExtWriteElements(objectType: number, instance: number, pid: number, start: number, elementSize: number, data: Buffer): Promise<void> {
    for (const r of elementRuns(start, elementSize, data, (await this.extChunks()).propWrite)) {
      await this.propExtWriteCon(objectType, instance, pid, r.bytes, r.start, r.count);
    }
  }
  // `count` whole elements read from `start`. An answer of another length is an error, not data.
  async propExtReadElements(objectType: number, instance: number, pid: number, start: number, count: number, elementSize: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (const r of elementRuns(start, elementSize, Buffer.alloc(count * elementSize), (await this.extChunks()).propRead)) {
      const got = await this.propExtRead(objectType, instance, pid, r.start, r.count);
      if (got.length !== r.bytes.length) {
        throw new KnxError("PROPERTY_RESPONSE_MISMATCH", `object type ${objectType} PID ${pid}: asked for ${r.count} element(s) of ${elementSize} bytes from ${r.start}, got ${got.length} bytes`);
      }
      parts.push(got);
    }
    return Buffer.concat(parts);
  }
  // Whether Data Secure is switched on: the security object's PID_SECURITY_MODE, service 0, answers
  // [service, mode]. A device without the object, or any other answer, is an error, not "off".
  // Return code 0xFC is access denied: the Jung 400021SE in secure mode answers a plain read so.
  async securityMode(): Promise<boolean> {
    const { returnCode, result } = await this.funcPropExtStateRead(OBJECT_TYPE_SECURITY, 1, PID_SECURITY_MODE, Buffer.from([0x00, 0x00]));
    if (returnCode === 0xfc) {
      throw new KnxError("SECURITY_MODE_DENIED", "the device refused to show its security mode (access denied); a device in secure mode answers a request without its tool key so");
    }
    if (returnCode !== 0x00 || result.length < 2 || result[0] !== 0x00 || result[1] > 1) {
      throw new KnxError("SECURITY_MODE_UNREADABLE", `the security object answered ${Buffer.concat([Buffer.from([returnCode]), result]).toString("hex")} to a read of its security mode`);
    }
    return result[1] === 1;
  }

  // PID_MAX_APDU_LENGTH of the device object, read once per connection; null when the device does not
  // implement it. A value too small to carry one byte in an extended write is refused.
  private maxApdu: number | null | undefined;
  // Whether the application declares the extended memory services (<Options
  // SupportsExtendedMemoryServices="true">), set by the caller that knows the application. A device
  // declaring a long APDU does not by that take A_MemoryExtended_Write: the Theben DALI-Gateway (55)
  // acknowledges it on the transport layer and never answers, and ETS writes it with A_Memory_Write.
  private extendedMemory: boolean | undefined;
  setExtendedMemoryServices(on: boolean): void { this.extendedMemory = on; }
  // The interface's maximum APDU as it announces it (KnxTransport.queryMaxApdu), asked once per device,
  // before the first load-state event of a plan that writes (runLoadPlan) or else at the first memory
  // write; null where it announces none or cannot be asked. With the device's it sizes the memory writes
  // (writeChunks).
  private interfaceApdu: Promise<number | null> | undefined;
  // How the device took restart()'s probe on the transport layer: T_NAK (there, refused the sequence
  // number) or T_ACK (there, took it). Either shows it still holds the connection.
  private nakSeen = false;
  private ackSeen = false;
  // When the device last sent us a frame, and when it closed our connection (T_Disconnect to us).
  private lastFromDeviceAt: number | null = null;
  private peerClosedAt: number | null = null;
  // A negatively confirmed A_Restart whose reboot the device did not decide (RESTART_UNPROVEN) is taken
  // as ETS takes it, sent and gone on, only by a caller that reads the device back after the restart and
  // reports the gap (a flash: runFlashOp). There restart() records it instead of throwing; every other
  // restart refuses it. `restartUnproven`: such a restart happened since acceptUnprovenRestart(true).
  private unprovenRestartAccepted = false;
  private unprovenRestartSeen = false;
  acceptUnprovenRestart(on: boolean): void { this.unprovenRestartAccepted = on; this.unprovenRestartSeen = false; }
  get restartUnproven(): boolean { return this.unprovenRestartSeen; }
  interfaceMaxApdu(): Promise<number | null> {
    return (this.interfaceApdu ??= this.tun.queryMaxApdu ? this.tun.queryMaxApdu().catch(() => null) : Promise.resolve(null));
  }
  // Whether memWrite uses the confirmed extended write on this device. The load runner asks before
  // its first load-state event, where ETS reads the property too (right after the descriptor).
  async writesConfirmed(): Promise<boolean> {
    const maxApdu = await this.maxApduLength();
    if (maxApdu === null) return false;
    if (this.extendedMemory === undefined) {
      throw new KnxError("MEMORY_SERVICES_UNDECIDED",
        "the device declares a long APDU, and without its application's SupportsExtendedMemoryServices option it is unknown whether it takes the extended memory write; refusing to write it");
    }
    return this.extendedMemory;
  }
  private async maxApduLength(): Promise<number | null> {
    if (this.maxApdu !== undefined) return this.maxApdu;
    const v = await this.propReadIfPresent(0, PID_MAX_APDU_LENGTH);
    const n = v === null ? null : v.length >= 2 ? v.readUInt16BE(0) : v.length === 1 ? v[0] : null;
    if (v !== null && (n === null || n <= EXT_WRITE_OVERHEAD)) {
      throw new KnxError("DEVICE_MAX_APDU_INVALID", `the device declares a maximum APDU length of ${v.toString("hex")}, too small for a memory write`);
    }
    this.maxApdu = n;
    return n;
  }
  // The element data one A_PropertyValue_Response carries: the maximum APDU length less the response's
  // APCI, object, property, count and start (5 octets); 15 where the device declares none (standard frame).
  async propValueDataMax(): Promise<number> { return ((await this.maxApduLength()) ?? 15) - 5; }
  // An optional property: the device answers a property it does not implement with element count 0
  // (and possibly an error byte), which propRead would return as if it were a value. Null here.
  async propReadIfPresent(obj: number, pid: number): Promise<Buffer | null> {
    const tail = Buffer.from([obj, pid, 1 << 4, 1]);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_READ, tail), true);
    if (r!.data.length >= 2 && (r!.data[0] !== obj || r!.data[1] !== pid)) {
      throw new KnxError("PROPERTY_RESPONSE_MISMATCH", `a read of object ${obj} PID ${pid} was answered for object ${r!.data[0]} PID ${r!.data[1]}`);
    }
    return r!.data.length < 4 || r!.data[2] >> 4 === 0 ? null : r!.data.subarray(4);
  }
  // Bytes per A_Memory_Read: 12 fit a standard frame. A device that declares a longer APDU gets
  // requests up to that length (3 octets of APCI and address), capped at EXT_READ_CHUNK: the path
  // (interface, couplers, a single USB HID report) has its own limit, and that size is what the
  // extended reads already carry over the bench's USB interface and the house's IP interface.
  async classicReadChunk(): Promise<number> {
    return transferChunks(await this.maxApduLength(), this.secure !== undefined).classicRead;
  }
  // The extended services run at the path limits in a plain session, as they always have; a secured
  // one also fits them to the device's maximum APDU (transferChunks).
  private async extChunks(): Promise<ReturnType<typeof transferChunks>> {
    const secured = this.secure !== undefined;
    return transferChunks(secured ? await this.maxApduLength() : null, secured);
  }
  async memRead(addr: number, len: number, chunkBytes?: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Buffer> {
    // A range past the 16-bit reach of A_Memory_Read is served by A_MemoryExtended (a device that
    // allocates a segment there answers only that service). Classic path stays byte-identical below.
    if (addr >= 0 && addr + len - 1 > 0xffff) return this.memReadExtended(addr, len, undefined, onProgress, signal);
    assertAddressable(addr, len, "memory read");
    const chunk = chunkBytes ?? await this.classicReadChunk();
    // Place bytes by ADDRESS, never by concatenation. Some M112 devices refuse a single
    // MemoryRead that spans an internal memory boundary (they answer with an empty data
    // response); the old concat-and-advance-by-requested-length loop then produced a buffer
    // that was both short AND misaligned (corrupting read-back of any segment crossing such a
    // boundary). On a short/empty response we shrink the request until it fits within a
    // boundary and advance only by what was actually returned.
    const out = Buffer.alloc(len);
    let pos = 0;
    while (pos < len) {
      if (signal?.aborted) throw new KnxError("READ_ABORTED", "read aborted");
      let want = Math.min(chunk, len - pos);
      let data: Buffer;
      for (;;) {
        const a = addr + pos;
        const tail = Buffer.from([(a >> 8) & 0xff, a & 0xff]);
        const r = await this.request((s) => apdu(s, APCI.MEMORY_READ, tail, want), true);
        if (r!.apci !== APCI.MEMORY_RESPONSE) throw serviceMismatch("a memory read", r!.apci, APCI.MEMORY_RESPONSE);
        if (r!.data.length < 2 || r!.data.readUInt16BE(0) !== a) {
          throw new KnxError("MEMORY_RESPONSE_MISMATCH", `a memory read of 0x${a.toString(16)} was answered for ${r!.data.length < 2 ? "no address" : `0x${r!.data.readUInt16BE(0).toString(16)}`}`);
        }
        data = r!.data.subarray(2);
        if (data.length >= want) { data = data.subarray(0, want); break; }
        if (want === 1) throw new KnxError("DEVICE_READ_REFUSED", `memRead: device refused byte @0x${a.toString(16)}`);
        want = Math.max(1, want >> 1); // shrink to fit within the device read boundary
      }
      data.copy(out, pos);
      pos += want;
      // Progress in BYTES (done, total): chunk-count progress leaked the transfer
      // granularity to every caller, which then hardcoded the chunk size to sum
      // progress across segments (and desynced if the default ever changed).
      onProgress?.(pos, len);
    }
    return out;
  }
  // ---- raw acquisition (docs/raw-acquisition.md): read-only services that hand back what the
  // device answered, refusals included, instead of throwing them away ----
  get secured(): boolean { return this.secure !== undefined; }
  // Whether the device is reached through a KNX USB interface, whose single HID report drops a secured
  // request of 40 octets or more (SECURE_WRITE_PATH_APDU); every other link is a KNXnet/IP tunnel.
  get overUsb(): boolean { return this.tun instanceof KnxUsbTransport; }

  // The type 0 descriptor, refused unless the answer is one (deviceDescriptor takes any answer).
  async descriptorType0(): Promise<string> {
    const r = await this.request((s) => apdu(s, APCI.DEVICE_DESCRIPTOR_READ), true);
    return decodeDeviceDescriptorResponse(r!.apci, r!.data).mask;
  }
  // A_Authorize with the free key only: the access level a tool without keys gets.
  async authorizeFreeKey(): Promise<number> {
    const r = await this.request((s) => apdu(s, APCI.AUTHORIZE_REQUEST, encodeAuthorizeFreeKey()), true);
    if (r!.apci !== APCI.AUTHORIZE_RESPONSE) throw serviceMismatch("an authorize request", r!.apci, APCI.AUTHORIZE_RESPONSE);
    return decodeAuthorizeResponse(r!.data).level;
  }
  // A property description, asked by PID (propertyIndex ignored by the device) or, with PID 0, by
  // property index. An answer with PID 0 is the device saying there is nothing at that address.
  async propertyDescription(obj: number, pid: number, propertyIndex: number): Promise<PropertyDescription> {
    const tail = encodePropertyDescriptionRead(obj, pid, propertyIndex);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_DESCRIPTION_READ, tail), true);
    if (r!.apci !== APCI.PROPERTY_DESCRIPTION_RESPONSE) throw serviceMismatch("a property description read", r!.apci, APCI.PROPERTY_DESCRIPTION_RESPONSE);
    const d = decodePropertyDescription(r!.data);
    const other = d.objectIndex !== obj || (d.pid !== 0 && (pid !== 0 ? d.pid !== pid : d.propertyIndex !== propertyIndex));
    if (other) {
      throw new KnxError("PROPERTY_RESPONSE_MISMATCH", `a description of object ${obj} ${pid !== 0 ? `PID ${pid}` : `property index ${propertyIndex}`} was answered for object ${d.objectIndex} PID ${d.pid} index ${d.propertyIndex}`);
    }
    return d;
  }
  // A property value with the element count the device answered. Count 0 is returned, not thrown:
  // it is the device's answer (no such property, or a refused read).
  async propReadCounted(obj: number, pid: number, start: number, count: number): Promise<PropertyValueResponse> {
    if (!Number.isInteger(count) || count < 1 || count > 15 || !Number.isInteger(start) || start < 0 || start > 0xfff) {
      throw new KnxError("PROPERTY_ADDRESS_INVALID", `element count ${count} from ${start} does not fit a property read`);
    }
    const tail = Buffer.from([obj, pid, (count << 4) | ((start >> 8) & 0x0f), start & 0xff]);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_READ, tail), true);
    if (r!.apci !== APCI.PROPERTY_RESPONSE) throw serviceMismatch("a property read", r!.apci, APCI.PROPERTY_RESPONSE);
    const v = decodePropertyValueResponse(r!.data);
    if (v.objectIndex !== obj || v.pid !== pid || (v.count > 0 && v.start !== start) || v.count > count) {
      throw new KnxError("PROPERTY_RESPONSE_MISMATCH", `a read of object ${obj} PID ${pid} from ${start} was answered for object ${v.objectIndex} PID ${v.pid}, ${v.count} element(s) from ${v.start}`);
    }
    return v;
  }
  // Read `len` bytes from `addr` and keep every refusal: a byte the device will not give is a
  // refused piece, and the read goes on behind it. Pieces are exact, adjacent and in address order.
  // A failure that ends the read (no answer, a closed connection, an answer for another address,
  // `beforeRequest` throwing, an abort) returns what was read so far and where it stopped.
  async memReadPartial(addr: number, len: number, opts: { chunk: number; signal?: AbortSignal; beforeRequest?: () => void }): Promise<PartialMemRead> {
    const extended = addr >= 0 && addr + len - 1 > 0xffff;
    if (extended) this.assertExtAddressable(addr, len, "extended memory read");
    else assertAddressable(addr, len, "memory read");
    const chunk = Math.min(Math.max(1, Math.floor(opts.chunk)), extended ? 255 : 63); // count octet / 6-bit APCI count
    const pieces: MemPiece[] = [];
    // Adjacent pieces of the same kind join: bytes with bytes, and refusals with the same answer.
    const push = (p: MemPiece) => {
      const last = pieces[pieces.length - 1];
      if (!last || last.address + last.length !== p.address) { pieces.push(p); return; }
      if ("bytes" in last && "bytes" in p) { last.bytes = Buffer.concat([last.bytes, p.bytes]); last.length += p.length; }
      else if ("refused" in last && "refused" in p && last.refused === p.refused) last.length += p.length;
      else pieces.push(p);
    };
    let pos = 0;
    try {
      while (pos < len) {
        if (opts.signal?.aborted) throw new KnxError("READ_ABORTED", "read aborted");
        let want = Math.min(chunk, len - pos);
        const a = addr + pos;
        if (extended) {
          opts.beforeRequest?.();
          const tail = Buffer.from([want, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff]);
          const r = await this.request((s) => apdu(s, APCI.MEMORY_EXT_READ, tail), true);
          if (r!.apci !== APCI.MEMORY_EXT_READ_RESP) throw serviceMismatch("an extended memory read", r!.apci, APCI.MEMORY_EXT_READ_RESP);
          const d = r!.data;
          if (d.length < 4) throw new KnxError("MEMORY_RESPONSE_MISMATCH", `extended read @0x${a.toString(16)}: a ${d.length}-octet answer has no return code and address`);
          const echoedAt = (d[1] << 16) | (d[2] << 8) | d[3];
          if (echoedAt !== a) throw new KnxError("MEMORY_RESPONSE_MISMATCH", `extended read echoed 0x${echoedAt.toString(16)} for a request to 0x${a.toString(16)}`);
          const got = d.subarray(4, 4 + want);
          if (d[0] !== 0x00 || got.length === 0) { push({ address: a, length: want, refused: d.toString("hex") }); pos += want; continue; }
          push({ address: a, length: got.length, bytes: Buffer.from(got) });
          pos += got.length;
          continue;
        }
        // Classic: some M112 devices refuse a read that spans an internal boundary, so a short answer
        // shrinks the request; only a single byte answered short is a refused byte.
        for (;;) {
          opts.beforeRequest?.();
          const tail = Buffer.from([(a >> 8) & 0xff, a & 0xff]);
          const n = want;
          const r = await this.request((s) => apdu(s, APCI.MEMORY_READ, tail, n), true);
          if (r!.apci !== APCI.MEMORY_RESPONSE) throw serviceMismatch("a memory read", r!.apci, APCI.MEMORY_RESPONSE);
          if (r!.data.length < 2 || r!.data.readUInt16BE(0) !== a) {
            throw new KnxError("MEMORY_RESPONSE_MISMATCH", `a memory read of 0x${a.toString(16)} was answered for ${r!.data.length < 2 ? "no address" : `0x${r!.data.readUInt16BE(0).toString(16)}`}`);
          }
          const data = r!.data.subarray(2);
          if (data.length >= want) { push({ address: a, length: want, bytes: Buffer.from(data.subarray(0, want)) }); break; }
          if (want === 1) { push({ address: a, length: 1, refused: r!.data.toString("hex") }); break; }
          want = Math.max(1, want >> 1);
        }
        pos += want;
      }
      return { pieces, stopped: null };
    } catch (error) {
      return { pieces, stopped: { address: addr + pos, error } };
    }
  }

  async tableAddr(obj: number): Promise<number> {
    const b = await this.propRead(obj, PID.TABLE_REFERENCE);
    let a = 0; for (const x of b) a = (a << 8) | x; return a;
  }

  // ---- writes (ported from the proven reference; load procedure in flash.ts) ----
  async propWrite(obj: number, pid: number, data: Buffer, start = 1, count = 1): Promise<Buffer> {
    const tail = Buffer.concat([Buffer.from([obj, pid, (count << 4) | ((start >> 8) & 0x0f), start & 0xff]), data]);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_WRITE, tail), true);
    return r ? r.data.subarray(4) : Buffer.alloc(0); // device echoes the written value
  }
  // Switch the device's verify mode (PID_DEVICE_CONTROL bit 2) on or off, preserving the other
  // bits of that byte (it also carries programming mode: clobbering it would silently put the
  // device into, or out of, programming mode).
  async setVerifyMode(on: boolean): Promise<void> {
    const cur = await this.propRead(0, PID.DEVICE_CONTROL);
    // An empty answer means the device declined the read, not that the byte is zero. Treating the
    // two as the same would write a FABRICATED device-control byte back, clearing programming mode
    // and whatever else lives in it.
    if (cur.length === 0) {
      throw new KnxError("DEVICE_CONTROL_UNREADABLE",
        "the device did not answer a read of its device-control property, so its verify mode cannot be set without inventing the rest of that byte");
    }
    const want = on ? cur[0] | VERIFY_MODE : cur[0] & ~VERIFY_MODE;
    await this.propWrite(0, PID.DEVICE_CONTROL, Buffer.from([want]));
    const back = await this.propRead(0, PID.DEVICE_CONTROL);
    if (back.length === 0 || ((back[0] & VERIFY_MODE) !== 0) !== on) {
      throw new KnxError("DEVICE_CONTROL_UNREADABLE",
        `the device did not take verify mode (device control reads 0x${(back[0] ?? 0).toString(16)}); a download would then write blind, so refusing`);
    }
  }

  async memWrite(addr: number, data: Buffer, opts: { chunk?: number; verify?: boolean; echo?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
    // Past the 16-bit reach of A_Memory_Write, the device is written with A_MemoryExtended. Classic
    // path (and every device that fits in 16 bits) stays byte-identical below.
    if (addr >= 0 && addr + data.length - 1 > 0xffff) return this.memWriteExtended(addr, data, { chunk: opts.chunk, onProgress: opts.onProgress });
    // An application declaring the extended memory services, on a device that declares
    // PID_MAX_APDU_LENGTH, is written the way ETS writes it: with the confirmed A_MemoryExtended_Write,
    // one answered chunk at a time, however low the address. The classic write is acknowledged by the
    // transport layer before the firmware has stored it, and a GVS AMMA took the next chunk while still
    // storing the previous one after a segment reallocation (a byte of the com-object table landed 12
    // bytes further on). ETS captures: every application declaring the option (GVS AMMA, Jung 400021SE,
    // Theben MIX 2, OpenKNX) is written extended only; every other one classic only, also the Theben
    // DALI-Gateway, which answers the property with 55 (writesConfirmed). Like ETS, it is not read back
    // mid-bracket (see memWriteExtended); `verify` and `echo` apply to the classic write only.
    if (await this.writesConfirmed()) {
      const maxApdu = (await this.maxApduLength())!;
      const path = this.secure !== undefined ? transferChunks(maxApdu, true).extWrite : writeChunks(maxApdu, await this.interfaceMaxApdu()).ext;
      const chunk = Math.min(path, opts.chunk ?? Infinity);
      return this.memWriteExtended(addr, data, { chunk, onProgress: opts.onProgress });
    }
    assertAddressable(addr, data.length, "memory write");
    if (this.secure !== undefined) transferChunks(null, true); // refuses: no secured write fits a standard frame
    const chunk = opts.chunk ?? writeChunks(await this.maxApduLength(), await this.interfaceMaxApdu()).classic;
    const total = Math.ceil(data.length / chunk);
    let done = 0;
    for (let pos = 0; pos < data.length; ) {
      const n = Math.min(chunk, data.length - pos);
      const slice = data.subarray(pos, pos + n);
      const a = addr + pos;
      const tail = Buffer.concat([Buffer.from([(a >> 8) & 0xff, a & 0xff]), slice]);
      // `echo`: the device is in verify mode and answers each write with what actually landed in
      // its memory. Checking that HERE is what turns a dropped write into an immediate, located
      // failure instead of a silent one discovered (or not) at the end. It also paces us to the
      // speed the device can really absorb, which a fire-and-forget T_ACK does not.
      if (opts.echo) {
        const r = await this.request((s) => apdu(s, APCI.MEMORY_WRITE, tail, n), true);
        // The response echoes the address it is about. Checking it is what stops a stale or
        // retransmitted echo for an EARLIER chunk from being accepted as this chunk's proof, which
        // is a real risk here: long stretches of the com-object table are identical zero bytes, so
        // the payload alone cannot tell two chunks apart.
        const echoedAt = r!.data.length >= 2 ? r!.data.readUInt16BE(0) : -1;
        if (echoedAt !== a) {
          throw new KnxError("FLASH_VERIFY_MISMATCH",
            `the device answered a write to 0x${a.toString(16)} with an echo for 0x${echoedAt.toString(16)}; refusing to take that as proof`);
        }
        const back = r!.data.subarray(2, 2 + n);
        if (!back.equals(slice)) {
          throw new KnxError("FLASH_VERIFY_MISMATCH",
            `the device did not store the bytes written to 0x${a.toString(16)}: it reports ${back.toString("hex")} where ${slice.toString("hex")} was written`);
        }
      } else {
        await this.request((s) => apdu(s, APCI.MEMORY_WRITE, tail, n), false); // T_ACK only
      }
      pos += n;
      opts.onProgress?.(++done, total);
    }
    if (opts.verify ?? true) {
      const back = await this.memRead(addr, data.length);
      if (!back.equals(data)) throw new KnxError("FLASH_VERIFY_MISMATCH", `memWrite verify mismatch @0x${addr.toString(16)}: ${describeMismatch(data, back, addr)}`);
    }
  }

  // ---- A_MemoryExtended (3-byte address) ----
  // A device that allocates a segment past 0xFFFF answers only these services. The address is 3
  // octets (0x000000..0xFFFFFF) and the requested byte count is a payload octet (not folded into the
  // APCI, the way classic memory folds it). Request format is [count, addrHi, addrMid, addrLo, ...data
  // for a write]; the RESPONSE leads with [returnCode, addrHi, addrMid, addrLo] and then, for a read,
  // the data (no repeated count) — confirmed byte-for-byte against a Jung 400021SE on the bench. A
  // non-zero return code, or an echoed address that is not the one asked for, is refused, not trusted.
  private assertExtAddressable(addr: number, len: number, what: string): void {
    if (addr < 0 || addr + len - 1 > 0xffffff) {
      throw new KnxError("MEMORY_ADDRESS_TOO_HIGH", `${what} at 0x${addr.toString(16)} is outside the 24-bit A_MemoryExtended address space`);
    }
  }
  async memReadExtended(addr: number, len: number, chunkBytes?: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Buffer> {
    this.assertExtAddressable(addr, len, "extended memory read");
    const chunk = Math.min(Math.max(1, chunkBytes ?? (await this.extChunks()).extRead), 255); // the count is a single request octet
    const out = Buffer.alloc(len);
    let pos = 0;
    while (pos < len) {
      if (signal?.aborted) throw new KnxError("READ_ABORTED", "read aborted");
      const want = Math.min(chunk, len - pos);
      const a = addr + pos;
      const tail = Buffer.from([want, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff]);
      const r = await this.request((s) => apdu(s, APCI.MEMORY_EXT_READ, tail), true);
      const d = r!.data; // [returnCode, addr(3), data...]
      if (d.length < 4) throw new KnxError("DEVICE_READ_REFUSED", `extended read @0x${a.toString(16)}: short response (${d.length}B)`);
      if (d[0] !== 0x00) throw new KnxError("DEVICE_READ_REFUSED", `extended read @0x${a.toString(16)} returned code 0x${d[0].toString(16)}`);
      const echoedAt = (d[1] << 16) | (d[2] << 8) | d[3];
      if (echoedAt !== a) throw new KnxError("DEVICE_READ_REFUSED", `extended read echoed 0x${echoedAt.toString(16)} for a request to 0x${a.toString(16)}`);
      const got = d.subarray(4, 4 + want);
      if (got.length === 0) throw new KnxError("DEVICE_READ_REFUSED", `extended read @0x${a.toString(16)}: device returned no bytes`);
      got.copy(out, pos);
      pos += got.length;
      onProgress?.(pos, len);
    }
    return out;
  }
  // Every chunk the device confirmed with return code 0 since the last clearConfirmedWrites, with the
  // bytes it was sent (the answer carries a return code and the address, no data). ETS takes this confirmation as the check of a `Verify="true"` write on a device
  // written with A_MemoryExtended_Write (MDT IP Interface/Router: no verify mode, no read, only
  // `MemoryExtended_WriteResponse … ResultCode=E_SUCCESS` per chunk).
  private confirmed: { address: number; bytes: Buffer }[] = [];
  confirmedWrites(): ReadonlyArray<{ address: number; bytes: Buffer }> { return this.confirmed; }
  clearConfirmedWrites(): void { this.confirmed = []; }
  // Not read back: on thelsing/OpenKNX (RP2040) a memory write lands in a RAM buffer of the flash
  // erase block and a memory read returns the flash itself until the block is committed (at the
  // bracket's restart, or when a write moves to another block), so a read straight after the write
  // shows the old bytes (house OpenKNX RaumController, 2026-09-27). ETS reads nothing back either.
  // The per-chunk return code and the caller's read-back after the restart are the proof.
  async memWriteExtended(addr: number, data: Buffer, opts: { chunk?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
    this.assertExtAddressable(addr, data.length, "extended memory write");
    const chunk = Math.min(Math.max(1, opts.chunk ?? (await this.extChunks()).extWrite), 255); // the count is a single request octet
    const total = Math.ceil(data.length / chunk) || 1;
    let done = 0;
    for (let pos = 0; pos < data.length; ) {
      const n = Math.min(chunk, data.length - pos);
      const slice = data.subarray(pos, pos + n);
      const a = addr + pos;
      const tail = Buffer.concat([Buffer.from([n, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff]), slice]);
      // A_MemoryExtended_Write is CONFIRMED: the device always answers [returnCode, addr(3)]. The code
      // says the device took the chunk; a non-zero code or a mismatched address is a hard failure,
      // never taken as success.
      const r = await this.request((s) => apdu(s, APCI.MEMORY_EXT_WRITE, tail), true);
      const d = r!.data; // [returnCode, addr(3)]
      if (d.length < 4) throw new KnxError("FLASH_VERIFY_MISMATCH", `extended write @0x${a.toString(16)}: short confirmation (${d.length}B)`);
      if (d[0] !== 0x00) throw new KnxError("FLASH_VERIFY_MISMATCH", `the device rejected an extended write to 0x${a.toString(16)} with code 0x${d[0].toString(16)}`);
      const echoedAt = (d[1] << 16) | (d[2] << 8) | d[3];
      if (echoedAt !== a) throw new KnxError("FLASH_VERIFY_MISMATCH", `the device confirmed an extended write to 0x${echoedAt.toString(16)} for a write to 0x${a.toString(16)}; refusing to take that as proof`);
      this.confirmed.push({ address: a, bytes: Buffer.from(slice) });
      pos += n;
      opts.onProgress?.(++done, total);
    }
  }
  // Send A_Restart and nothing else: the caller observes the reboot itself. Every failure of the link
  // is thrown: every reboot proof reads the device's SILENCE as "it rebooted", so a frame the
  // interface never took must not reach one; that silence would mean nothing at all.
  // The one exception is a negative L_Data.con for this frame (BUS_SEND_FAILED): on TP a device that
  // reboots at once on A_Restart sends no L2 acknowledgement, so the interface confirms the frame
  // negatively although it arrived, and ETS goes on (private corpus captures/meanwell-ets-restart.log
  // CON-NEG with the unit's startup telegrams 2 s later; meanwell-ets6log-restart.txt "Restart_con ...
  // C"). Such a restart counts as sent but unconfirmed: false. Any other negative con stays an error.
  async sendRestart(): Promise<boolean> {
    try {
      await this.tun.sendCemi(cemiLData(this.me, this.dst, this.onWire(apdu(this.seq, APCI.RESTART))));
    } catch (e) {
      if ((e as { code?: string }).code !== "BUS_SEND_FAILED") throw e;
      this.seq = (this.seq + 1) & 0x0f;
      return false;
    }
    this.seq = (this.seq + 1) & 0x0f;
    return true;
  }
  // answered: the device answered the restart with error code 0. unconfirmed: the interface confirmed
  // the frame negatively (see sendRestart), which counts as sent, not as an error.
  private async sendConfirmedRestart(): Promise<{ answered: boolean; unconfirmed: boolean }> {
    let take: (p: ParsedApdu | null) => void = () => undefined;
    const answer = new Promise<ParsedApdu | null>((res) => { take = res; });
    let unconfirmed = false;
    try {
      // One try, waiting for the transport acknowledgement only: a second restart to a device that
      // is already rebooting is not sent. The answer is taken by a waiter set up before the send.
      // The device's T_ACK is the proof of delivery, not the interface's L_Data.con: an MDT IP
      // interface sends no confirmation for this frame while the device it reached acknowledges and
      // answers it, and ETS goes on without one (private corpus captures/mdt-router-ets6log-
      // {fulldownload,partial-name,partial-name-revert}.txt: "Ack arrived for ConfirmedRestart_req"
      // and its response, no "Conf after" for that Sec_req, where every other Sec_req has one).
      await this.request((s) => apdu(s, APCI.RESTART | RESTART_MASTER, Buffer.from([ERASE.CONFIRMED_RESTART, 0])), false, 1, () => { this.respResolve = (p) => take(p); }, true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "DEVICE_NOT_ANSWERING" && code !== "DEVICE_CLOSED_CONNECTION" && code !== "BUS_SEND_FAILED") { this.respResolve = null; throw e; }
      unconfirmed = code === "BUS_SEND_FAILED";
      // Unacknowledged, the frame still counts as sent, as the basic restart's does: the probe in
      // restart() must not go out with the restart's sequence number, which a device that took the
      // restart and kept running would discard as a repetition and so look rebooted.
      this.seq = (this.seq + 1) & 0x0f;
    }
    const timer = setTimeout(() => take(null), this.timeouts.restartAnswerMs);
    const r = await answer;
    clearTimeout(timer);
    if (r === null) { this.respResolve = null; return { answered: false, unconfirmed }; }
    if (r.apci !== (APCI.RESTART | RESTART_RESPONSE | RESTART_MASTER) || r.data.length < 3) {
      this.respResolve = null;
      throw new KnxError("RESTART_REFUSED", `the confirmed restart was answered with service 0x${r.apci.toString(16)} ${r.data.toString("hex")}, not an A_Restart_Response`);
    }
    if (r.data[0] !== 0) { this.respResolve = null; throw new KnxError("RESTART_REFUSED", `the device refused the confirmed restart with error code ${r.data[0]}`); }
    this.respResolve = null;
    return { answered: true, unconfirmed };
  }


  // A_Restart, acknowledged — never fired blind.
  //
  // This is the step that makes a download STICK, and it is the least obvious one in the whole
  // sequence. LoadCompleted does not persist anything on this stack: it flushes the flash buffer
  // and no more. The flash METADATA — the four load states, the table addresses, the individual
  // address, everything the device validates on its next boot — is written from exactly one place
  // reachable over the bus: `BauSystemB::restartRequestIndication()`, i.e. on receiving A_Restart.
  //
  // It used to be sent with `catch {}` and the note "no reliable KNX ack expected". It was not
  // arriving (a connection-oriented link dies after 6s of silence, and it was being sent after an
  // 8s pause), and nothing noticed, because nothing was looking. The device carried on with a
  // perfect configuration in RAM, answered every verification we had, and lost all of it at the
  // next power-down.
  //
  // The acknowledgement cannot be the proof: the device reboots so promptly that it does not get one
  // out (hardware-checked — requiring the ack failed every download that had in fact worked). So the
  // proof is the other way round: after the restart, the device must have STOPPED answering. It went
  // away with its connection. A device that ignored the restart is still there, still holding the
  // link the plan re-opened one step earlier, and still answering — and that is the failure being
  // caught here, the one that hid for an entire evening: everything downstream (the load states, the
  // three tables, the device's own CRC over the parameter segment) would then be read out of the RAM
  // of a device that never wrote a byte to flash, and every single check would pass.
  //
  // Note what is NOT done: probing the link before the restart. A configured OpenKNX device does not
  // reliably answer DeviceDescriptor_Read while its application is running (observed on hardware,
  // cause not yet established), so a pre-probe turns every successful download into a failure. The
  // link is fresh by construction instead — `disconnect` + `connect` immediately precede this in the
  // plan, and a test pins them there.
  // `requireReboot` (default true) demands the device prove it rebooted, by going silent. That is
  // right for firmware that persists its configuration ON the restart (thelsing/knx, OpenKNX): if it
  // does not reboot, nothing was written to flash and the device comes back factory-fresh. Some
  // firmware instead persists at LoadCompleted, before the restart, and does not go silent on
  // A_Restart at all (hardware-verified on the GVS AMMA: the configuration survived a power cycle
  // even though the device kept answering here). For those, a restart that does not reboot is not a
  // failure, so the caller passes requireReboot=false. The A_Restart is still sent either way.
  // `confirmed`: the confirmed restart, A_Restart type 1 with erase code 1 (CONFIRMED_RESTART) and
  // channel 0, which ETS sends at the end of a System B download (Theben MIX 2 captures, ETS6.log
  // "ConfirmedRestart_req"). The device answers it with A_Restart_Response, an error code and the
  // seconds it needs, and reboots. An error code other than 0 is a refused restart. No answer is
  // allowed: the device may be gone before it gets one out, and the silence below is the proof.
  // The confirmed restart is the exception: the device's own answer (error 0) is the proof, and with
  // it `requireReboot` is not asked (see below).
  async restart(requireReboot = true, confirmed = false): Promise<void> {
    // A confirmed restart the device answered with error code 0 is proven by that answer: ETS takes
    // it and disconnects without probing (captures/mdt-router-ets6log-{fulldownload,partial-name,
    // partial-name-revert}.txt). A probe would also go out while an interface that is itself
    // restarting, or serving a unit that is, takes no frame (an MDT IP router behind its sibling).
    // An A_Restart (plain or confirmed) the interface confirmed negatively (see sendRestart) has its own
    // proof (proveUnconfirmedRestart).
    let unconfirmed: boolean;
    const sentAt = Date.now();
    if (confirmed) {
      const sent = await this.sendConfirmedRestart();
      if (sent.answered) return;
      unconfirmed = sent.unconfirmed;
    } else unconfirmed = !(await this.sendRestart());
    if (unconfirmed) return this.proveUnconfirmedRestart(sentAt);
    try {
      this.nakSeen = false; this.ackSeen = false;
      await this.deviceDescriptor(); // rebooting firmware must NOT answer
    } catch (e) {
      // A failure of the link to the interface says nothing about the device: whether the probe
      // reached it is unknown, so it is no proof of the reboot.
      if (isLinkFailure(e)) throw e;
      // T_NAK or T_ACK without an answer: the device is still there on this connection.
      if ((this.nakSeen || this.ackSeen) && requireReboot) {
        throw new KnxError("RESTART_IGNORED", `the device ${this.nakSeen ? "refused" : "acknowledged"} the probe after A_Restart on the same connection (T_${this.nakSeen ? "NAK" : "ACK"}): it is still there and did not reboot`);
      }
      return;                        // gone. It restarted, and it wrote its flash on the way out.
    }
    if (!requireReboot) return;      // this firmware persisted at LoadCompleted; a live device is fine
    throw new KnxError("RESTART_IGNORED",
      "the device kept answering on the same connection after A_Restart: it did not reboot, so it never wrote its configuration to flash and would come back factory-fresh at the next power-down");
  }

  // After a negatively confirmed A_Restart nothing shows the frame arrived, and an unacknowledged or
  // unanswered probe shows nothing either: a device that stops acknowledging for a while without
  // rebooting looks the same. So the probe goes out on the same connection, one try at a time, until
  // the device itself decides: T_Disconnect to us means it rebooted (it lost the connection with it);
  // an answer, T_ACK or T_NAK means it is still there on the connection (RESTART_IGNORED, whatever
  // requireReboot says). A probe that fails, on the bus or on the link to the interface, decides
  // nothing. A device closes an idle connection by itself 6 s after the last frame it took, so the
  // T_Disconnect counts only when it arrived within restartProofMs of the device's last frame to us
  // (the acknowledgement of the frame before the restart), or of the restart where there was none.
  // Without the device's decision by then the restart is not proven (RESTART_UNPROVEN), and where a
  // probe failed on the link to the interface, that failure is thrown: whether the probes reached the
  // device at all is then unknown.
  private async proveUnconfirmedRestart(sentAt: number): Promise<void> {
    const deadline = Math.min(this.lastFromDeviceAt ?? sentAt, sentAt) + this.timeouts.restartProofMs;
    let linkFailure: Error | null = null;
    const unproven = (): void => {
      // A T_Disconnect between two probes, inside the window, is the proof as well.
      if (this.peerClosedAt !== null && this.peerClosedAt <= deadline) return;
      if (linkFailure !== null) throw linkFailure;
      if (this.unprovenRestartAccepted) { this.unprovenRestartSeen = true; return; }
      throw new KnxError("RESTART_UNPROVEN",
        `the interface confirmed A_Restart negatively, and within ${this.timeouts.restartProofMs} ms of the device's last frame it neither closed the connection nor answered on it: whether it restarted, and so stored its configuration, is not proven`);
    };
    this.peerClosedAt = null;
    // The probe keeps its sequence number until the device takes one, so a T_ACK or T_NAK that arrives
    // after a probe's negative confirmation (the interface's repetitions keep the bus busy before it)
    // still belongs to the probe: the flags are cleared once and read before every try.
    this.nakSeen = false; this.ackSeen = false;
    const present = () => new KnxError("RESTART_IGNORED",
      `the interface confirmed A_Restart negatively and the device ${this.nakSeen ? "refused (T_NAK)" : "acknowledged (T_ACK)"} the next frame on the same connection: it never restarted`);
    for (;;) {
      if (this.nakSeen || this.ackSeen) throw present();
      try {
        await this.request((sq) => apdu(sq, APCI.DEVICE_DESCRIPTOR_READ), true, 1);
        throw new KnxError("RESTART_IGNORED",
          "the interface confirmed A_Restart negatively and the device kept answering on the same connection: nothing shows the restart reached it");
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "RESTART_IGNORED") throw e;
        // A T_ACK or T_NAK before the T_Disconnect: the device still held the connection.
        if (this.nakSeen || this.ackSeen) throw present();
        if (code === "DEVICE_CLOSED_CONNECTION") {
          if (this.peerClosedAt !== null && this.peerClosedAt <= deadline) return;
          return unproven();
        }
        if (isLinkFailure(e)) linkFailure = e as Error;
      }
      if (Date.now() >= deadline) {
        if (this.nakSeen || this.ackSeen) throw present();
        return unproven();
      }
      await new Promise((r) => setTimeout(r, this.timeouts.retryGapMs));
    }
  }

  // Factory-reset the device over the bus (A_Restart with RestartType = MasterReset and an erase
  // code). This is the standard KNX service, not a back door: it is how a device is returned to the
  // state it left the factory in, and on a device whose only other reset is a button or a console,
  // it is the only way to do it at all. It DESTROYS the configuration, and for most erase codes the
  // individual address with it, so the caller has to mean it.
  //
  // Erase codes (thelsing/knx knx_types.h EraseCode, and the KNX standard): see ERASE above.
  async masterReset(eraseCode: number = ERASE.FACTORY_RESET, channel = 0): Promise<void> {
    // NOT swallowed, for the same reason as restart() above: the send must succeed even though the
    // ack may not. A sendCemi failure means the frame never left the interface, so the device still
    // holds its full configuration, and reporting that as a completed factory reset is exactly the
    // silent-failure the restart() comment describes. Only the device's post-send silence (it
    // reboots and does not ack) is tolerated, and that is not what sendCemi rejects on.
    await this.tun.sendCemi(cemiLData(this.me, this.dst,
      this.onWire(apdu(this.seq, APCI.RESTART | RESTART_MASTER, Buffer.from([eraseCode, channel])))));
    this.seq = (this.seq + 1) & 0x0f;
  }
}

// The security mode as the device states it. "denied" is a device that will not show it without
// its tool key; "unreadable" one that answered in no form understood here, or not at all (not every
// device has a security object). A failure of the link itself is thrown, never reported as either.
// After a device timeout the transport sequence is not advanced: keep this a session's last request.
export type SecurityModeReading = { state: "on" | "off" } | { state: "denied" | "unreadable"; detail: string };
const DEVICE_SIDE_SECURITY_MODE_FAILURES = new Set(["SECURITY_MODE_UNREADABLE", "PROPERTY_RESPONSE_MISMATCH", "DEVICE_NOT_ANSWERING", "DEVICE_CLOSED_CONNECTION", "SECURE_ANSWER_REJECTED"]);
export async function readSecurityMode(dev: Pick<KnxDevice, "securityMode">): Promise<SecurityModeReading> {
  try {
    return { state: (await dev.securityMode()) ? "on" : "off" };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    const detail = e instanceof Error ? e.message : String(e);
    if (code === "SECURITY_MODE_DENIED") return { state: "denied", detail };
    if (DEVICE_SIDE_SECURITY_MODE_FAILURES.has(code)) return { state: "unreadable", detail };
    throw e;
  }
}

// Where a read-back differs from what was written, so a failed verify names the bytes, not only the
// segment: the first differing address, how many bytes differ, and a few bytes on each side.
function describeMismatch(wrote: Buffer, read: Buffer, addr: number): string {
  if (read.length !== wrote.length) return `read back ${read.length} of ${wrote.length} bytes`;
  const diff = [...wrote.keys()].filter((i) => wrote[i] !== read[i]);
  const i = diff[0];
  const from = Math.max(0, i - 4), to = Math.min(wrote.length, i + 12);
  return `${diff.length} of ${wrote.length} bytes differ, first at 0x${(addr + i).toString(16)} (offset ${i}): wrote ${wrote.subarray(from, to).toString("hex")}, read ${read.subarray(from, to).toString("hex")} from 0x${(addr + from).toString(16)}`;
}
