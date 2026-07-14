import { test, expect, describe } from "bun:test";
import { parseArgs, selectInterface, ConfigError } from "../src/config.ts";
import { iaToNum, type UsbInterfaceInfo } from "@busforge/knx";

const iface = (o: Partial<UsbInterfaceInfo> = {}): UsbInterfaceInfo => ({
  vendorId: 0x147b, productId: 0x5120, product: "KNX-USB Interface", path: "/dev/hidraw0", ...o,
});

describe("bridge arguments", () => {
  test("defaults to the KNXnet/IP port and no address pool", () => {
    const cfg = parseArgs([]);
    expect(cfg.port).toBe(3671);
    expect(cfg.addresses).toEqual([]); // empty = the interface's own address = exactly one tunnel
  });

  test("parses an address pool", () => {
    expect(parseArgs(["--addresses", "1.1.250, 1.1.251"]).addresses)
      .toEqual([iaToNum("1.1.250"), iaToNum("1.1.251")]);
  });

  test("refuses an address that is not one", () => {
    expect(() => parseArgs(["--addresses", "1.1.250,fnord"])).toThrow(ConfigError);
    expect(() => parseArgs(["--addresses", "1.1.999"])).toThrow(/out of range/);
  });

  test("refuses the same address twice: it would be handed to two tunnels", () => {
    expect(() => parseArgs(["--addresses", "1.1.250,1.1.250"])).toThrow(/twice/);
  });

  test("refuses an unknown option instead of ignoring it", () => {
    // A typo'd flag that is silently dropped is a bridge running with settings nobody chose.
    expect(() => parseArgs(["--adresses", "1.1.250"])).toThrow(/unknown option/);
  });

  test("parses --usb as hex vid:pid", () => {
    const cfg = parseArgs(["--usb", "147b:5120"]);
    expect(cfg.vendorId).toBe(0x147b);
    expect(cfg.productId).toBe(0x5120);
  });
});

describe("interface selection", () => {
  test("takes the only attached interface", () => {
    expect(selectInterface([iface()], parseArgs([])).path).toBe("/dev/hidraw0");
  });

  test("refuses to guess between two interfaces", () => {
    // Bridging the wrong stick means putting telegrams on the wrong bus. There is no safe default.
    const two = [iface(), iface({ path: "/dev/hidraw1", serial: "B" })];
    expect(() => selectInterface(two, parseArgs([]))).toThrow(/several KNX-USB interfaces/);
  });

  test("--usb-path picks one out of several", () => {
    const two = [iface(), iface({ path: "/dev/hidraw1" })];
    expect(selectInterface(two, parseArgs(["--usb-path", "/dev/hidraw1"])).path).toBe("/dev/hidraw1");
  });

  test("says so when nothing is attached", () => {
    expect(() => selectInterface([], parseArgs([]))).toThrow(/no KNX-USB interface found/);
  });
});
