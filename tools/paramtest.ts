#!/usr/bin/env bun
// Read-only validation: build the parameter image from the project + product data
// and compare it byte-for-byte against the image actually loaded on the device.
// Read-only on the bus (a single memRead), no writes.
//
//   bun run tools/paramtest.ts <interface-ip> <device-ia> <app.xml> <decrypted-0.xml> <device-id>
//
//   bun run tools/paramtest.ts 198.51.100.10 1.2.3 ./M-0162_A-0004-11-F245.xml ./0.xml P-0123-0_DI-4
//
// There are no default paths or default target: every argument is required so a
// bare invocation opens no tunnel and reads nothing.
import fs from "node:fs";
import { parseApplication, buildParameterImage } from "../packages/product/src/index.ts";
import { deviceParamValues } from "../packages/project/src/index.ts";
import { KnxIpTunnel, KnxDevice } from "../packages/knx/src/index.ts";

const ip = process.argv[2];
const ia = process.argv[3];
const appXml = process.argv[4];
const proj0 = process.argv[5];
const devId = process.argv[6];
if (!ip || !ia || !appXml || !proj0 || !devId) {
  console.error("usage: bun run tools/paramtest.ts <interface-ip> <device-ia> <app.xml> <decrypted-0.xml> <device-id>");
  process.exit(2);
}
const LSM = 4;

const model = parseApplication(fs.readFileSync(appXml, "utf8"));
const { values } = deviceParamValues(fs.readFileSync(proj0, "utf8"), devId);
console.log(`app ${model.manufacturer.toString(16)}/${model.appNumber}/${model.version} mask ${model.mask}, ${model.params.size} params, ${values.size} instance values`);
const built = buildParameterImage(model, LSM, values);
console.log(`built image: ${built.length}B`);

const tun = new KnxIpTunnel(ip); await tun.connect();
const dev = new KnxDevice(tun, ia); await dev.connect();
await dev.deviceDescriptor();
const addr = await dev.tableAddr(LSM);
const onDevice = await dev.memRead(addr, built.length);
await dev.disconnect(); await tun.disconnect();

const match = built.equals(onDevice);
console.log(`\nbuilt   : ${built.toString("hex")}`);
console.log(`device  : ${onDevice.toString("hex")}`);
let diffs = 0, first = -1;
for (let i = 0; i < Math.min(built.length, onDevice.length); i++) if (built[i] !== onDevice[i]) { diffs++; if (first < 0) first = i; }
console.log(`\n=== PARAM IMAGE ${match ? "BYTE-MATCH" : `MISMATCH (${diffs} bytes differ, first @${first}: built ${built[first]?.toString(16)} vs device ${onDevice[first]?.toString(16)})`} ===`);
