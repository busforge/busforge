import { inspect } from "node:util";
import { KnxIpServer, KnxUsbTransport, listUsbInterfaces, numToIa, USB_HID_MAX_APDU } from "@busforge/knx";
import { parseArgs, selectInterface, ConfigError } from "./config.ts";
import { superviseInterface } from "./supervise.ts";

// busforge-bridge: puts a KNX-USB interface on the network as a KNXnet/IP tunnelling server.
//
// It exists because a USB interface can only be opened by one process on one machine. That forced
// every piece of bus work onto the machine the stick is plugged into, and it made the bus
// monitor and a download mutually exclusive. With the bridge, that interface is
// an ordinary KNXnet/IP gateway on the LAN: Busforge can run anywhere, several tunnels can share
// the bus, and ETS can use it too.
//
// This does not replace the other two paths. Busforge still speaks to a real KNX-IP gateway
// directly, and still drives a USB stick attached to the machine it runs on. The bridge is the
// third: a USB stick attached to a DIFFERENT machine.
//
//   bun run apps/bridge/src/index.ts [--usb-path <p> | --usb 147b:5120]
//                                    [--port 3671] [--name "Bench"] [--addresses 1.1.250,1.1.251]

const stamp = () => new Date().toISOString();
const log = (m: string) => console.log(`[${stamp()}] ${m}`);
const say = (why: string, e?: unknown) => {
  const err = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : e === undefined ? "" : inspect(e, { depth: 3 });
  console.error(`[${stamp()}] ${why}${err ? `: ${err}` : ""}`);
};

// A process holding a KNX interface must never disappear without saying why: the far end is a real
// bus, and a download that dies mid-bracket leaves the device reset, not half-configured.
process.on("uncaughtException", (e) => say("UNCAUGHT EXCEPTION (bridge stays up)", e));
process.on("unhandledRejection", (e) => say("UNHANDLED REJECTION (bridge stays up)", e));

const cfg = (() => {
  try {
    return parseArgs(Bun.argv.slice(2));
  } catch (e) {
    if (e instanceof ConfigError) { say(e.message); process.exit(2); }
    throw e;
  }
})();

const iface = await (async () => {
  try {
    return selectInterface(await listUsbInterfaces(), cfg);
  } catch (e) {
    if (e instanceof ConfigError) { say(e.message); process.exit(1); }
    throw e;
  }
})();

log(`using ${iface.product || "unnamed interface"} (${iface.vendorId.toString(16)}:${iface.productId.toString(16)})`);
if (!iface.serial) log("this interface reports no USB serial: if it goes away, reopening it works only while no identical interface is attached");

const usb = new KnxUsbTransport({ path: iface.path, vendorId: iface.vendorId, productId: iface.productId });
await usb.connect();
log(`interface is ${usb.assignedIa === 0 ? "NOT telling us its address" : numToIa(usb.assignedIa)}`);

const server = new KnxIpServer({
  transport: usb,
  maxApdu: USB_HID_MAX_APDU,
  addresses: cfg.addresses.length ? cfg.addresses : undefined,
  serialNumber: usb.serialNumber,
  name: cfg.name,
  port: cfg.port,
  log,
});
await server.start();

// A HID path does not survive a re-enumeration, so a reopen names the stick by vendor, product and
// serial, as a saved USB connection in the server does.
const supervisor = superviseInterface({
  initial: usb,
  server,
  open: async () => {
    const t = new KnxUsbTransport({ vendorId: iface.vendorId, productId: iface.productId, serial: iface.serial });
    try {
      await t.connect();
    } catch (e) {
      await t.disconnect();
      throw e;
    }
    return t;
  },
  log,
});

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log(`received ${sig}, closing the tunnels and releasing the interface`);
  // Order matters: tell the clients first, THEN drop the bus. A client that is mid-download and
  // discovers the bus is gone only when its frames stop being confirmed cannot tell that from a
  // bus fault, and the device it was writing is left in whatever state the interruption found it.
  supervisor.stop();
  await server.stop();
  await supervisor.current()?.disconnect();
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => void shutdown(sig));
}
