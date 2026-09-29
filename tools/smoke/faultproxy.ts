// A KNXnet/IP-over-TCP pass-through between the server and the bench bridge, used by the Data Secure
// robustness checks: it can change the secured answers the bench device sends back, so the run can
// show that Busforge rejects them. "corrupt" flips one bit in every secured data answer (its MAC no
// longer matches), "duplicate" delivers the first secured data answer of a connection again in place
// of every later one (an old sequence number). Everything else passes through unchanged. It runs on
// the machine the smoke runner runs on; the server reaches it as a saved connection to 127.0.0.1.
import net from "node:net";

export type FaultMode = "pass" | "corrupt" | "duplicate";

const TUNNELLING_REQ = 0x0420;

// The TPDU of a tunnelled cEMI frame: 6-byte header, 4-byte connection header, then cEMI
// (message code, additional-info length, info, ctrl1, ctrl2, src, dst, length, TPDU).
function tpduOf(frame: Buffer): { tpdu: Buffer; src: number } | null {
  if (frame.length < 10 || ((frame[2] << 8) | frame[3]) !== TUNNELLING_REQ) return null;
  const cemi = frame.subarray(10);
  const o = 2 + (cemi[1] ?? 0);
  if (cemi.length < o + 8) return null;
  return { tpdu: cemi.subarray(o + 7), src: cemi.readUInt16BE(o + 2) };
}
// A secured S-A_Data answer (A_Data_Secure with SCF service 0), not a Sync response.
const isSecuredData = (tpdu: Buffer) => tpdu.length > 3 && (tpdu[0] & 0x03) === 0x03 && tpdu[1] === 0xf1 && (tpdu[2] & 0x07) === 0;

// The same tunnelled frame carrying another TPDU: the cEMI length octet and the total length follow.
function withTpdu(frame: Buffer, oldLen: number, tpdu: Buffer): Buffer {
  const head = Buffer.from(frame.subarray(0, frame.length - oldLen));
  head[head.length - 1] = tpdu.length - 1; // the cEMI length octet counts the TPDU without its first octet
  const out = Buffer.concat([head, tpdu]);
  out.writeUInt16BE(out.length, 4);
  return out;
}

// A stream that no longer starts with a KNXnet/IP header (06 10) has lost its framing; `onDesync` ends
// the connection so the check fails on a closed connection instead of waiting on dropped bytes.
function splitter(onFrame: (f: Buffer) => void, onDesync: () => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= 2 && (buf[0] !== 0x06 || buf[1] !== 0x10)) { onDesync(); return; }
    while (buf.length >= 6 && buf[0] === 0x06 && buf[1] === 0x10) {
      const total = (buf[4] << 8) | buf[5];
      if (total < 6 || buf.length < total) break;
      onFrame(Buffer.from(buf.subarray(0, total)));
      buf = buf.subarray(total);
    }
  };
}

export class FaultProxy {
  mode: FaultMode = "pass";
  altered = 0; // secured answers altered since the mode was last set
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly upstreamHost: string, private readonly upstreamPort: number, private readonly device: number) {}

  setMode(mode: FaultMode): void { this.mode = mode; this.altered = 0; }

  async start(): Promise<number> {
    this.server = net.createServer((client) => {
      const up = net.connect(this.upstreamPort, this.upstreamHost);
      this.sockets.add(client); this.sockets.add(up);
      let first: Buffer | null = null; // the first secured answer of this connection, for "duplicate"
      const close = () => { client.destroy(); up.destroy(); this.sockets.delete(client); this.sockets.delete(up); };
      client.on("data", splitter((f) => up.write(f), close));
      up.on("data", splitter((frame) => {
        let f = frame;
        const t = tpduOf(f);
        if (t && t.src === this.device && isSecuredData(t.tpdu) && this.mode !== "pass") {
          if (this.mode === "corrupt") { f[f.length - 1] ^= 0x01; this.altered++; }
          else if (first === null) first = Buffer.from(t.tpdu);
          else { f = withTpdu(f, t.tpdu.length, first); this.altered++; }
        }
        client.write(f);
      }, close));
      client.on("close", close); up.on("close", close); client.on("error", close); up.on("error", close);
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return (this.server.address() as net.AddressInfo).port;
  }

  // Closes the connections still open through it too: a tunnel left open by the server would
  // otherwise keep the listener's close waiting forever.
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }
}
