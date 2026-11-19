import { test, expect, describe } from "bun:test";
import { pcapToLog, readPcap } from "./pcap.ts";
import { parseCapture } from "./etsdiff.ts";

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const ip = (s: string) => s.split(".").map(Number);

// One IPv4/UDP packet carrying `payload`, from src to dst ("a.b.c.d:port").
function udp(src: string, dst: string, payload: number[], opts: { proto?: number; flags?: number } = {}): number[] {
  const [sa, sp] = src.split(":"), [da, dp] = dst.split(":");
  const udpLen = 8 + payload.length;
  return [0x45, 0, ...u16(20 + udpLen), 0, 0, ...u16(opts.flags ?? 0), 64, opts.proto ?? 17, 0, 0, ...ip(sa), ...ip(da),
    ...u16(Number(sp)), ...u16(Number(dp)), ...u16(udpLen), 0, 0, ...payload];
}
// A classic pcap file, little-endian, microsecond stamps, link type 101 (raw IP), one record per packet.
function pcap(packets: number[][], opts: { bigEndian?: boolean; truncate?: boolean } = {}): Buffer {
  const w32 = (n: number) => { const b = Buffer.alloc(4); if (opts.bigEndian) b.writeUInt32BE(n); else b.writeUInt32LE(n); return [...b]; };
  const w16 = (n: number) => { const b = Buffer.alloc(2); if (opts.bigEndian) b.writeUInt16BE(n); else b.writeUInt16LE(n); return [...b]; };
  const out = [...w32(0xa1b2c3d4), ...w16(2), ...w16(4), ...w32(0), ...w32(0), ...w32(65535), ...w32(101)];
  packets.forEach((p, i) => out.push(...w32(1_700_000_000 + i), ...w32(250_000), ...w32(opts.truncate ? p.length - 1 : p.length), ...w32(p.length), ...(opts.truncate ? p.slice(0, -1) : p)));
  return Buffer.from(out);
}
const knxip = (service: number, body: number[]) => [0x06, 0x10, ...u16(service), ...u16(6 + body.length), ...body];
const CONNECT_RES = knxip(0x0206, [0x01, 0x00, 0x08, 0x01, 127, 0, 0, 1, 0x0e, 0x58, 0x04, 0x04, 0x11, 0xfe]);
// TUNNELLING_REQUEST, channel 1, with an L_Data.req from 0.0.0 to 1.1.1 carrying A_Memory_Write 0x4000 = 01 02.
const MEM_WRITE = knxip(0x0420, [0x04, 0x01, 0x00, 0x00, 0x11, 0x00, 0xb0, 0x60, 0x00, 0x00, 0x11, 0x01, 0x05, 0x42, 0x82, 0x40, 0x00, 0x01, 0x02]);
const SIM = "127.0.0.1:3672", ETS = "127.0.0.1:61485";

describe("pcap to knxproxy log", () => {
  test("each datagram becomes one log line, its direction told by the side that answers as the server", () => {
    const log = pcapToLog(pcap([udp(SIM, ETS, CONNECT_RES), udp(ETS, SIM, MEM_WRITE)]));
    const lines = log.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`the server at ${SIM}`);
    expect(lines[1]).toMatch(/^2023-11-14T22:13:20\.250Z BRIDGE->ETS CONNECT_RES {2}\| 06100206/);
    expect(lines[2]).toMatch(/ ETS->BRIDGE TUNNELLING_REQ req 0\.0\.0->1\.1\.1 MEMORY_WRITE \| 0610042000/);
    const cap = parseCapture(log, 0x1101);
    expect(cap.writes.map((w) => [w.addr, [...w.data]])).toEqual([[0x4000, [1, 2]]]);
  });

  test("a big-endian file reads the same", () => {
    expect(pcapToLog(pcap([udp(SIM, ETS, CONNECT_RES), udp(ETS, SIM, MEM_WRITE)], { bigEndian: true })))
      .toBe(pcapToLog(pcap([udp(SIM, ETS, CONNECT_RES), udp(ETS, SIM, MEM_WRITE)])));
  });

  test("refuses what the log could not show as it was", () => {
    expect(() => readPcap(Buffer.from([0x0a, 0x0d, 0x0d, 0x0a, ...new Array(20).fill(0)]))).toThrow(/pcapng/);
    expect(() => readPcap(Buffer.alloc(24))).toThrow(/not a pcap file/);
    expect(() => readPcap(pcap([udp(SIM, ETS, CONNECT_RES)], { truncate: true }))).toThrow(/truncated/);
    expect(() => readPcap(pcap([udp(SIM, ETS, CONNECT_RES, { flags: 0x2000 })]))).toThrow(/fragment/);
    expect(() => readPcap(pcap([udp(SIM, ETS, CONNECT_RES, { proto: 6 })]))).toThrow(/not UDP/);
    expect(() => pcapToLog(pcap([udp(ETS, SIM, MEM_WRITE)]))).toThrow(/no side is known to be the server/);
    expect(() => pcapToLog(pcap([udp(SIM, ETS, CONNECT_RES), udp(ETS, "127.0.0.1:9999", MEM_WRITE)]))).toThrow(/past the server/);
    expect(() => pcapToLog(pcap([udp(SIM, ETS, [...CONNECT_RES, 0])]))).toThrow(/not one KNXnet\/IP frame/);
  });
});
