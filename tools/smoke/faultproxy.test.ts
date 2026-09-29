import { test, expect } from "bun:test";
import net from "node:net";
import { FaultProxy, type FaultMode } from "./faultproxy.ts";

// A tunnelled L_Data.ind from `src` carrying `tpdu`, as the bridge sends it to a client.
function ind(src: number, tpdu: Buffer): Buffer {
  const cemi = Buffer.concat([Buffer.from([0x29, 0x00, 0xb0, 0x60, src >> 8, src & 0xff, 0x11, 0x64, tpdu.length - 1]), tpdu]);
  const f = Buffer.concat([Buffer.from([0x06, 0x10, 0x04, 0x20, 0, 0, 0x04, 0x01, 0x00, 0x00]), cemi]);
  f.writeUInt16BE(f.length, 4);
  return f;
}
const DEV = 0x11cc;
const securedA = Buffer.from("43f190" + "0000000016ea" + "aabbccdd" + "01020304", "hex");
const securedB = Buffer.from("47f190" + "0000000016eb" + "eeff0011223344" + "05060708", "hex");
const plain = Buffer.from("0340ffff", "hex");

// Send three frames through the pass-through in the given mode and return what the client received.
async function through(mode: FaultMode, frames: Buffer[]): Promise<Buffer[]> {
  const upstream = net.createServer((s) => s.write(Buffer.concat(frames)));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = new FaultProxy("127.0.0.1", (upstream.address() as net.AddressInfo).port, DEV);
  proxy.setMode(mode);
  const port = await proxy.start();
  const got: Buffer[] = [];
  await new Promise<void>((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    c.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6 && buf.length >= buf.readUInt16BE(4)) { const n = buf.readUInt16BE(4); got.push(Buffer.from(buf.subarray(0, n))); buf = buf.subarray(n); }
      if (got.length === frames.length) { c.destroy(); resolve(); }
    });
  });
  await proxy.stop();
  upstream.close();
  return got;
}
const tpdu = (f: Buffer) => f.subarray(19);

test("pass leaves every frame as it was", async () => {
  const frames = [ind(DEV, securedA), ind(DEV, plain), ind(DEV, securedB)];
  expect(await through("pass", frames)).toEqual(frames);
});

test("corrupt flips one bit in each secured data answer of the device, and nothing else", async () => {
  const got = await through("corrupt", [ind(DEV, securedA), ind(DEV, plain), ind(0x1101, securedB)]);
  expect(tpdu(got[0]).subarray(0, -1)).toEqual(securedA.subarray(0, -1));
  expect(tpdu(got[0]).at(-1)).toBe(securedA.at(-1)! ^ 0x01);
  expect(tpdu(got[1])).toEqual(plain);
  expect(tpdu(got[2])).toEqual(securedB); // another device's answer is left alone
});

test("duplicate delivers the first secured answer in place of later ones, with the lengths fixed", async () => {
  const got = await through("duplicate", [ind(DEV, securedA), ind(DEV, plain), ind(DEV, securedB)]);
  expect(tpdu(got[0])).toEqual(securedA);
  expect(tpdu(got[1])).toEqual(plain);
  expect(tpdu(got[2])).toEqual(securedA);
  expect(got[2].readUInt16BE(4)).toBe(got[2].length);
  expect(got[2][18]).toBe(securedA.length - 1);
});
