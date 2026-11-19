#!/usr/bin/env bun
// Serve a simulated unit (tools/sim-unit.ts, tools/sim-units.ts) as a KNXnet/IP interface with the one device
// behind it, and log every frame of the tool in front through tools/knxproxy.ts, in the capture format
// tools/etsdiff.ts and tools/capture-index.ts read:
//
//   BUSFORGE_CORPUS=... bun run tools/sim-unit-serve.ts <unit> --tool ETS --log ./capture.log \
//     [--port 3700] [--proxy-port 3701] [--advertise <this host's ip>]
//
// The tool connects to --proxy-port over KNXnet/IP TCP (ETS: a KNXnet/IP interface at this host); --advertise
// puts that endpoint into the search answers, as knxproxy's PROXY_ADVERTISE does. The simulator's own lines,
// every refusal among them, go to <log>.sim.txt. Ctrl-C stops it and prints the refusals.
import { appendFileSync } from "node:fs";
import { KnxIpServer, numToIa } from "../packages/knx/src/index.ts";
import { startProxy, parseEndpoint, toolLabel } from "./knxproxy.ts";
import { newSimUnit, simUnitSpec } from "./sim-units.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const id = args[0];
if (!id || id.startsWith("--")) throw new Error("usage: bun run tools/sim-unit-serve.ts <unit> --tool ETS|Busforge --log <file> [--port 3700] [--proxy-port 3701] [--advertise <ip>]");
const log = flag("log");
if (!log) throw new Error("--log <file> is required: the capture of the tool's frames is what the run is for");
const tool = toolLabel(flag("tool"), "--tool");
const port = Number(flag("port") ?? 3700), proxyPort = Number(flag("proxy-port") ?? port + 1);
const advertise = flag("advertise");
if (advertise !== undefined && !/^\d+\.\d+\.\d+\.\d+$/.test(advertise)) throw new Error(`--advertise ${advertise} is not an IPv4 address`);

const spec = simUnitSpec(id);
const simLog = `${log}.sim.txt`;
const sim = newSimUnit(spec, { log: (line) => appendFileSync(simLog, `${new Date().toISOString()} ${line}\n`) });
const server = new KnxIpServer({ transport: sim, maxApdu: spec.interfaceMaxApdu, port, name: `Busforge sim ${spec.id}`, log: (l) => appendFileSync(simLog, `${new Date().toISOString()} server: ${l}\n`) });
await server.start();
const proxy = startProxy({ port: proxyPort, bridgeHost: "127.0.0.1", bridgePort: port, log, tool, advertise: advertise ? parseEndpoint(`${advertise}:${proxyPort}`) : undefined });
proxy.listen(proxyPort, "0.0.0.0", () => console.log(`${spec.name} simulated as ${numToIa(sim.deviceIa)} behind ${numToIa(sim.assignedIa)} on :${port}; ${tool} connects to :${proxyPort}; capture ${log}, simulator ${simLog}`));

async function stop(): Promise<void> {
  proxy.close();
  await server.stop();
  console.log(sim.refusals.length ? `${sim.refusals.length} refusals:\n  ${sim.refusals.join("\n  ")}` : "no refusals");
  process.exit(sim.refusals.length ? 1 : 0);
}
process.on("SIGINT", () => { void stop(); });
