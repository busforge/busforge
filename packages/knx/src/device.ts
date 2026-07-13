import { randomBytes } from "node:crypto";
import type { KnxTransport } from "./transport.ts";
import type { SecureSession } from "./secureSession.ts";
import { cemiLData, tpConnect, tpDisconnect, tpAck, apdu, parseApdu, iaToNum, APCI, type ParsedApdu } from "./frame.ts";
import { KnxError } from "./errors.ts";

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

// A_Restart carries its type in the low bits of its APCI: 0 = a plain reboot, 1 = a master reset,
// which then takes an erase code saying how much to throw away.
export const RESTART_MASTER = 0x01;
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

// A_Memory_Read/Write carry a 2-BYTE address, so they reach 0x0000..0xFFFF and no further. A
// device may well allocate a segment above that (the KNX answer is A_MemoryExtended, which this
// transport does not speak yet). Truncating the address silently would write the right bytes to
// the WRONG place, which on a load-state machine means a device that comes up believing a table
// it never received. Refuse instead, and say what is missing.
function assertAddressable(addr: number, len: number, what: string): void {
  const last = addr + len - 1;
  if (addr < 0 || last > 0xffff) {
    throw new KnxError("MEMORY_ADDRESS_TOO_HIGH",
      `${what} at 0x${addr.toString(16)}..0x${last.toString(16)} is beyond the 16-bit address these memory services reach; this device needs A_MemoryExtended, which Busforge does not implement yet`);
  }
}

export class KnxDevice {
  private dst: number;
  private seq = 0;
  private ackResolve: (() => void) | null = null;
  private respResolve: ((p: ParsedApdu) => void) | null = null;
  // During the Sync handshake, raw frames are diverted here (the Sync response is not
  // a normal secure data frame, so it bypasses the request machinery).
  private rawInbox: Buffer[] | null = null;
  private rawNotify: (() => void) | null = null;

  constructor(private tun: KnxTransport, ia: string, private secure?: SecureSession) {
    this.dst = iaToNum(ia);
    tun.onCemi = (src, dst, tpdu, isGroup) => this.onCemi(src, dst, tpdu, isGroup);
  }
  private get me() { return this.tun.assignedIa; }

  private onCemi(src: number, _dst: number, tpdu: Buffer, isGroup: boolean) {
    if (isGroup || src !== this.dst) return;
    if (this.rawInbox) { this.rawInbox.push(Buffer.from(tpdu)); this.rawNotify?.(); return; }
    const outer = parseApdu(tpdu);
    if (outer.control) { if (outer.seq === this.seq) this.ackResolve?.(); return; }
    // For a secure session the data frame is a wrapped secure APDU: ACK the outer
    // numbered frame, then deliver the decrypted inner APDU. A failed MAC is dropped
    // (the request times out and can re-sync) rather than surfaced as fake data. A
    // MAC-valid REPLAY (a retransmission after our T_ACK was lost) is still ACKed so the
    // device stops retransmitting, but is not re-delivered.
    let p = outer;
    if (this.secure) {
      const inner = this.secure.unwrap(tpdu);
      if (inner.status === "invalid") return;
      if (inner.status === "replay") { this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck(outer.seq))).catch(() => {}); return; }
      p = parseApdu(inner.apdu);
    }
    this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck(outer.seq))).then(() => this.respResolve?.(p)).catch(() => {});
  }

  async connect() {
    this.seq = 0;
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
      await this.tun.sendCemi(cemiLData(this.me, this.dst, sec.buildSyncRequest(sec.serial, challenge, this.seq)));
      const rsp = await this.rawNext();
      await this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck((rsp[0] >> 2) & 0x0f))); // ACK the device's Sync.res
      if (!sec.applySyncResponse(rsp, challenge)) throw new KnxError("SECURE_SYNC_FAILED", "secure Sync failed (MAC mismatch)");
      this.seq = (this.seq + 1) & 0x0f; // the Sync request consumed this T-sequence
    } finally { this.rawInbox = null; this.rawNotify = null; }
  }

  // Next non-control (data) frame during Sync; skips the device's T_ACK.
  private rawNext(ms = 3000): Promise<Buffer> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.rawNotify = null; rej(new Error("secure Sync: no response")); }, ms);
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

  private async request(build: (seq: number) => Buffer, expectResponse: boolean, tries = 3): Promise<ParsedApdu | null> {
    for (let i = 0; i < tries; i++) {
      const ackP = new Promise<boolean>((res) => { this.ackResolve = () => res(true); setTimeout(() => res(false), 1500); });
      const respP = expectResponse
        ? new Promise<ParsedApdu | null>((res) => { this.respResolve = (p) => res(p); setTimeout(() => res(null), 2000); })
        : Promise.resolve<ParsedApdu | null>(null);
      // Plain: send the numbered APDU as-is. Secure: strip the numbering to the bare
      // service APDU (inner TPCI 0) and wrap it for this T-sequence.
      let tpdu = build(this.seq);
      if (this.secure) { const svc = Buffer.from(tpdu); svc[0] &= 0x03; tpdu = this.secure.wrapManagement(svc, this.seq); }
      await this.tun.sendCemi(cemiLData(this.me, this.dst, tpdu));
      if (!(await ackP)) continue;
      if (!expectResponse) { this.seq = (this.seq + 1) & 0x0f; return null; }
      const r = await respP;
      if (r === null) continue;
      this.seq = (this.seq + 1) & 0x0f;
      return r;
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
  async memRead(addr: number, len: number, chunk = 12, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Buffer> {
    assertAddressable(addr, len, "memory read");
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
        data = r!.data.subarray(2); // skip echoed address
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
    assertAddressable(addr, data.length, "memory write");
    const chunk = opts.chunk ?? 12;
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
      if (!back.equals(data)) throw new KnxError("FLASH_VERIFY_MISMATCH", `memWrite verify mismatch @0x${addr.toString(16)}`);
    }
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
  async restart(): Promise<void> {
    // NOT swallowed. The proof below reads the device's SILENCE as "it rebooted", so a frame the
    // interface never even accepted must not reach it: that silence would then mean nothing at all,
    // and we would report a device as saved that was never told to save.
    await this.tun.sendCemi(cemiLData(this.me, this.dst, apdu(this.seq, APCI.RESTART)));
    this.seq = (this.seq + 1) & 0x0f;
    try {
      await this.deviceDescriptor(); // must NOT answer: it is rebooting
    } catch {
      return;                        // gone. It restarted, and it wrote its flash on the way out.
    }
    throw new KnxError("RESTART_IGNORED",
      "the device kept answering on the same connection after A_Restart: it did not reboot, so it never wrote its configuration to flash and would come back factory-fresh at the next power-down");
  }

  // Factory-reset the device over the bus (A_Restart with RestartType = MasterReset and an erase
  // code). This is the standard KNX service, not a back door: it is how a device is returned to the
  // state it left the factory in, and on a device whose only other reset is a button or a console,
  // it is the only way to do it at all. It DESTROYS the configuration, and for most erase codes the
  // individual address with it, so the caller has to mean it.
  //
  // Erase codes (thelsing/knx knx_types.h EraseCode, and the KNX standard): see ERASE above.
  async masterReset(eraseCode: number = ERASE.FACTORY_RESET, channel = 0): Promise<void> {
    try {
      await this.tun.sendCemi(cemiLData(this.me, this.dst,
        apdu(this.seq, APCI.RESTART | RESTART_MASTER, Buffer.from([eraseCode, channel]))));
    } catch { /* the device reboots; no reliable ack is expected */ }
    this.seq = (this.seq + 1) & 0x0f;
  }
}
