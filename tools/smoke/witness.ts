// The bus witness: an independent KNXnet/IP client used only for group traffic
// (GroupValueRead / GroupValueWrite / listening), never management. It proves the device
// ACTS on the tables the flash wrote, which the byte-level read-back alone cannot. It connects
// only BETWEEN server bus operations (the bench bridge has one tunnel channel; the server
// releases it after each queued op), so the runner must not run a witness check while an API
// bus op is in flight. Same pattern as the manual _smoke/_usuga scripts.
import { KnxIpTunnel, cemiLDataGroup, groupValueRead, decodeGroupApdu, gaToNum } from "../../packages/knx/src/index.ts";

export class Witness {
  private tun: KnxIpTunnel | null = null;
  constructor(private readonly host = process.env.BUSFORGE_BENCH_HOST ?? "198.51.100.231", private readonly port = 3671) {}

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
