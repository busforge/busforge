import { test, expect, describe } from "bun:test";
import { KnxIpTunnel, KnxUsbTransport } from "@busforge/knx";
import { makeTransport, isConnectionReady } from "../src/transport.ts";
import type { Connection } from "../src/db/connections.ts";

const conn = (over: Partial<Connection>): Connection => ({
  id: "c1", name: "c", type: "ip", host: "", port: 3671,
  usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0, ...over,
});

describe("isConnectionReady", () => {
  test("ip is ready only with a host", () => {
    expect(isConnectionReady(conn({ type: "ip", host: "198.51.100.10" }))).toBe(true);
    expect(isConnectionReady(conn({ type: "ip", host: "" }))).toBe(false);
  });
  test("usb is ready only with vendor and product id", () => {
    expect(isConnectionReady(conn({ type: "usb", usbVendorId: 0x147b, usbProductId: 0x5120 }))).toBe(true);
    expect(isConnectionReady(conn({ type: "usb", usbVendorId: 0x147b, usbProductId: null }))).toBe(false);
    expect(isConnectionReady(conn({ type: "usb" }))).toBe(false);
  });
  test("null is not ready", () => {
    expect(isConnectionReady(null)).toBe(false);
  });
});

describe("makeTransport", () => {
  test("ip connection yields a KNXnet/IP tunnel", () => {
    expect(makeTransport(conn({ type: "ip", host: "198.51.100.10" }))).toBeInstanceOf(KnxIpTunnel);
  });
  test("usb connection yields a USB transport", () => {
    expect(makeTransport(conn({ type: "usb", usbVendorId: 1, usbProductId: 2 }))).toBeInstanceOf(KnxUsbTransport);
  });
});
