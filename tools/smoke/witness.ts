// The bus witness: an independent KNXnet/IP client used only for group traffic
// (GroupValueRead / GroupValueWrite / listening), never management. It proves the device
// ACTS on the tables the flash wrote, which the byte-level read-back alone cannot. It connects
// only BETWEEN server bus operations (the bench bridge has one tunnel channel; the server
// releases it after each queued op), so the runner must not run a witness check while an API
// bus op is in flight.
import { KnxIpTunnel, cemiLDataGroup, groupValueRead, decodeGroupApdu, gaToNum, secureEncode, openSecureGroupTpdu, isSecureApdu, SCF, toolSequenceNow } from "../../packages/knx/src/index.ts";

// The host is injected, never defaulted: a hard-coded address would silently point a hardware
// test at whatever answers on it, and a run against the wrong bus is worse than no run at all.
// The runner refuses in preflight when BUSFORGE_BENCH_HOST is unset.
export class Witness {
  private tun: KnxIpTunnel | null = null;
  // The last secured sequence accepted from each device, kept across connections of this witness.
  private readonly lastSecureSeq = new Map<number, bigint>();
  // The bridge listens on 3681 by default (apps/bridge --port 3681); override with
  // BUSFORGE_BENCH_PORT. A standard KNXnet/IP gateway uses 3671.
  constructor(private readonly host: string, private readonly port = Number(process.env.BUSFORGE_BENCH_PORT ?? 3681)) {}

  async connect(): Promise<void> {
    const tun = KnxIpTunnel.tcp(this.host, this.port);
    await tun.connect();
    this.tun = tun;
  }
  async close(): Promise<void> {
    if (this.tun) { try { await this.tun.disconnect(); } catch { /* already gone */ } this.tun = null; }
  }
  private req(): KnxIpTunnel { if (!this.tun) throw new Error("witness not connected"); return this.tun; }

  // GroupValueRead the GA and wait for a GroupValueResponse. Returns the response value as hex,
  // or null if nothing answered within the window.
  async groupRead(ga: string, waitMs = 1500): Promise<string | null> {
    const tun = this.req();
    const n = gaToNum(ga);
    let value: string | null = null;
    const prev = tun.onCemi;
    tun.onCemi = (_src, dst, tpdu, isGroup) => { if (isGroup && dst === n) { const g = decodeGroupApdu(tpdu); if (g.apci === "GroupValueResponse") value = g.value.toString("hex"); } };
    try {
      await tun.sendCemi(cemiLDataGroup(tun.assignedIa, n, groupValueRead()));
      await new Promise((r) => setTimeout(r, waitMs));
    } finally { tun.onCemi = prev; }
    return value;
  }

  // GroupValueRead `readGa`, an address added behind an object's own addresses `ownGas` (first
  // association first), and wait for the object's answer on `ownGas[0]`: an object answers a read of
  // any of its addresses on its first association ([findings.md](../../docs/findings.md) §36). Only a
  // GroupValueResponse from `from` counts. Another client reading the test address or any of the
  // object's own addresses would put an answer there that is not this read's: the witness listens
  // `quietMs` before sending, and such a read it sees, or a response on the first address before its
  // read went out, makes the answer `unattributable`. A read it does not see (another tunnel of the
  // interface) it cannot rule out; the runner's control read after the removal rules out only one
  // that recurs within its window.
  async groupReadAnsweredOn(readGa: string, ownGas: string[], from: number, waitMs = 1500, quietMs = 500): Promise<{ value: string | null; unattributable: boolean }> {
    if (!ownGas.length) throw new Error("groupReadAnsweredOn: the object has no address of its own to answer on");
    const tun = this.req();
    const read = gaToNum(readGa);
    const own = new Set(ownGas.map(gaToNum));
    const answer = gaToNum(ownGas[0]);
    let value: string | null = null;
    let sent = false;
    let unattributable = false;
    const prev = tun.onCemi;
    tun.onCemi = (src, dst, tpdu, isGroup) => {
      if (!isGroup || (!own.has(dst) && dst !== read)) return;
      const g = decodeGroupApdu(tpdu);
      if (g.apci === "GroupValueRead" && !(dst === read && src === tun.assignedIa)) unattributable = true;
      else if (g.apci === "GroupValueResponse" && dst === answer) {
        if (!sent) unattributable = true;
        else if (src === from && value === null) value = g.value.toString("hex");
      }
    };
    try {
      await new Promise((r) => setTimeout(r, quietMs));
      sent = true;
      await tun.sendCemi(cemiLDataGroup(tun.assignedIa, read, groupValueRead()));
      await new Promise((r) => setTimeout(r, waitMs));
    } finally { tun.onCemi = prev; }
    return { value, unattributable };
  }

  // A GroupValueRead on a SECURED address, encrypted with its key from the witness's tunnel address,
  // and the device's secured GroupValueResponse opened with the same key. Returns the value as hex, or
  // null if no authentic, fresh response came. Only answers from `from` count: the key proves the
  // group, the source says who answered. Fresh means a sequence above every one this witness has seen
  // from that device, so an old answer delivered again does not pass. The device answers only if its
  // security table lists the tunnel's address.
  async securedGroupRead(ga: string, key: Buffer, from: number, waitMs = 2000): Promise<string | null> {
    const tun = this.req();
    const n = gaToNum(ga);
    let value: string | null = null;
    const prev = tun.onCemi;
    tun.onCemi = (src, dst, tpdu, isGroup) => {
      if (!isGroup || dst !== n || src !== from || !isSecureApdu(tpdu)) return;
      const o = openSecureGroupTpdu(src, dst, tpdu, key);
      if (o.state !== "decrypted") return;
      const last = this.lastSecureSeq.get(src);
      if (last !== undefined && o.seq <= last) return;
      this.lastSecureSeq.set(src, o.seq);
      const g = decodeGroupApdu(o.apdu);
      if (g.apci === "GroupValueResponse") value = g.value.toString("hex");
    };
    try {
      const seq = Buffer.alloc(6);
      seq.writeUIntBE(Number(toolSequenceNow()), 0, 6);
      const body = secureEncode({ key, src: tun.assignedIa, dst: n, dstIsGroup: true, seq, scf: SCF.AUTH_CONF, tpci: 0x03, aad: Buffer.from([SCF.AUTH_CONF]), plaintext: groupValueRead() });
      await tun.sendCemi(cemiLDataGroup(tun.assignedIa, n, Buffer.concat([Buffer.from([0x03, 0xf1]), body])));
      await new Promise((r) => setTimeout(r, waitMs));
    } finally { tun.onCemi = prev; }
    return value;
  }

  get tunnelIa(): number { return this.req().assignedIa; }

  // Listen for a device-INITIATED telegram on a GA (a GroupValueWrite or GroupValueResponse the
  // device sends unprompted), within a window. Returns the value as hex, or null if silent. This is
  // how a heartbeat / cyclically-transmitting object is verified: we send nothing, we only observe.
  async listen(ga: string, windowMs: number): Promise<string | null> {
    const tun = this.req();
    const n = gaToNum(ga);
    let value: string | null = null;
    const prev = tun.onCemi;
    tun.onCemi = (_src, dst, tpdu, isGroup) => {
      if (isGroup && dst === n && value === null) {
        const g = decodeGroupApdu(tpdu);
        if (g.apci === "GroupValueWrite" || g.apci === "GroupValueResponse") value = g.value.toString("hex");
      }
    };
    try { await new Promise((r) => setTimeout(r, windowMs)); } finally { tun.onCemi = prev; }
    return value;
  }

  // GroupValueWrite the GA with a value (hex string). A value that fits in 6 bits uses the compact
  // APDU (DPT 1/2/3), otherwise the extended form with the value as trailing octets.
  async groupWrite(ga: string, valueHex: string): Promise<void> {
    const tun = this.req();
    const n = gaToNum(ga);
    const v = Buffer.from(valueHex, "hex");
    const apdu = v.length === 1 && v[0] <= 0x3f ? Buffer.from([0x00, 0x80 | v[0]]) : Buffer.concat([Buffer.from([0x00, 0x80]), v]);
    await tun.sendCemi(cemiLDataGroup(tun.assignedIa, n, apdu));
  }
}
