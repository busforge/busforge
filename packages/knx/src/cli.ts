import { KnxIpTunnel } from "./connection.ts";
import { KnxDevice } from "./device.ts";

const ip = process.argv[2] ?? "203.0.113.41";
const target = process.argv[3] ?? "1.2.55";

const tun = new KnxIpTunnel(ip);
await tun.connect();
console.log(`tunnel up, assigned ${tun.assignedIa.toString(16)}, channel ${tun.channel}`);
const dev = new KnxDevice(tun, target);
await dev.connect();
console.log(`device ${target} mask = ${await dev.deviceDescriptor()}`);
const gAddr = await dev.tableAddr(1);
const head = await dev.memRead(gAddr, 2);
const count = (head[0] << 8) | head[1];
const table = await dev.memRead(gAddr, 2 + count * 2);
console.log(`group table @0x${gAddr.toString(16)}: ${count} GAs`);
console.log(`  ${table.toString("hex").match(/../g)!.join("-")}`);
await dev.disconnect();
await tun.disconnect();
console.log("OK");
