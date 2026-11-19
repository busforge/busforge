#!/usr/bin/env bun
// A libpcap capture of KNXnet/IP over UDP, turned into the log tools/knxproxy.ts writes, so the capture
// comparisons (tools/etsdiff.ts, its tests) read it like a proxy capture:
//
//   bun run tools/pcap.ts <capture.pcap> [<out.log>] [--tool=ETS]
//
// One UDP datagram is one KNXnet/IP frame. The server side is every endpoint that sends one of the server's
// answers (SEARCH_RES, SEARCH_RES_EXT, DESCRIPTION_RES, CONNECT_RES, CONNSTATE_RES), and the data endpoint a
// CONNECT_RES names; a datagram that neither comes from nor goes to the server side is refused, since its
// direction in the log would be a guess (ETS's multicast search, other traffic: filter the capture first). So is every record the log could not show as it
// was: a truncated record, an IP fragment, a non-UDP packet, a datagram that is not exactly one KNXnet/IP
// frame. Read: the classic pcap format (either byte order, micro- or nanosecond stamps) with raw IPv4
// packets (link type 101 or 228) or Ethernet. The pcapng block format is refused.
import { readFileSync, writeFileSync } from "node:fs";
import { logLine } from "./knxproxy.ts";

export interface UdpDatagram { at: Date; src: string; dst: string; payload: Buffer }

const LINKTYPE_ETHERNET = 1, LINKTYPE_RAW = 101, LINKTYPE_IPV4 = 228;
const CONNECT_RES = 0x0206;
const SERVER_ANSWERS = new Set([0x0202, 0x0204, CONNECT_RES, 0x0208, 0x020c]);

// The UDP datagrams of a classic pcap file, in file order.
export function readPcap(bytes: Buffer): UdpDatagram[] {
  if (bytes.length < 24) throw new Error(`not a pcap file: ${bytes.length} bytes, shorter than its header`);
  const magic = bytes.readUInt32LE(0);
  const formats: Record<number, { le: boolean; nano: boolean }> = {
    0xa1b2c3d4: { le: true, nano: false }, 0xd4c3b2a1: { le: false, nano: false },
    0xa1b23c4d: { le: true, nano: true }, 0x4d3cb2a1: { le: false, nano: true },
  };
  if (magic === 0x0a0d0d0a) throw new Error("a pcapng file; only the classic pcap format is read (convert it with `editcap -F pcap`)");
  const fmt = formats[magic];
  if (!fmt) throw new Error(`not a pcap file: magic ${magic.toString(16).padStart(8, "0")}`);
  const u32 = (o: number) => (fmt.le ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  const linkType = u32(20) & 0xffff;
  if (linkType !== LINKTYPE_RAW && linkType !== LINKTYPE_IPV4 && linkType !== LINKTYPE_ETHERNET) {
    throw new Error(`link type ${linkType} is not read; raw IPv4 (101, 228) and Ethernet (1) are`);
  }
  const out: UdpDatagram[] = [];
  for (let o = 24, n = 1; o < bytes.length; n++) {
    if (o + 16 > bytes.length) throw new Error(`record ${n}: the file ends inside its header`);
    const sec = u32(o), frac = u32(o + 4), incl = u32(o + 8), orig = u32(o + 12);
    if (incl < orig) throw new Error(`record ${n} is truncated (${incl} of ${orig} bytes captured)`);
    // More bytes captured than the packet had: the record would swallow what follows it.
    if (incl > orig) throw new Error(`record ${n} claims ${incl} bytes captured of a ${orig}-byte packet`);
    if (o + 16 + incl > bytes.length) throw new Error(`record ${n}: the file ends inside its ${incl} bytes`);
    const pkt = bytes.subarray(o + 16, o + 16 + incl);
    o += 16 + incl;
    const at = new Date(sec * 1000 + Math.floor(fmt.nano ? frac / 1e6 : frac / 1e3));
    out.push({ at, ...udpOf(linkType === LINKTYPE_ETHERNET ? ethernetPayload(pkt, n) : pkt, n) });
  }
  return out;
}

function ethernetPayload(frame: Buffer, n: number): Buffer {
  if (frame.length < 14) throw new Error(`record ${n}: an Ethernet frame of ${frame.length} bytes`);
  const type = frame.readUInt16BE(12);
  if (type !== 0x0800) throw new Error(`record ${n}: EtherType 0x${type.toString(16)}, not IPv4`);
  return frame.subarray(14);
}

function udpOf(ip: Buffer, n: number): { src: string; dst: string; payload: Buffer } {
  if (ip.length < 20 || ip[0] >> 4 !== 4) throw new Error(`record ${n} is not an IPv4 packet`);
  const ihl = (ip[0] & 0x0f) * 4, total = ip.readUInt16BE(2);
  if (ihl < 20 || total < ihl || total > ip.length) throw new Error(`record ${n}: IPv4 header length ${ihl}, total ${total}, ${ip.length} bytes captured`);
  if ((ip.readUInt16BE(6) & 0x3fff) !== 0) throw new Error(`record ${n} is an IPv4 fragment; fragments are not reassembled`);
  if (ip[9] !== 17) throw new Error(`record ${n} is IP protocol ${ip[9]}, not UDP`);
  const udp = ip.subarray(ihl, total);
  if (udp.length < 8 || udp.readUInt16BE(4) !== udp.length) throw new Error(`record ${n}: UDP length ${udp.length < 8 ? "short" : udp.readUInt16BE(4)} disagrees with the ${udp.length} bytes the IP packet carries`);
  const addr = (o: number) => `${ip[o]}.${ip[o + 1]}.${ip[o + 2]}.${ip[o + 3]}`;
  return { src: `${addr(12)}:${udp.readUInt16BE(0)}`, dst: `${addr(16)}:${udp.readUInt16BE(2)}`, payload: Buffer.from(udp.subarray(8)) };
}

// The capture as knxproxy log lines, with the tool on one side and the server ("BRIDGE") on the other.
export function pcapToLog(bytes: Buffer, tool = "ETS"): string {
  const datagrams = readPcap(bytes);
  datagrams.forEach((d, i) => {
    const p = d.payload;
    if (p.length < 6 || p[0] !== 0x06 || p[1] !== 0x10 || p.readUInt16BE(4) !== p.length) {
      throw new Error(`datagram ${i + 1} (${d.src} -> ${d.dst}) is not one KNXnet/IP frame: ${p.subarray(0, 8).toString("hex")}`);
    }
  });
  const server = new Set<string>();
  for (const d of datagrams) {
    const svc = d.payload.readUInt16BE(2);
    if (!SERVER_ANSWERS.has(svc)) continue;
    server.add(d.src);
    // CONNECT_RES: header, channel, status, then the data endpoint's HPAI (length 8, protocol, IPv4, port).
    const p = d.payload;
    if (svc === CONNECT_RES && p.length >= 16 && p[8] === 0x08) {
      const ip = `${p[10]}.${p[11]}.${p[12]}.${p[13]}`, port = p.readUInt16BE(14);
      // 0.0.0.0:0 is the NAT form: the data travels on the endpoint the answer came from.
      if (ip !== "0.0.0.0" || port !== 0) server.add(`${ip}:${port}`);
    }
  }
  if (server.size === 0) throw new Error("no datagram carries a server's answer (SEARCH_RES, SEARCH_RES_EXT, DESCRIPTION_RES, CONNECT_RES, CONNSTATE_RES), so no side is known to be the server");
  const lines = [`${datagrams[0].at.toISOString()} --- converted from a pcap capture: ${datagrams.length} datagrams, the server at ${[...server].join(", ")} ---`];
  datagrams.forEach((d, i) => {
    const fromServer = server.has(d.src), toServer = server.has(d.dst);
    if (fromServer === toServer) throw new Error(`datagram ${i + 1} (${d.src} -> ${d.dst}) goes ${fromServer ? "between two server endpoints" : "past the server"}; its direction is not known`);
    lines.push(logLine(fromServer ? `BRIDGE->${tool}` : `${tool}->BRIDGE`, d.payload, d.at));
  });
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const tool = args.find((a) => a.startsWith("--tool="))?.slice(7) ?? "ETS";
  const unknown = args.filter((a) => a.startsWith("--") && !a.startsWith("--tool="));
  const [input, output, ...extra] = args.filter((a) => !a.startsWith("--"));
  if (!input || extra.length || unknown.length) {
    console.error("usage: bun run tools/pcap.ts <capture.pcap> [<out.log>] [--tool=ETS]");
    process.exit(2);
  }
  try {
    const log = pcapToLog(readFileSync(input), tool);
    if (output) writeFileSync(output, log); else process.stdout.write(log);
  } catch (e) {
    console.error(`pcap: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
