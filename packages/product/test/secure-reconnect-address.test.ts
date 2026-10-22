import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { KnxDevice, KnxError, SecureSession, APCI, parseApdu, tpAck, tpDisconnect, secureDecode, secureEncode, SCF, toolSequenceNow, type KnxTransport } from "@busforge/knx";
import { runFlashOp } from "../src/profiles.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 4.2 s with the
// file alone (load 5-27) and up to 4.2 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(90_000);

// A secured unit behind an interface that hands a reopened tunnel another individual address (its old
// channel not yet free). The scripted unit keeps its last valid tool-access sequence either once for
// every source (thelsing/knx, OpenKNX) or per source address (Calimero), takes a frame only if its MAC
// verifies under the frame's source address and its sequence is above that one, and answers to the
// address the frame came from. On the transport layer it holds one connection: a T_Connect from
// another address while it holds one is closed at once with a T_Disconnect, as is any numbered frame
// from an address it holds no connection with.
const DEV = 0x125b; // 1.2.91
const AT = 0x4000;
const KEY = Buffer.alloc(16, 0x3c);
const SERIAL = Buffer.from("008300000090", "hex");
const FAST: ConstructorParameters<typeof KnxDevice>[3] = { ackMs: 15, responseMs: 40, retryGapMs: 1, syncResponseMs: 60, restartAnswerMs: 20, restartProofMs: 150, droppedRepeatMs: 12_000, staleConnectionMs: 150 };

const seq6 = (n: bigint) => { const b = Buffer.alloc(6); for (let i = 5; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
const seqNum = (b: Buffer) => b.subarray(0, 6).reduce((n, x) => (n << 8n) | BigInt(x), 0n);

class SecureUnit implements KnxTransport {
  assignedIa = 0;
  onCemi: KnxTransport["onCemi"] = null;
  onClosed: KnxTransport["onClosed"] = null;
  down = false;
  private connects = 0;
  private readonly lastTool = new Map<number, bigint>(); // the last valid tool-access sequence, by source (0: one for all)
  private sending = 0x1000n;                              // the unit's own sending counter
  // The transport connection the unit holds, and until when (a connection whose link failed ends by itself).
  holds: { ia: number; until: number } | null = null;
  readonly syncsFrom: number[] = [];
  readonly toolSeqs: bigint[] = [];
  readonly refused: string[] = [];
  closedAt = 0;
  // closeLate: the unit takes a T_Connect from another address silently and closes the connection only at
  // its first numbered frame, a moment later.
  constructor(private readonly addresses: number[], private readonly byte: number, private readonly opts: { perSource?: boolean; toolAhead?: bigint; closeLate?: boolean } = {}) {
    if (opts.toolAhead !== undefined) this.lastTool.set(opts.perSource ? addresses[0] : 0, toolSequenceNow() + opts.toolAhead);
  }
  async connect() { this.assignedIa = this.addresses[Math.min(this.connects, this.addresses.length - 1)]; this.connects++; this.down = false; }
  async disconnect() {}
  private key(from: number) { return this.opts.perSource ? from : 0; }
  private reply(to: number, frame: Buffer) { this.onCemi?.(DEV, to, frame, false); }
  private answer(to: number, tSeq: number, service: Buffer) {
    const tpci = 0x40 | (tSeq << 2) | 0x03;
    const body = secureEncode({ key: KEY, src: DEV, dst: to, dstIsGroup: false, seq: seq6(this.sending++), scf: SCF.TOOL | SCF.AUTH_CONF, tpci, aad: Buffer.from([SCF.TOOL | SCF.AUTH_CONF]), plaintext: service });
    this.reply(to, Buffer.concat([Buffer.from([tpci, 0xf1]), body]));
  }
  private heldByOther(from: number) {
    if (this.holds && this.holds.until <= Date.now()) this.holds = null;
    return this.holds !== null && this.holds.ia !== from;
  }
  async sendCemi(cemi: Buffer) {
    if (this.down) throw new KnxError("TUNNEL_CLOSED", "scripted: the link is down");
    const from = (cemi[4] << 8) | cemi[5];
    const tpdu = Buffer.from(cemi.subarray(9));
    if (tpdu[0] === 0x80) {
      if (this.heldByOther(from)) { if (!this.opts.closeLate) { this.closedAt++; this.reply(from, tpDisconnect()); } return; }
      this.holds = { ia: from, until: Infinity };
      return;
    }
    if (tpdu[0] === 0x81) { if (this.holds?.ia === from) this.holds = null; return; }
    if ((tpdu[0] & 0xc0) === 0xc0) return; // T_ACK
    if (this.heldByOther(from) || this.holds === null) {
      this.closedAt++;
      if (this.opts.closeLate) setTimeout(() => this.reply(from, tpDisconnect()), 5); else this.reply(from, tpDisconnect());
      return;
    }
    const tSeq = (tpdu[0] >> 2) & 0x0f;
    if (tpdu[1] !== 0xf1) { this.refused.push("plain"); this.reply(from, tpAck(tSeq)); return; }
    const scf = tpdu[2];
    const last = this.lastTool.get(this.key(from)) ?? 0n;
    if ((scf & 0x07) === SCF.S_A_SYNC_REQ) {
      const serial = tpdu.subarray(9, 15);
      const body = Buffer.concat([tpdu.subarray(2, 9), tpdu.subarray(15)]);
      const req = secureDecode(body, { key: KEY, src: from, dst: DEV, dstIsGroup: false, tpci: tpdu[0], aadFor: (s) => Buffer.concat([Buffer.from([s]), serial]) });
      if (!req || !serial.equals(SERIAL)) { this.refused.push("sync MAC"); return; }
      this.reply(from, tpAck(tSeq));
      this.syncsFrom.push(from);
      const reqSeq = seqNum(req.seq);
      this.toolSeqs.push(reqSeq);
      // thelsing/knx receivedSyncRequest: the next sequence is the higher of the tool's and the unit's.
      const toolNext = reqSeq > last ? reqSeq + 1n : last + 1n;
      if (reqSeq > last) this.lastTool.set(this.key(from), reqSeq);
      const random = Buffer.from("a1b2c3d4e5f6", "hex");
      const rspScf = SCF.TOOL | SCF.AUTH_CONF | SCF.S_A_SYNC_RSP;
      const tpci = 0x40 | 0x03;
      const enc = secureEncode({ key: KEY, src: DEV, dst: from, dstIsGroup: false, seq: random, scf: rspScf, tpci, aad: Buffer.from([rspScf]), plaintext: Buffer.concat([seq6(this.sending), seq6(toolNext)]) });
      const xored = Buffer.from(random.map((r, i) => r ^ req.plaintext[i]));
      this.reply(from, Buffer.concat([Buffer.from([tpci, 0xf1]), enc.subarray(0, 1), xored, enc.subarray(7)]));
      return;
    }
    const got = secureDecode(tpdu.subarray(2), { key: KEY, src: from, dst: DEV, dstIsGroup: false, tpci: tpdu[0], aadFor: (s) => Buffer.from([s]) });
    if (!got) { this.refused.push("MAC"); return; }
    const s = seqNum(got.seq);
    this.toolSeqs.push(s);
    if (s <= last) { this.refused.push("sequence"); return; }
    this.lastTool.set(this.key(from), s);
    this.reply(from, tpAck(tSeq));
    const p = parseApdu(Buffer.concat([Buffer.from([0x40 | (tSeq << 2) | (got.plaintext[0] & 0x03)]), got.plaintext.subarray(1)]));
    if ((p.apci & ~0x01) === APCI.RESTART) { this.down = true; this.holds = null; return; }
    if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) this.answer(from, tSeq, Buffer.from([0x03, 0x40, 0x07, 0xb0]));
    if ((p.apci & 0x3c0) === APCI.MEMORY_READ) this.answer(from, tSeq, Buffer.from([0x02, 0x41, (AT >> 8) & 0xff, AT & 0xff, this.byte]));
  }
}

const session = (unit: SecureUnit) => new SecureSession({ toolKey: KEY, src: unit.assignedIa, dst: DEV, serial: SERIAL });
const increasing = (seqs: bigint[]) => seqs.every((s, i) => i === 0 || s > seqs[i - 1]);

async function flash(unit: SecureUnit) {
  await unit.connect();
  const dev = new KnxDevice(unit, "1.2.91", session(unit), FAST);
  await dev.connect();
  return runFlashOp(dev, "07B0", { dryRun: false, persistBackups: () => "backup" }, {
    imageBytes: 1, diffBytes: 1, backup: "backup", backups: [], extendedMemory: false,
    write: async () => { await dev.restart(); },
    verify: async () => (await dev.memRead(AT, 1, 1))[0] === 0x5a,
  });
}

describe("a secured flash whose interface hands the reopened tunnel another address", () => {
  const units: [string, ConstructorParameters<typeof SecureUnit>[2]][] = [
    ["one tool-access sequence for every source", {}],
    ["a tool-access sequence per source", { perSource: true }],
    ["one tool-access sequence for every source, ahead of the tool's clock", { toolAhead: 1_000_000_000n }],
    ["a tool-access sequence per source, the first source's ahead of the tool's clock", { perSource: true, toolAhead: 1_000_000_000n }],
  ];
  for (const [label, opts] of units) {
    test(`a unit keeping ${label}: syncs again under the new address and verifies, never reusing a sequence`, async () => {
      const unit = new SecureUnit([0x11fe, 0x11ff], 0x5a, opts);
      const res = await flash(unit);
      expect(res).toMatchObject({ kind: "flashed", verified: true });
      expect(unit.syncsFrom).toEqual([0x11fe, 0x11ff]);
      expect(unit.refused).toEqual([]);
      expect(increasing(unit.toolSeqs)).toBe(true);
    }, 90_000);
  }

  test("a read-back under the new address that differs is reported unverified, never a pass", async () => {
    const unit = new SecureUnit([0x11fe, 0x11ff], 0x00);
    const res = await flash(unit);
    expect(res).toMatchObject({ kind: "flashed", verified: false });
    expect(unit.syncsFrom).toEqual([0x11fe, 0x11ff]);
  }, 90_000);
});

describe("a secured session whose link came back under another address while the unit holds the old connection", () => {
  async function reopened(holdMs: number, closeLate = false) {
    const unit = new SecureUnit([0x11fe, 0x11ff], 0x5a, { closeLate });
    await unit.connect();
    const dev = new KnxDevice(unit, "1.2.91", session(unit), FAST);
    await dev.connect();
    unit.holds = { ia: 0x11fe, until: Date.now() + holdMs }; // the link failed with the connection open
    await dev.reopenTransport();
    return { unit, dev };
  }

  for (const closeLate of [false, true]) {
    const when = closeLate ? "at the Sync" : "at once";
    test(`the unit closes the new connection ${when}; it is opened again once the old one ended, and synced there`, async () => {
      const { unit, dev } = await reopened(100, closeLate);
      await dev.connect();
      expect(await dev.memRead(AT, 1, 1)).toEqual(Buffer.from([0x5a]));
      expect(unit.closedAt).toBeGreaterThan(0);
      expect(unit.syncsFrom).toEqual([0x11fe, 0x11ff]);
      expect(unit.refused).toEqual([]);
      expect(increasing(unit.toolSeqs)).toBe(true);
    });

    test(`a unit that keeps refusing ${when} is named so, not taken for a wrong tool key`, async () => {
      const { dev } = await reopened(60_000, closeLate);
      const err = await dev.connect().then(() => null, (e: Error & { code?: string }) => e);
      expect(err?.code).toBe("DEVICE_CLOSED_CONNECTION");
      expect(err?.message).toMatch(/refused the secured connection twice/);
    });
  }
});
