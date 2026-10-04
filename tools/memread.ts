#!/usr/bin/env bun
// One memory read from a device, plain, over a KNXnet/IP TCP tunnel, and the device's answer as it
// came: the bytes, or the refused sub-ranges with the raw answer (KnxDevice.memReadPartial). Read-only.
// For a single address outside a collector plan, e.g. the refused read of docs/raw-acquisition.md.
//
//   bun run tools/memread.ts <host[:port]> <ia> <hex address> <length>
//
// Exit 0: every byte was answered, read or refused. Exit 3: the read stopped (no answer, a mismatch).
import { KnxIpTunnel, KnxDevice } from "../packages/knx/src/index.ts";

const args = process.argv.slice(2);
const m = /^([^:]+)(?::(\d+))?$/.exec(args[0] ?? "");
const port = m?.[2] === undefined ? undefined : Number(m[2]);
const address = /^(0x)?[0-9a-f]+$/i.test(args[2] ?? "") ? parseInt(args[2], 16) : NaN;
const length = /^\d+$/.test(args[3] ?? "") ? Number(args[3]) : NaN;
if (args.length !== 4 || !m || (port !== undefined && (port < 1 || port > 65535)) || Number.isNaN(address) || !(length >= 1)) {
  console.error("usage: bun run tools/memread.ts <host[:port]> <ia> <hex address> <length>");
  process.exit(2);
}
const iaParts = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/.exec(args[1])?.slice(1).map(Number);
if (!iaParts || iaParts[0] > 15 || iaParts[1] > 15 || iaParts[2] > 255) throw new Error(`${args[1]} is not an individual address <area>.<line>.<device>`);

const tun = KnxIpTunnel.tcp(m[1], port);
try {
  await tun.connect();
  const dev = new KnxDevice(tun, args[1]);
  try {
    await dev.connect();
    const r = await dev.memReadPartial(address, length, { chunk: 12 });
    const pieces = r.pieces.map((p) => ({ address: p.address, length: p.length, ...("bytes" in p ? { bytes: p.bytes.toString("hex") } : { refused: p.refused }) }));
    console.log(JSON.stringify({ pieces, stopped: r.stopped && { address: r.stopped.address, error: String(r.stopped.error) } }));
    if (r.stopped) process.exitCode = 3;
  } finally {
    await dev.disconnect().catch(() => {});
  }
} finally {
  await tun.disconnect().catch(() => {});
}
