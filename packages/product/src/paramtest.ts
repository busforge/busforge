import fs from "node:fs";
import { parseApplication, buildParameterImage, deviceParamValues } from "./index.ts";
import { KnxIpTunnel, KnxDevice } from "../../knx/src/index.ts";

// Read-only validation: build the parameter image from the project + product data
// and compare it byte-for-byte against the image actually loaded on the device.
const ip = process.argv[2] ?? "203.0.113.41";
const ia = process.argv[3] ?? "1.2.20";
const appXml = process.argv[4] ?? "/tmp/fkx/mw/M-0162/M-0162_A-0004-11-F245.xml";
const proj0 = process.argv[5] ?? "/tmp/fkx/dec/0.xml";
const devId = process.argv[6] ?? "P-07C7-0_DI-53";
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
