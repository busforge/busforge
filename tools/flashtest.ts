#!/usr/bin/env bun
// LIVE flash harness: change one group address on a real device (the address table's last GA gets
// low byte 0x08), flash it, prove on the bus that the device answers on the new GA,
// then revert. This WRITES to a real KNX device.
//
//   bun run tools/flashtest.ts <interface-ip> <device-ia> <extended|classic>
//
//   bun run tools/flashtest.ts 198.51.100.10 1.2.3 classic
//
// The third argument is the application's SupportsExtendedMemoryServices option (extended = set):
// it decides the memory write service, as it does for ETS.
//
// WARNING: this is a WRITE path. It reprograms the group-address table of the
// device you name and only reverts if every step succeeds. Never run it against a
// device in a live installation you are not prepared to reprogram. There is no
// default target: both arguments are required so a bare invocation does nothing.
import fs from "node:fs";
import { KnxIpTunnel, KnxDevice, gaToNum, cemiLDataGroup, groupValueRead, iaToNum, runLoadPlan } from "../packages/knx/src/index.ts";
import { planSystemBGaFlash } from "../packages/knx/src/flash.ts";
import { readGroupTables, assocFormOf, ASSOC_TABLE_DESCRIPTION } from "../packages/knx/src/grouptable-read.ts";
import { formatGa } from "../packages/knx/src/ga.ts";

const ip = process.argv[2];
const ia = process.argv[3];
const services = process.argv[4];
if (!ip || !ia || (services !== "extended" && services !== "classic")) {
  console.error("usage: bun run tools/flashtest.ts <interface-ip> <device-ia> <extended|classic>");
  console.error("  WRITE path: reprograms the named device's group-address table, then reverts.");
  process.exit(2);
}
const deviceNum = iaToNum(ia);
const BK = "/tmp/busforge-backup";
fs.mkdirSync(BK, { recursive: true });
const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readTables() {
  const tun = new KnxIpTunnel(ip); await tun.connect();
  const dev = new KnxDevice(tun, ia); await dev.connect();
  const mask = await dev.deviceDescriptor();
  // The association table is written back as read, so it is read in the form the unit describes.
  const form = assocFormOf(await dev.propertyDescription(ASSOC_TABLE_DESCRIPTION.object, ASSOC_TABLE_DESCRIPTION.pid, 0));
  if (form === null) { console.error("the device describes its association table with a data type no capture shows"); process.exit(1); }
  const { addr, assoc, comObj } = await readGroupTables(dev, form); // the shared System B reader (one layout home)
  await dev.disconnect(); await tun.disconnect();
  return { mask, addr, assoc, comObj };
}

async function groupResponds(gaStr: string): Promise<boolean> {
  const ga = gaToNum(gaStr);
  const tun = new KnxIpTunnel(ip); await tun.connect();
  let got = false;
  tun.onCemi = (src, dst, _tpdu, isGroup) => { if (isGroup && src === deviceNum && dst === ga) got = true; };
  await tun.sendCemi(cemiLDataGroup(tun.assignedIa, ga, groupValueRead()));
  for (let i = 0; i < 25 && !got; i++) await sleep(100);
  await tun.disconnect();
  return got;
}

async function flash(tables: { addr: Buffer; assoc: Buffer; comObj: Buffer }): Promise<boolean> {
  for (let i = 1; i <= 8; i++) {
    const tun = new KnxIpTunnel(ip); await tun.connect();
    const dev = new KnxDevice(tun, ia);
    dev.setExtendedMemoryServices(services === "extended");
    try { await dev.connect(); await dev.deviceDescriptor(); await runLoadPlan(dev, planSystemBGaFlash(tables)); await dev.disconnect(); await tun.disconnect(); return true; }
    catch (e) { log(`   flash attempt ${i}: ${(e as Error).message}`); try { await tun.disconnect(); } catch { /* teardown between retries: a failed disconnect must not mask the flash error above */ } await sleep(1500); }
  }
  return false;
}

const t = await readTables();
log(`device ${ia} mask=${t.mask}`);
log(`addr table (${t.addr.length}B): ${t.addr.toString("hex").match(/../g)!.join("-")}`);
fs.writeFileSync(`${BK}/addr.bin`, t.addr); fs.writeFileSync(`${BK}/assoc.bin`, t.assoc); fs.writeFileSync(`${BK}/comobj.bin`, t.comObj);
log(`backups saved to ${BK}`);

const orig = t.addr;
const mod = Buffer.from(orig); mod[mod.length - 1] = 0x08;
const entries = Array.from({ length: (orig.length - 2) / 2 }, (_, i) => orig.readUInt16BE(2 + 2 * i));
// planSystemBGaFlash writes System B's layout, [count:2][GA:2]xN, ascending: any other table is refused.
if (orig.length % 2 !== 0 || orig.readUInt16BE(0) !== entries.length) { console.error("the device's address table is not System B's [count:2][GA:2]xN layout"); process.exit(1); }
if (entries.length === 0) { console.error("the device's address table holds no group address to change"); process.exit(1); }
if (entries.length > 1 && mod.readUInt16BE(mod.length - 2) <= entries[entries.length - 2]) { console.error("the changed last address would no longer sort after the one before it"); process.exit(1); }
const from = formatGa(orig.readUInt16BE(orig.length - 2), 3);
const to = formatGa(mod.readUInt16BE(mod.length - 2), 3);
if (entries.includes(mod.readUInt16BE(mod.length - 2))) { console.error(`${to} is already in the device's address table: changing ${from} to it proves nothing`); process.exit(1); }
log(`\nBASELINE`);
log(`  ${from} responds: ${await groupResponds(from)} (expect true)`);
log(`  ${to} responds: ${await groupResponds(to)} (expect false)`);

log(`\nFLASH change ${from} -> ${to}`);
const f1 = await flash({ addr: mod, assoc: t.assoc, comObj: t.comObj }); log(`  flash: ${f1 ? "OK" : "FAILED"}`);
await sleep(4000);
const a8 = await groupResponds(to); const a7 = await groupResponds(from);
log(`  ${to} responds: ${a8} (expect true = change took)`);
log(`  ${from} responds: ${a7} (expect false)`);

log(`\nREVERT`);
const f2 = await flash({ addr: orig, assoc: t.assoc, comObj: t.comObj }); log(`  flash: ${f2 ? "OK" : "FAILED"}`);
await sleep(4000);
const r7 = await groupResponds(from); const r8 = await groupResponds(to);
log(`  ${from} responds: ${r7} (expect true = restored)`);
log(`  ${to} responds: ${r8} (expect false)`);

const proven = f1 && f2 && a8 && !a7 && r7 && !r8;
log(`\n=== TS LIVE FLASH ${proven ? "PROVEN (changed + reverted on the bus)" : "INCONCLUSIVE (see log)"} ===`);
