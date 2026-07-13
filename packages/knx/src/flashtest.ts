import fs from "node:fs";
import { KnxIpTunnel, KnxDevice, gaToNum, cemiLDataGroup, groupValueRead, iaToNum, runLoadPlan } from "./index.ts";
import { planSystemBGaFlash } from "./flash.ts";
import { readGroupTables } from "./grouptable-read.ts";

// LIVE flash test on the Bun stack: change one group address (2/1/7 -> 2/1/8),
// flash, prove on the bus the device answers on the new GA, then revert.
const ip = process.argv[2] ?? "203.0.113.41";
const ia = process.argv[3] ?? "1.2.20";
const deviceNum = iaToNum(ia);
const BK = "/tmp/busforge-backup";
fs.mkdirSync(BK, { recursive: true });
const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readTables() {
  const tun = new KnxIpTunnel(ip); await tun.connect();
  const dev = new KnxDevice(tun, ia); await dev.connect();
  const mask = await dev.deviceDescriptor();
  const { addr, assoc, comObj } = await readGroupTables(dev); // the shared System B reader (one layout home)
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
const mod = Buffer.from(orig); mod[mod.length - 1] = 0x08; // last GA low byte 0x07 -> 0x08 (2/1/7 -> 2/1/8)
log(`\nBASELINE`);
log(`  2/1/7 responds: ${await groupResponds("2/1/7")} (expect true)`);
log(`  2/1/8 responds: ${await groupResponds("2/1/8")} (expect false)`);

log(`\nFLASH change 2/1/7 -> 2/1/8`);
const f1 = await flash({ addr: mod, assoc: t.assoc, comObj: t.comObj }); log(`  flash: ${f1 ? "OK" : "FAILED"}`);
await sleep(4000);
const a8 = await groupResponds("2/1/8"); const a7 = await groupResponds("2/1/7");
log(`  2/1/8 responds: ${a8} (expect true = change took)`);
log(`  2/1/7 responds: ${a7} (expect false)`);

log(`\nREVERT`);
const f2 = await flash({ addr: orig, assoc: t.assoc, comObj: t.comObj }); log(`  flash: ${f2 ? "OK" : "FAILED"}`);
await sleep(4000);
const r7 = await groupResponds("2/1/7"); const r8 = await groupResponds("2/1/8");
log(`  2/1/7 responds: ${r7} (expect true = restored)`);
log(`  2/1/8 responds: ${r8} (expect false)`);

const proven = f1 && f2 && a8 && !a7 && r7 && !r8;
log(`\n=== TS LIVE FLASH ${proven ? "PROVEN (changed + reverted on the bus)" : "INCONCLUSIVE (see log)"} ===`);
