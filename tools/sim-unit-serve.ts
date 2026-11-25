#!/usr/bin/env bun
// Serve a simulated unit (tools/sim-unit.ts, tools/sim-units.ts) as a KNXnet/IP interface with the one device
// behind it, and log every frame of the tool in front through tools/knxproxy.ts, in the capture format
// tools/etsdiff.ts and tools/capture-index.ts read:
//
//   BUSFORGE_CORPUS=... bun run tools/sim-unit-serve.ts <unit> --tool ETS --log ./capture.log \
//     [--port 3700] [--proxy-port 3701] [--advertise <this host's ip>] [--override <object>/<PID>=<hex>]...
//   BUSFORGE_CORPUS=... bun run tools/sim-unit-serve.ts <application id> --product <file> --tool ETS --log ./capture.log \
//     [--donor <unit>] [--learned-from <ETS6.log>]... [--port ...] [--proxy-port ...] [--advertise ...]
//
// <unit> is an own unit (tools/sim-units.ts); an application id without one serves its catalogue unit
// (tools/sim-unit-catalogue.ts) of the application program in --product (a .knxproj or .knxprod holding it, or its
// manufacturer XML): the donor its mask's rule picks (or --donor), with what the identity loop learned from each
// --learned-from ETS6.log, in order.
//
// The tool connects to --proxy-port over KNXnet/IP TCP (ETS: a KNXnet/IP interface at this host); --advertise
// puts that endpoint into the search answers, as knxproxy's PROXY_ADVERTISE does. The simulator's own lines,
// every refusal among them, go to <log>.sim.txt. Ctrl-C (or SIGTERM) stops it and prints the refusals.
import { appendFileSync, readFileSync } from "node:fs";
import { KnxIpServer, numToIa } from "../packages/knx/src/index.ts";
import { startProxy, parseEndpoint, toolLabel } from "./knxproxy.ts";
import { catalogueUnit, catalogueUnitFrom, isCatalogueUnit, readMaybeGzipped, type CatalogueUnitSpec, type RowUnit } from "./sim-unit-catalogue.ts";
import { newSimUnit, SIM_UNITS } from "./sim-units.ts";

const args = process.argv.slice(2);
// The value after the option at `i`, refused where there is none or another option follows.
const valueAt = (name: string, i: number) => {
  if (args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`--${name} takes a value`);
  return args[i + 1];
};
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? valueAt(name, i) : undefined;
};
// Every value of a repeatable option.
const flags = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [valueAt(name, i)] : []));
const id = args[0];
if (!id || id.startsWith("--")) throw new Error("usage: bun run tools/sim-unit-serve.ts <unit> --tool ETS|Busforge --log <file> [--port 3700] [--proxy-port 3701] [--advertise <ip>] [--override <object>/<PID>=<hex>]...\n       bun run tools/sim-unit-serve.ts <application id> --product <file> --tool ETS|Busforge --log <file> [--donor <unit>] [--learned-from <ETS6.log>]... [--port ...] [--proxy-port ...] [--advertise ...]");
const log = flag("log");
if (!log) throw new Error("--log <file> is required: the capture of the tool's frames is what the run is for");
const tool = toolLabel(flag("tool"), "--tool");
const port = Number(flag("port") ?? 3700), proxyPort = Number(flag("proxy-port") ?? port + 1);
const advertise = flag("advertise");
if (advertise !== undefined && !/^\d+\.\d+\.\d+\.\d+$/.test(advertise)) throw new Error(`--advertise ${advertise} is not an IPv4 address`);

const simLog = `${log}.sim.txt`;
// A catalogue unit, with each ETS6.log's lines learned in turn.
const catalogue = (): CatalogueUnitSpec => {
  const product = flag("product");
  if (!product) throw new Error(`${id} is no own unit; its catalogue unit takes the application program from --product <file>`);
  const u = catalogueUnitFrom(id, readMaybeGzipped(product), { donor: flag("donor"), learnedFrom: flags("learned-from").map((name) => ({ name, log: readFileSync(name) })) });
  if ("refused" in u) throw new Error(`sim-refused ${u.refused}`);
  return u;
};
const ownSpec = SIM_UNITS.find((u) => u.id === id);
if (ownSpec && (flag("donor") !== undefined || flag("product") !== undefined || flags("learned-from").length)) throw new Error("--product, --donor and --learned-from are for an application without an own unit");
const spec: RowUnit = ownSpec ?? catalogue();
// --override <object>/<PID>=<hex>, repeatable: the unit answers <hex> as the property's first element in place of
// what its collection holds (of the same length; empty: it answers the property with no element). A deliberately
// wrong identity, to see what ETS makes of it (the identity loop, tools/sim-unit-product.ts); the
// unit is then not the product's, and a line of its log says so.
const overrides = flags("override").map((o) => {
  const m = /^(\d{1,3}\/\d{1,3})=((?:[0-9a-fA-F]{2})*)$/.exec(o);
  if (!m) throw new Error(`--override ${o} is not <object>/<PID>=<hex>`);
  return [m[1], m[2].toLowerCase()] as const;
});
if (overrides.length && !ownSpec) throw new Error("--override is for an own unit; a catalogue unit takes what ETS required with --learned-from");
if (overrides.length && (ownSpec?.memoryMapped || ownSpec?.propertyMapped)) throw new Error(`--override is for a System B unit's properties; ${spec.id} is a System 7 unit`);
const simOpts = { log: (line: string) => appendFileSync(simLog, `${new Date().toISOString()} ${line}\n`) };
const sim = (() => {
  if (isCatalogueUnit(spec)) return catalogueUnit(spec).make(simOpts);
  const state = "stateInCaptures" in spec.behaviour ? spec.behaviour.stateInCaptures : undefined;
  const behaviour = overrides.length ? { stateInCaptures: { properties: { ...state?.properties, ...Object.fromEntries(overrides) }, functionStates: state?.functionStates ?? {} } } : {};
  return newSimUnit(spec, simOpts, behaviour);
})();
if (overrides.length) appendFileSync(simLog, `${new Date().toISOString()} overridden, not the product's identity: ${overrides.map(([k, v]) => `${k}=${v}`).join(", ")}\n`);
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
// SIGTERM too: the ETS driver stops the simulator it started on the bench host by its PID (tools/ets-driver.ts).
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
