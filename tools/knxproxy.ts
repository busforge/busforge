#!/usr/bin/env bun
// KNXnet/IP-over-TCP logging proxy: the capture tool behind every ETS reference capture
// (tools/etsdiff.ts, docs/verification.md). It sits between a tool (ETS, or Busforge itself) and a
// KNXnet/IP server, passes every frame on unchanged and logs each in both directions, one line per
// frame, in the format tools/etsdiff.ts reads:
//
//   <ISO time> <DIR> <SERVICE> <summary> | <full frame hex>      DIR = "ETS->BRIDGE" or "BRIDGE->ETS"
//
// (with PROXY_TOOL=Busforge the tool side is named "Busforge" instead of "ETS").
//
//   PROXY_PORT=3672 BRIDGE_HOST=<server ip> BRIDGE_PORT=3671 PROXY_LOG=./capture.log \
//     [PROXY_TOOL=ETS] [PROXY_ADVERTISE=<this host's ip>:<PROXY_PORT>] bun run tools/knxproxy.ts
//
// ETS is pointed at this host's PROXY_PORT as a KNXnet/IP TCP interface. A KNXnet/IP server answers
// ETS's search with its own control endpoint (SEARCH_RESPONSE, SEARCH_RESPONSE_EXTENDED), and ETS 6
// then connects there, around the proxy: the capture holds the search and nothing after it. With
// PROXY_ADVERTISE the proxy puts its own endpoint into that answer, and ETS connects through it.
//
// Only whole KNXnet/IP frames travel, so the endpoint can be rewritten in the frame it belongs to. A
// stream that stops being KNXnet/IP (a header that is not 06 10, a length below the header's) is cut
// and the cut logged, rather than passed on as bytes no line of the log would show.
import net from "node:net";
import { appendFileSync } from "node:fs";

const SVC: Record<number, string> = {
  0x0201: "SEARCH_REQ", 0x0202: "SEARCH_RES", 0x0203: "DESCRIPTION_REQ", 0x0204: "DESCRIPTION_RES",
  0x0205: "CONNECT_REQ", 0x0206: "CONNECT_RES", 0x0207: "CONNSTATE_REQ", 0x0208: "CONNSTATE_RES",
  0x0209: "DISCONNECT_REQ", 0x020a: "DISCONNECT_RES", 0x020b: "SEARCH_REQ_EXT", 0x020c: "SEARCH_RES_EXT",
  0x0310: "DEVICE_CONFIG_REQ", 0x0311: "DEVICE_CONFIG_ACK", 0x0420: "TUNNELLING_REQ", 0x0421: "TUNNELLING_ACK",
};
const APCI: Record<number, string> = {
  0x200: "MEMORY_READ", 0x240: "MEMORY_RESP", 0x280: "MEMORY_WRITE",
  0x300: "DESCR_READ", 0x340: "DESCR_RESP", 0x380: "RESTART",
  0x3d5: "PROP_READ", 0x3d6: "PROP_RESP", 0x3d7: "PROP_WRITE",
  0x1c0: "ADC_READ", 0x1fb: "MEM_EXT_WRITE", 0x1fc: "MEM_EXT_READ",
};
const SEARCH_RES = 0x0202, SEARCH_RES_EXT = 0x020c;
const HPAI_UDP = 0x01, HPAI_TCP = 0x02;

const ia = (n: number) => `${(n >> 12) & 0xf}.${(n >> 8) & 0xf}.${n & 0xff}`;

// A readable summary of a tunnelled cEMI L_Data frame.
function decodeCemi(cemi: Buffer): string {
  if (cemi.length < 2) return "";
  const msg = cemi[0];
  const mc = msg === 0x11 ? "req" : msg === 0x2e ? "con" : msg === 0x29 ? "ind" : `0x${msg.toString(16)}`;
  const o = 2 + cemi[1];
  if (cemi.length < o + 8) return mc;
  const ctrl1 = cemi[o], src = cemi.readUInt16BE(o + 2), dst = cemi.readUInt16BE(o + 4);
  const tpdu = cemi.subarray(o + 7, o + 8 + cemi[o + 6]);
  const conerr = msg === 0x2e ? (ctrl1 & 0x01 ? " CON-NEG" : " CON-OK") : "";
  if (tpdu.length < 2) return `${mc} ${ia(src)}->${ia(dst)}${conerr}`;
  const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
  const label = APCI[apci] ?? APCI[apci & 0x3c0] ?? `apci_0x${apci.toString(16)}`;
  return `${mc} ${ia(src)}->${ia(dst)}${conerr} ${label}`;
}

export function logLine(dir: string, frame: Buffer, at = new Date()): string {
  const svc = frame.readUInt16BE(2);
  const summary = svc === 0x0420 && frame.length > 10 ? decodeCemi(frame.subarray(6 + frame[6])) : "";
  return `${at.toISOString()} ${dir} ${SVC[svc] ?? `svc_0x${svc.toString(16)}`} ${summary} | ${frame.toString("hex")}`;
}

// Split a byte stream into KNXnet/IP frames (06 10, service, total length). `onBroken` gets the bytes
// from the first one that cannot start a frame; nothing after it is framed.
export function makeSplitter(onFrame: (f: Buffer) => void, onBroken: (rest: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0), broken = false;
  return (chunk) => {
    if (broken) return;
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 6) {
      const total = buf.readUInt16BE(4);
      if (buf[0] !== 0x06 || buf[1] !== 0x10 || total < 6) { broken = true; onBroken(buf); return; }
      if (buf.length < total) return;
      onFrame(buf.subarray(0, total));
      buf = buf.subarray(total);
    }
    if (buf.length >= 2 && (buf[0] !== 0x06 || buf[1] !== 0x10)) { broken = true; onBroken(buf); }
  };
}

// "<a.b.c.d>:<port>", checked: a wrong endpoint in the search answer would send ETS somewhere else.
export function parseEndpoint(s: string): { ip: number[]; port: number } {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/);
  const ip = m ? m.slice(1, 5).map(Number) : [];
  const port = m ? Number(m[5]) : 0;
  if (!m || ip.some((o) => o > 255) || port < 1 || port > 65535) throw new Error(`PROXY_ADVERTISE must be <ipv4>:<port>, not ${s}`);
  return { ip, port };
}

// The control endpoint of a search answer replaced by `to`. Any other frame, and a search answer
// whose endpoint is not an 8-byte IPv4 HPAI, comes back as it is.
export function rewriteSearchEndpoint(frame: Buffer, to: { ip: number[]; port: number }): Buffer {
  const svc = frame.readUInt16BE(2);
  if ((svc !== SEARCH_RES && svc !== SEARCH_RES_EXT) || frame.length < 14 || frame[6] !== 0x08 || (frame[7] !== HPAI_UDP && frame[7] !== HPAI_TCP)) return frame;
  const out = Buffer.from(frame);
  to.ip.forEach((o, i) => { out[8 + i] = o; });
  out.writeUInt16BE(to.port, 12);
  return out;
}

export interface ProxyOptions { port: number; bridgeHost: string; bridgePort: number; log: string; tool: string; advertise?: { ip: number[]; port: number } }

export function startProxy(o: ProxyOptions): net.Server {
  const note = (s: string) => appendFileSync(o.log, `${new Date().toISOString()} --- ${s} ---\n`);
  return net.createServer((tool) => {
    const server = net.connect(o.bridgePort, o.bridgeHost, () => note(`${o.tool} connected, bridge up`));
    const close = () => { tool.destroy(); server.destroy(); };
    const cut = (from: string) => (rest: Buffer) => { note(`${from} sent bytes that are not KNXnet/IP (${rest.subarray(0, 16).toString("hex")}...), connection cut`); close(); };
    const fromTool = makeSplitter((f) => { appendFileSync(o.log, logLine(`${o.tool}->BRIDGE`, f) + "\n"); server.write(f); }, cut(o.tool));
    const fromServer = makeSplitter((f) => {
      appendFileSync(o.log, logLine(`BRIDGE->${o.tool}`, f) + "\n");
      const out = o.advertise ? rewriteSearchEndpoint(f, o.advertise) : f;
      if (out !== f) note(`rewrote control HPAI ${f.subarray(6, 14).toString("hex")} -> ${out.subarray(6, 14).toString("hex")}`);
      tool.write(out);
    }, cut("the server"));
    tool.on("data", fromTool);
    server.on("data", fromServer);
    tool.on("close", close); server.on("close", close);
    tool.on("error", close); server.on("error", close);
  });
}

if (import.meta.main) {
  const env = process.env;
  const o: ProxyOptions = {
    port: Number(env.PROXY_PORT ?? 3672), bridgeHost: env.BRIDGE_HOST ?? "127.0.0.1", bridgePort: Number(env.BRIDGE_PORT ?? 3671),
    log: env.PROXY_LOG ?? "./capture.log", tool: env.PROXY_TOOL ?? "ETS", advertise: env.PROXY_ADVERTISE ? parseEndpoint(env.PROXY_ADVERTISE) : undefined,
  };
  startProxy(o).listen(o.port, "0.0.0.0", () => console.log(`knxproxy: listen :${o.port} -> ${o.bridgeHost}:${o.bridgePort}, log ${o.log}${o.advertise ? `, advertising ${env.PROXY_ADVERTISE}` : ""}`));
}
