import { test, expect } from "bun:test";
import { extendedDeviceMaxApdu } from "../src/discover.ts";
import { KnxIpTunnel, type TunnelSocket } from "../src/connection.ts";
import { cemiLData } from "../src/frame.ts";
import { writeChunks, EXT_WRITE_CHUNK } from "../src/device.ts";

// The MDT IP Interface/Router's SEARCH_RESPONSE_EXTENDED to ETS 6 (captures/openknx-ets-fulldownload.log, house gateway),
// its Extended Device Information DIB `08 08 00 00 00 d2 00 12`: maximum APDU 210, device descriptor 0012.
const MDT = "0610020c009e0801cb0071290e5736010200125a0000008300000090e000170c02000000000153434e2d49503030302e303320495020496e7465726661636520776974680e020202030204020502070109010808000000d200121003cb007129ffffff00cb00710106011404cb007129ffffff00cb0071010000000000000c05125a11ff11fe11fd11fc140700d211fffffe11fefffe11fdffff11fcffff";

test("the interface's maximum APDU from the Extended Device Information DIB", () => {
  expect(extendedDeviceMaxApdu(Buffer.from(MDT, "hex").subarray(6))).toBe(210);
  // Without that DIB (a plain SEARCH_RESPONSE body: HPAI, device information, service families) there is none.
  const plain = Buffer.from(MDT, "hex").subarray(6, 6 + 8 + 0x36 + 0x0e);
  expect(extendedDeviceMaxApdu(plain)).toBeNull();
  expect(extendedDeviceMaxApdu(Buffer.alloc(4))).toBeNull();
});

test("memory writes sized as ETS sizes them: the shorter APDU less the write's octets, else the path limit", () => {
  expect(writeChunks(254, 210)).toEqual({ classic: 63, ext: 205 }); // OpenKNX behind the MDT interface: 205 as ETS writes it
  expect(writeChunks(55, 210)).toEqual({ classic: 52, ext: 50 });   // Theben DALI-Gateway / MIX 2: 52-byte classic writes
  expect(writeChunks(15, 210)).toEqual({ classic: 12, ext: 10 });
  expect(writeChunks(254, null)).toEqual({ classic: 12, ext: Math.min(EXT_WRITE_CHUNK, 249) });
  expect(writeChunks(null, 210)).toEqual({ classic: 12, ext: EXT_WRITE_CHUNK });
});

// A tunnel's UDP socket that answers the CONNECT_REQUEST and, if asked, the extended search with the MDT's response.
class FakeSocket implements TunnelSocket {
  sent: Buffer[] = [];
  private msg: ((m: Buffer) => void) | null = null;
  constructor(private readonly answer: boolean) {}
  bind(_port: number, cb: () => void): void { cb(); }
  on(ev: "message" | "error", cb: ((m: Buffer) => void) | ((e: Error) => void)): void { if (ev === "message") this.msg = cb as (m: Buffer) => void; }
  send(b: Buffer, _port: number, _ip: string, cb: (err: Error | null) => void): void {
    this.sent.push(Buffer.from(b)); cb(null);
    const svc = b.readUInt16BE(2);
    if (svc === 0x0205) setTimeout(() => this.msg!(Buffer.from("061002060018150008010000000000000404 11fa".replace(/ /g, ""), "hex")), 1);
    if (svc === 0x020b && this.answer) setTimeout(() => this.msg!(Buffer.from(MDT, "hex")), 1);
  }
  close(): void {}
}

test("the tunnel asks its interface with ETS's extended search and takes the answer, or none within the timeout", async () => {
  const sock = new FakeSocket(true);
  const tun = new KnxIpTunnel("192.0.2.1", 3671, () => sock);
  await tun.connect();
  expect(await tun.queryMaxApdu()).toBe(210);
  expect(sock.sent.map((b) => b.toString("hex")).at(-1)).toBe("0610020b00140801000000000000060401020806");
  const silent = new KnxIpTunnel("192.0.2.1", 3671, () => new FakeSocket(false));
  (silent as unknown as { searchTimeoutMs: number }).searchTimeoutMs = 20;
  await silent.connect();
  expect(await silent.queryMaxApdu()).toBeNull();
  await tun.disconnect().catch(() => {}); await silent.disconnect().catch(() => {});
});

test("a TPDU longer than a standard frame goes as an extended frame, as ETS sends it", () => {
  expect(cemiLData(0x11ff, 0x1220, Buffer.alloc(16))[2]).toBe(0xbc);
  expect(cemiLData(0x11ff, 0x1220, Buffer.alloc(17))[2]).toBe(0x3c);
});
