import { KnxIpTunnel, KnxUsbTransport, type KnxTransport } from "@busforge/knx";
import type { Connection } from "./db/connections.ts";

// Build the concrete transport for a saved connection. The USB transport pulls in
// node-hid lazily on connect(), so the IP path never loads the native module.
export function makeTransport(c: Connection): KnxTransport {
  if (c.type === "usb") {
    return new KnxUsbTransport({ vendorId: c.usbVendorId ?? undefined, productId: c.usbProductId ?? undefined });
  }
  return new KnxIpTunnel(c.host, c.port);
}

// A connection is "ready" to drive bus operations when its transport-specific
// identity is set. Narrows null away for callers.
export function isConnectionReady(c: Connection | null): c is Connection {
  if (!c) return false;
  return c.type === "usb" ? c.usbVendorId != null && c.usbProductId != null : !!c.host;
}
