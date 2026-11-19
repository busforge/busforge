import { test, expect, describe, setDefaultTimeout } from "bun:test";
import type { KnxTransport } from "../src/transport.ts";
import { parseCemiLData } from "../src/transport.ts";
import { assignAddress, assignSecureAddressBySerial } from "../src/individualaddress.ts";
import { apduUnnumbered, parseApdu, iaToNum, numToIa, APCI, BROADCAST } from "../src/frame.ts";
import { secureEncode, secureDecode } from "../src/secure.ts";
import { DEVICE_TIMEOUTS } from "../src/device.ts";

setDefaultTimeout(60_000);

// Giving a Data Secure device its address by serial, under its key, against a simulated device that opens
// and answers Busforge's secured frames as the Jung 400021SE and the GVS AMMA-04/06.S answer ETS's. The
// transcripts below are the frames ETS sends in the private corpus's captures
// internal/captures/progmode-end-2026-11-19 (README), decrypted, with the serial, the addresses and the
// keys of the test in place of the bench's: the Jung with Data Secure on, not in programming mode
// (i1-jung-secure-ia-noprog-204to214.log lines 67-157), the GVS with Data Secure on (c1-gvs-ia-203to213.log
// lines 33-119) and the Jung with Data Secure off in the project, under its factory key
// (a2-jung-plain-ia-204to214.log lines 33-103). Sequence numbers and the challenge are left out: they are
// clocks and random. What Busforge adds is listed apart: the free-address check after the serial read (ETS
// runs it first, i1 lines 20-32) and the programming-mode check after the restart.

const KEY = Buffer.alloc(16, 0x5a), OTHER = Buffer.alloc(16, 0x33);
const SERIAL = Buffer.from("00fa01020304", "hex");
const OLD = "1.1.40", NEW = "1.1.50";
const TOOL = iaToNum("1.1.100");

const seq6 = (n: bigint) => { const b = Buffer.alloc(6); b.writeUIntBE(Number(n), 0, 6); return b; };
const seqNum = (b: Buffer) => BigInt(b.readUIntBE(0, 6));

class SecureDevice {
  ia: string;
  mode: boolean;
  progMode = false;
  key: Buffer;
  sending = 0x10_0000n;   // the device's sending counter (PID 59)
  toolNext = 0x20_0000n;  // the lowest tool sequence it takes next
  restarts = 0;
  t = 0;                  // the device's transport sequence on the open connection
  // `ignoreRestart`: the device answers the confirmed restart but stays in programming mode.
  ignoreRestart = false;
  // Faults: the Sync answered under another key, or from another address; the mode switch-on refused;
  // the confirmed restart answered with an error code.
  syncKey: Buffer | null = null;
  syncFrom: string | null = null;
  refuseModeOn = false;
  refuseRestart = false;
  constructor(opts: { ia?: string; mode?: boolean; key?: Buffer; progMode?: boolean }) {
    this.ia = opts.ia ?? OLD; this.mode = opts.mode ?? true; this.key = opts.key ?? KEY; this.progMode = opts.progMode ?? false;
  }
}

class Bus implements KnxTransport {
  readonly assignedIa = TOOL;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  // Every frame Busforge sent, decrypted with the device's key where it is secured.
  wire: string[] = [];
  // The form of every frame Busforge sent, as frameShape gives it.
  shapes: string[] = [];
  constructor(public dev: SecureDevice, public writes: string[] = []) {}
  async connect() {}
  async disconnect() {}

  private deliver(src: number, dst: number, tpdu: Buffer, isGroup: boolean) { queueMicrotask(() => this.onCemi?.(src, dst, tpdu, isGroup)); }
  private open(tpdu: Buffer, src: number, dst: number, group: boolean): { scf: number; seq: bigint; pt: Buffer; serial?: Buffer } | null {
    const body = tpdu.subarray(2);
    const scf = body[0];
    if ((scf & 0x07) === 2) {
      const serial = Buffer.from(body.subarray(7, 13));
      const r = secureDecode(Buffer.concat([body.subarray(0, 7), body.subarray(13)]), { key: this.dev.key, src, dst, dstIsGroup: group, tpci: tpdu[0], aadFor: (s) => Buffer.concat([Buffer.from([s]), serial]) });
      return r ? { scf, seq: seqNum(r.seq), pt: r.plaintext, serial } : null;
    }
    const r = secureDecode(body, { key: this.dev.key, src, dst, dstIsGroup: group, tpci: tpdu[0], aadFor: (s) => Buffer.from([s]) });
    return r ? { scf, seq: seqNum(r.seq), pt: r.plaintext } : null;
  }
  private seal(pt: Buffer, dst: number, group: boolean, tpci: number): Buffer {
    const body = secureEncode({ key: this.dev.key, src: iaToNum(this.dev.ia), dst, dstIsGroup: group, seq: seq6(this.dev.sending++), scf: 0x90, tpci, aad: Buffer.from([0x90]), plaintext: pt });
    return Buffer.concat([Buffer.from([tpci, 0xf1]), body]);
  }
  private syncAnswer(req: { seq: bigint; pt: Buffer }, dst: number, group: boolean, tpci: number): Buffer {
    this.dev.toolNext = req.seq > this.dev.toolNext ? req.seq + 1n : this.dev.toolNext;
    const random = Buffer.from("a1a2a3a4a5a6", "hex");
    const body = secureEncode({ key: this.dev.syncKey ?? this.dev.key, src: iaToNum(this.dev.ia), dst, dstIsGroup: group, seq: random, scf: 0x93, tpci, aad: Buffer.from([0x93]), plaintext: Buffer.concat([seq6(this.dev.sending), seq6(this.dev.toolNext)]) });
    for (let i = 0; i < 6; i++) body[1 + i] ^= req.pt[i];
    return Buffer.concat([Buffer.from([tpci, 0xf1]), body]);
  }

  async sendCemi(cemi: Buffer): Promise<void> {
    const { src, dst, tpdu, isGroup } = parseCemiLData(cemi);
    this.shapes.push(frameShape(cemi));
    const d = this.dev;
    const me = iaToNum(d.ia);
    const secured = tpdu.length >= 2 && (tpdu[0] & 0x03) === 0x03 && tpdu[1] === 0xf1;
    if (isGroup && dst === BROADCAST) {
      if (!secured) {
        const p = parseApdu(tpdu);
        this.wire.push(`bc ${tpdu.toString("hex")}`);
        if (p.apci === APCI.IA_SERIAL_READ && p.data.subarray(0, 6).equals(SERIAL)) this.deliver(me, BROADCAST, apduUnnumbered(APCI.IA_SERIAL_RESPONSE, Buffer.concat([SERIAL, Buffer.alloc(4)])), true);
        if (p.apci === APCI.INDIVIDUAL_ADDRESS_READ && d.progMode) this.deliver(me, BROADCAST, apduUnnumbered(APCI.INDIVIDUAL_ADDRESS_RESPONSE), true);
        if (p.apci === APCI.INDIVIDUAL_ADDRESS_WRITE && d.progMode) { d.ia = numToIa((p.data[0] << 8) | p.data[1]); this.writes.push(`plain ${d.ia}`); }
        return;
      }
      if (tpdu[2] === 0x92 && !tpdu.subarray(9, 15).equals(SERIAL)) { this.wire.push("bc sync for another serial"); return; }
      const f = this.open(tpdu, src, BROADCAST, true);
      if (!f) { this.wire.push(`bc secured scf=${tpdu[2].toString(16)} (not under the device's key)`); return; }
      if (f.scf === 0x92) {
        this.wire.push(`bc sync sn=${f.serial!.toString("hex")} tpci=${tpdu[0].toString(16)}`);
        this.deliver(d.syncFrom ? iaToNum(d.syncFrom) : me, BROADCAST, this.syncAnswer(f, BROADCAST, true, 0x03), true);
        return;
      }
      this.wire.push(`bc secured ${f.pt.toString("hex")} tpci=${tpdu[0].toString(16)}`);
      if (f.seq < d.toolNext) return; // a replay
      d.toolNext = f.seq + 1n;
      const p = parseApdu(f.pt);
      if (p.apci === APCI.IA_SERIAL_WRITE && p.data.subarray(0, 6).equals(SERIAL)) { d.ia = numToIa((p.data[6] << 8) | p.data[7]); this.writes.push(d.ia); }
      if (p.apci === APCI.IA_SERIAL_READ && p.data.subarray(0, 6).equals(SERIAL)) this.deliver(iaToNum(d.ia), BROADCAST, this.seal(apduUnnumbered(APCI.IA_SERIAL_RESPONSE, Buffer.concat([SERIAL, Buffer.alloc(4)])), BROADCAST, true, 0x03), true);
      return;
    }
    if (isGroup || dst !== me) { this.wire.push(`to ${numToIa(dst)} ${tpdu.toString("hex")}`); return; }
    const t0 = tpdu[0];
    if (t0 === 0x80) { this.wire.push("T_Connect"); d.t = 0; return; }
    if (t0 === 0x81) { this.wire.push("T_Disconnect"); return; }
    if ((t0 & 0xc3) === 0xc2) { this.wire.push(`T_ACK ${(t0 >> 2) & 0x0f}`); return; }
    const tseq = (t0 >> 2) & 0x0f;
    const answer = (pt: Buffer, sec: boolean) => {
      const tpci = 0x40 | (d.t << 2) | (pt[0] & 0x03);
      const frame = sec ? this.seal(Buffer.concat([Buffer.from([pt[0] & 0x03]), pt.subarray(1)]), TOOL, false, 0x40 | (d.t << 2) | 0x03) : Buffer.concat([Buffer.from([tpci]), pt.subarray(1)]);
      d.t = (d.t + 1) & 0x0f;
      this.deliver(me, TOOL, frame, false);
    };
    this.deliver(me, TOOL, Buffer.from([0xc2 | (tseq << 2)]), false); // T_ACK
    if (!secured) {
      const p = parseApdu(tpdu);
      this.wire.push(`plain ${tpdu.toString("hex")}`);
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) answer(Buffer.from(d.mode ? "0340ffff" : "034007b0", "hex"), false);
      if (p.apci === APCI.PROPERTY_READ && p.data[1] === 56) answer(Buffer.from("03d60038100100e9", "hex"), false);
      if (p.apci === APCI.RESTART && !d.mode) { d.restarts++; d.progMode = false; } // a unit in secure mode ignores a plain restart
      return;
    }
    const f = this.open(tpdu, TOOL, me, false);
    if (!f) { this.wire.push(`secured scf=${tpdu[2].toString(16)} (not under the device's key)`); return; }
    if (f.scf === 0x92) {
      this.wire.push(`sync sn=${f.serial!.toString("hex")} tpci=${t0.toString(16)}`);
      const tpci = 0x40 | (d.t << 2) | 0x03;
      d.t = (d.t + 1) & 0x0f;
      this.deliver(me, TOOL, this.syncAnswer(f, TOOL, false, tpci), false);
      return;
    }
    const pt = f.pt.toString("hex");
    this.wire.push(`secured ${pt.startsWith("01ce001100103801") ? pt.slice(0, 16) + "<key>" : pt} tpci=${t0.toString(16)}`);
    if (f.seq < d.toolNext) return;
    d.toolNext = f.seq + 1n;
    const p = parseApdu(f.pt);
    const head = p.data.subarray(0, 5);
    if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) answer(Buffer.from("034007b0", "hex"), true);
    else if (p.apci === APCI.FUNCTION_PROPERTY_EXT_COMMAND) {
      if (!d.refuseModeOn) d.mode = true;
      answer(Buffer.concat([Buffer.from("01d6", "hex"), head, Buffer.from([d.refuseModeOn ? 0xf2 : 0, 0])]), true);
    }
    else if (p.apci === APCI.FUNCTION_PROPERTY_EXT_STATE_READ) answer(Buffer.concat([Buffer.from("01d6", "hex"), head, Buffer.from([0, 0, d.mode ? 1 : 0])]), true);
    else if (p.apci === APCI.PROPERTY_EXT_WRITE_CON) {
      const pid = ((head[3] & 0x0f) << 8) | head[4];
      if (pid === 56) d.key = Buffer.from(p.data.subarray(8, 24));
      if (pid === 59) d.sending = seqNum(p.data.subarray(8, 14));
      answer(Buffer.concat([Buffer.from("01cf", "hex"), head, Buffer.from([1, 0, 1, 0])]), true);
    } else if (p.apci === APCI.PROPERTY_READ && p.data[1] === 11) answer(Buffer.concat([Buffer.from("03d6000b1001", "hex"), SERIAL]), true);
    else if (p.apci === (APCI.RESTART | 0x01)) {
      if (d.refuseRestart) { answer(Buffer.from("03a1010000", "hex"), true); return; }
      answer(Buffer.from("03a1000000", "hex"), true);
      d.restarts++;
      if (!d.ignoreRestart) d.progMode = false;
    }
  }
}

// A tool frame as the capture shows it without its keys: broadcast or point to point, standard or extended
// frame (control field 1, bit 7), the outer TPCI octet, the SCF of a secured one, the TPDU's length.
function frameShape(cemi: Buffer): string {
  const o = 2 + cemi[1];
  const tpdu = cemi.subarray(o + 7);
  const sec = tpdu.length >= 2 && (tpdu[0] & 3) === 3 && tpdu[1] === 0xf1;
  return `${(cemi[o + 1] & 0x80) ? "bc" : "p2p"} ${(cemi[o] & 0x80) ? "std" : "ext"} ${tpdu[0].toString(16)}${sec ? ` scf=${tpdu[2].toString(16)}` : ""} ${tpdu.length}`;
}
// ETS's frames in that form, every one it sent from the serial read (Data Secure on, i1 L67-L157; the GVS's
// c1 L33-L119 has the same from the Sync on) and from the Sync (Data Secure off, a2 L33-L103).
const ETS_SHAPES_ON = ["bc std 3 8", "bc ext 3 scf=92 25", "bc ext 3 scf=90 27", "bc ext 3 scf=90 21", "p2p std 80 1", "p2p std 43 2", "p2p std c2 1", "p2p std 47 6", "p2p std c6 1", "p2p ext 4b scf=92 25", "p2p std ca 1", "p2p std 4f scf=90 15", "p2p std ce 1", "p2p ext 53 scf=90 23", "p2p std d2 1", "p2p ext 57 scf=90 39", "p2p std d6 1", "p2p ext 5b scf=90 29", "p2p std da 1", "p2p ext 5f scf=90 19", "p2p std de 1", "p2p ext 63 scf=90 17", "p2p std e2 1", "p2p std 81 1"];
const ETS_SHAPES_OFF = ["bc ext 3 scf=92 25", "bc ext 3 scf=90 27", "bc ext 3 scf=90 21", "p2p std 80 1", "p2p std 43 2", "p2p std c2 1", "p2p std 47 6", "p2p std c6 1", "p2p ext 4b scf=92 25", "p2p std ca 1", "p2p ext 4f scf=90 22", "p2p std ce 1", "p2p ext 53 scf=90 22", "p2p std d2 1", "p2p ext 57 scf=90 19", "p2p std d6 1", "p2p ext 5b scf=90 17", "p2p std da 1", "p2p std 81 1"];
// Busforge's own frames around them: the free-address check after the serial read (5) and the check after
// the restart (5).
const withoutBusforgeChecks = (shapes: string[]) => [shapes[0], ...shapes.slice(6, -5)];

const fast = { probeMs: 30, settleMs: 5, returnMs: 0 };
const NEW_HEX = iaToNum(NEW).toString(16).padStart(4, "0");
const SN = SERIAL.toString("hex");

// ETS's frames, in its order, from the serial read on.
const SERIAL_READ = [`bc 03dc${SN}`];
// Nothing answers at the target: T_Connect, the descriptor read in its three tries, T_Disconnect.
const BUSFORGE_FREE_CHECK = [`to ${NEW} 80`, `to ${NEW} 4300`, `to ${NEW} 4300`, `to ${NEW} 4300`, `to ${NEW} 81`];
const BROADCAST_PART = [
  `bc sync sn=${SN} tpci=3`,                      // i1 L71, c1 L33, a2 L33
  `bc secured 03de${SN}${NEW_HEX}00000000 tpci=3`, // i1 L75
  `bc secured 03dc${SN} tpci=3`,                  // i1 L78
];
const CONNECTION_OPEN = [
  "T_Connect", "plain 4300", "T_ACK 0",           // i1 L82-L90
  "plain 47d500381001", "T_ACK 1",                // i1 L93-L98: PID_MAX_APDU_LENGTH
  "sync sn=000000000000 tpci=4b", "T_ACK 2",      // i1 L101-L106
];
const SECURED_DESCRIPTOR = ["secured 0300 tpci=4f", "T_ACK 3"]; // i1 L109-L114, after a plain FFFF only
const DATA_SECURE_ON = [
  "secured 01d40011001033000001 tpci=53", "T_ACK 4", // i1 L117: PID_SECURITY_MODE on
  "secured 01ce001100103801<key> tpci=57", "T_ACK 5", // i1 L125: PID 56, the tool key
];
const END = (t: number) => [
  `secured 03d5000b1001 tpci=${(0x43 | (t << 2)).toString(16)}`, `T_ACK ${t}`,       // i1 L141: PID 11
  `secured 03810100 tpci=${(0x43 | ((t + 1) << 2)).toString(16)}`, `T_ACK ${t + 1}`, // i1 L149: the confirmed restart
  "T_Disconnect",                                                                   // i1 L157
];
const BUSFORGE_AFTER_RESTART = ["T_Connect", "plain 4300", "T_ACK 0", "T_Disconnect", "bc 0100"];

describe("assigning a Data Secure device its address by serial, as ETS does", () => {
  test("Data Secure on: secured serial-number write under the tool key, the security object's network configuration, a secured confirmed restart", async () => {
    const dev = new SecureDevice({ progMode: true });
    const bus = new Bus(dev);
    const seen: bigint[] = [];
    const before = dev.sending;
    const res = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: true, onPeerSequence: (s) => seen.push(s) }, fast);
    expect(res).toEqual({ previous: OLD, assigned: NEW, verified: true, progModeCleared: true, progModeError: null, route: "serial-secured" });
    const pid59 = bus.wire.findIndex((w) => w.startsWith("secured 01ce001100103b010001"));
    expect(bus.wire[pid59 + 1]).toBe("T_ACK 6");
    // i1 L133: PID 59, the device's sending sequence, from the tool's clock.
    expect(bus.wire.splice(pid59, 2)[0]).toMatch(/^secured 01ce001100103b010001[0-9a-f]{12} tpci=5b$/);
    expect(bus.wire).toEqual([...SERIAL_READ, ...BUSFORGE_FREE_CHECK, ...BROADCAST_PART, ...CONNECTION_OPEN, ...SECURED_DESCRIPTOR, ...DATA_SECURE_ON, ...END(7), ...BUSFORGE_AFTER_RESTART]);
    expect(dev.ia).toBe(NEW);
    expect(dev.key.equals(KEY)).toBe(true);
    expect(dev.sending).toBeGreaterThan(before);
    expect(dev.restarts).toBe(1);
    expect(seen.length).toBe(1);
    expect(withoutBusforgeChecks(bus.shapes)).toEqual(ETS_SHAPES_ON);
  });

  test("Data Secure off: the same route under the factory key, the security mode read twice and nothing written", async () => {
    const dev = new SecureDevice({ mode: false, progMode: true });
    const bus = new Bus(dev);
    const res = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: false }, fast);
    expect(res.progModeCleared).toBe(true);
    // a2 L51: the plain descriptor is the mask, so no secured one; L71 and L79: FunctionPropertyExtState_Read of
    // PID 51, twice, then L87 PID 11 and L95 the restart.
    expect(bus.wire).toEqual([...SERIAL_READ, ...BUSFORGE_FREE_CHECK, ...BROADCAST_PART, ...CONNECTION_OPEN,
      "secured 01d500110010330000 tpci=4f", "T_ACK 3", "secured 01d500110010330000 tpci=53", "T_ACK 4", ...END(5), ...BUSFORGE_AFTER_RESTART]);
    expect(dev.mode).toBe(false);
    expect(withoutBusforgeChecks(bus.shapes).slice(1)).toEqual(ETS_SHAPES_OFF);
  });

  test("a device whose key is another is left as it was: the broadcast Sync goes unanswered and nothing is written", async () => {
    const dev = new SecureDevice({ key: OTHER });
    const bus = new Bus(dev);
    const err = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_SYNC_NO_RESPONSE");
    expect(bus.writes).toEqual([]);
    expect(dev.ia).toBe(OLD);
    expect(bus.wire).toEqual([...SERIAL_READ, ...BUSFORGE_FREE_CHECK, "bc secured scf=92 (not under the device's key)"]);
  }, DEVICE_TIMEOUTS.syncResponseMs * 20);

  test("a serial no device answers is refused before anything is secured", async () => {
    const dev = new SecureDevice({});
    const bus = new Bus(dev);
    const err = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: Buffer.from("00fa09090909", "hex"), dataSecure: true }, fast).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SERIAL_NOT_FOUND");
    expect(bus.wire).toEqual(["bc 03dc00fa09090909"]);
  });

  test("a unit in secure mode under the factory key the project runs without Data Secure is not restarted", async () => {
    const dev = new SecureDevice({ mode: true });
    const bus = new Bus(dev);
    const err = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: false }, fast).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_IA_CONFIG_FAILED");
    expect((err as Error).message).toContain("SECURE_MODE_UNEXPECTED");
    expect(dev.ia).toBe(NEW);
    expect(dev.restarts).toBe(0);
  });

  test("a device that stays in programming mode after the restart is reported so", async () => {
    const dev = new SecureDevice({ progMode: true });
    dev.ignoreRestart = true;
    const res = await assignSecureAddressBySerial(new Bus(dev), NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast);
    expect(res).toMatchObject({ verified: true, progModeCleared: false, progModeError: "the device still answers in programming mode after the restart" });
  });

  test("the address already being the device's skips the free-address check", async () => {
    const dev = new SecureDevice({ ia: NEW });
    const bus = new Bus(dev);
    const res = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast);
    expect(res.previous).toBe(NEW);
    expect(bus.wire.slice(0, 2)).toEqual([...SERIAL_READ, BROADCAST_PART[0]]);
  });

  test("an answer to the broadcast Sync that does not authenticate is refused, not taken for silence", async () => {
    const dev = new SecureDevice({});
    dev.syncKey = OTHER;
    const bus = new Bus(dev);
    const err = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_SYNC_FAILED");
    expect(bus.writes).toEqual([]);
  });

  test("a Sync answered from another address than the serial read is refused before the write", async () => {
    const dev = new SecureDevice({});
    dev.syncFrom = "1.1.41";
    const bus = new Bus(dev);
    const err = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_SYNC_FAILED");
    expect(bus.writes).toEqual([]);
  });

  test("a refused switch-on leaves the address assigned and the device not restarted", async () => {
    const dev = new SecureDevice({ mode: false });
    dev.refuseModeOn = true;
    const bus = new Bus(dev);
    const err = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_IA_CONFIG_FAILED");
    expect((err as Error).message).toContain("ACTIVATION_REFUSED");
    expect(bus.wire.some((w) => w.startsWith("secured 01ce"))).toBe(false); // no key, no sequence
    expect(dev.ia).toBe(NEW);
    expect(dev.restarts).toBe(0);
  });

  test("a refused restart is carried out with the result: the address stands", async () => {
    const dev = new SecureDevice({ progMode: true });
    dev.refuseRestart = true;
    const res = await assignSecureAddressBySerial(new Bus(dev), NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast);
    expect(res).toMatchObject({ assigned: NEW, verified: true, progModeCleared: false, route: "serial-secured" });
    expect(res.progModeError).toContain("error code 1");
  });

  test("Data Secure not known (no certificate): a unit in secure mode gets the network configuration", async () => {
    const dev = new SecureDevice({ mode: true });
    const bus = new Bus(dev);
    await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL }, fast);
    expect(bus.wire).toContain(DATA_SECURE_ON[0]);
  });

  test("Data Secure not known (no certificate): a unit with its mode off is not switched on", async () => {
    const dev = new SecureDevice({ mode: false });
    const bus = new Bus(dev);
    const res = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL }, fast);
    expect(res.verified).toBe(true);
    expect(bus.wire.filter((w) => w.startsWith("secured 01d4") || w.startsWith("secured 01ce"))).toEqual([]);
    expect(dev.mode).toBe(false);
  });
});

describe("the broadcast Sync's answer window", () => {
  test("starts when the send ends: an interface slow to confirm the frame does not eat it", async () => {
    const dev = new SecureDevice({});
    const bus = new Bus(dev);
    const send = bus.sendCemi.bind(bus);
    bus.sendCemi = async (cemi: Buffer) => {
      const { tpdu } = parseCemiLData(cemi);
      const syncReq = tpdu.length > 2 && tpdu[1] === 0xf1 && tpdu[2] === 0x92 && (cemi[3 + cemi[1]] & 0x80) !== 0;
      if (!syncReq) return send(cemi);
      // The interface confirms the frame late; the device's answer comes 50 ms behind the confirmation.
      await new Promise((r) => setTimeout(r, DEVICE_TIMEOUTS.syncResponseMs + 300));
      const handler = bus.onCemi;
      bus.onCemi = (...a) => { setTimeout(() => handler?.(...a), 50); };
      await send(cemi);
      bus.onCemi = handler;
    };
    const res = await assignSecureAddressBySerial(bus, NEW, { key: KEY, serial: SERIAL, dataSecure: true }, fast);
    expect(res.verified).toBe(true);
  });
});

describe("the route a device's keys allow (assignAddress)", () => {
  const TOOL_KEY = Buffer.alloc(16, 0x77);

  test("a tool key the device does not answer, then the FDSK, which it holds: the secured route without Data Secure", async () => {
    const dev = new SecureDevice({ mode: false, key: KEY });
    const bus = new Bus(dev);
    const res = await assignAddress(bus, NEW, { serial: SERIAL, toolKey: TOOL_KEY, fdsk: KEY }, fast);
    expect(res).toMatchObject({ assigned: NEW, verified: true, route: "serial-secured" });
    expect(res.secureNotAnswered).toBeUndefined();
    expect(bus.wire.filter((w) => w.startsWith("bc sync") || w.startsWith("bc secured scf=92"))).toEqual(["bc secured scf=92 (not under the device's key)", `bc sync sn=${SN} tpci=3`]);
    expect(bus.wire).toContain("secured 01d500110010330000 tpci=4f"); // read, never switched on
    expect(dev.mode).toBe(false);
  });

  test("a tool key equal to the FDSK is Data Secure off: nothing is switched on", async () => {
    const dev = new SecureDevice({ mode: true, key: KEY });
    const err = await assignAddress(new Bus(dev), NEW, { serial: SERIAL, toolKey: KEY, fdsk: KEY }, fast).catch((e: unknown) => e);
    expect((err as Error).message).toContain("SECURE_MODE_UNEXPECTED");
  });

  test("no key answered: the plain programming-mode route for that device, and the result says why", async () => {
    const dev = new SecureDevice({ mode: false, key: OTHER, progMode: true });
    const bus = new Bus(dev);
    const res = await assignAddress(bus, NEW, { serial: SERIAL, toolKey: TOOL_KEY, fdsk: KEY }, fast);
    expect(res).toMatchObject({ previous: OLD, assigned: NEW, verified: true, progModeCleared: true, route: "programming-mode" });
    expect(res.secureNotAnswered).toContain("tool key, factory key (FDSK)");
    expect(bus.writes).toEqual([`plain ${NEW}`]);
  });

  test("an answer that does not authenticate stops there: no plain route", async () => {
    const dev = new SecureDevice({ progMode: true });
    dev.syncKey = OTHER;
    const bus = new Bus(dev);
    const err = await assignAddress(bus, NEW, { serial: SERIAL, toolKey: KEY }, fast).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_SYNC_FAILED");
    expect(bus.writes).toEqual([]);
  });
});
