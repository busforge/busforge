import { iaToNum, numToIa, type UsbInterfaceInfo } from "@busforge/knx";

// Argument parsing and interface selection, kept free of side effects so both can be tested
// without a USB stick and without a socket.

export interface BridgeConfig {
  port: number;
  name: string;
  usbPath?: string;
  vendorId?: number;
  productId?: number;
  addresses: number[]; // empty means: use the interface's own address, i.e. exactly one tunnel
}

export class ConfigError extends Error {}

const IA = /^\d{1,2}\.\d{1,2}\.\d{1,3}$/;

export function parseArgs(argv: string[]): BridgeConfig {
  const cfg: BridgeConfig = { port: 3671, name: "Busforge Bridge", addresses: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--port": {
        const p = Number(value());
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ConfigError("--port must be a TCP/UDP port number");
        cfg.port = p;
        break;
      }
      case "--name": cfg.name = value(); break;
      case "--usb-path": cfg.usbPath = value(); break;
      case "--usb": {
        // vid:pid, both hex, as node-hid and lsusb print them.
        const [vid, pid] = value().split(":");
        const v = Number.parseInt(vid ?? "", 16), p = Number.parseInt(pid ?? "", 16);
        if (!Number.isInteger(v) || !Number.isInteger(p)) throw new ConfigError("--usb wants vid:pid in hex, e.g. 147b:5120");
        cfg.vendorId = v; cfg.productId = p;
        break;
      }
      case "--addresses": {
        // Every address here is handed to a tunnelling client as its own. They MUST be free on
        // that line: a bridge that hands out an address a real device already holds puts two
        // senders on it, and the answers to either become ambiguous. Nothing in the protocol can
        // detect that for us, so the list is explicit and never inferred.
        cfg.addresses = value().split(",").map((s) => s.trim()).map((s) => {
          if (!IA.test(s)) throw new ConfigError(`"${s}" is not an individual address (expected e.g. 1.1.250)`);
          const n = iaToNum(s);
          if (numToIa(n) !== s) throw new ConfigError(`"${s}" is out of range for an individual address`);
          return n;
        });
        if (new Set(cfg.addresses).size !== cfg.addresses.length) throw new ConfigError("--addresses lists the same address twice");
        break;
      }
      default:
        throw new ConfigError(`unknown option ${arg}`);
    }
  }
  return cfg;
}

const describe = (i: UsbInterfaceInfo) =>
  `${i.product || "unnamed"} (${i.vendorId.toString(16)}:${i.productId.toString(16)}${i.serial ? `, serial ${i.serial}` : ""})`;

// Pick the interface to bridge. Refuses rather than guesses when the choice is not unambiguous:
// bridging the wrong stick means putting telegrams on the wrong bus.
export function selectInterface(found: UsbInterfaceInfo[], cfg: BridgeConfig): UsbInterfaceInfo {
  if (found.length === 0) throw new ConfigError("no KNX-USB interface found");

  if (cfg.usbPath) {
    const hit = found.find((i) => i.path === cfg.usbPath);
    if (!hit) throw new ConfigError(`no KNX-USB interface at path ${cfg.usbPath}`);
    return hit;
  }
  if (cfg.vendorId !== undefined) {
    const hits = found.filter((i) => i.vendorId === cfg.vendorId && i.productId === cfg.productId);
    if (hits.length === 0) throw new ConfigError(`no KNX-USB interface ${cfg.vendorId.toString(16)}:${cfg.productId?.toString(16)}`);
    if (hits.length > 1) throw new ConfigError("several interfaces share that vendor/product id; select one with --usb-path");
    return hits[0]!;
  }
  if (found.length > 1) {
    throw new ConfigError(`several KNX-USB interfaces are attached, so which bus to bridge is not obvious; pick one with --usb-path:\n${found.map((i) => `  ${describe(i)}  --usb-path ${i.path ?? "?"}`).join("\n")}`);
  }
  return found[0]!;
}
