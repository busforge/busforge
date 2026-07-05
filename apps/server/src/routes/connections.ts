import { randomUUID } from "node:crypto";
import { searchInterfaces, listUsbInterfaces } from "@busforge/knx";
import { listConnections, createConnection, updateConnection, deleteConnection, type ConnectionInput } from "../db/connections.ts";
import { json, err } from "../httputil.ts";
import type { AppState } from "../app.ts";

// Validate a saved-connection payload for the connection library. Returns the
// normalized fields, or an English error string on invalid input.
function parseConnInput(raw: unknown): ConnectionInput | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  // type defaults to 'ip', inferring 'usb' when a usb identity is supplied.
  const type = b.type === "usb" ? "usb" : b.type === "ip" ? "ip" : (b.usbVendorId != null ? "usb" : "ip");
  if (type === "ip") {
    const host = (typeof b.host === "string" ? b.host : "").trim();
    if (!host) return "host (IP address) required for an IP connection";
    const port = Number(b.port) || 3671;
    return { name: name || host, type, host, port, usbVendorId: null, usbProductId: null, usbSerial: null };
  }
  const usbVendorId = Number(b.usbVendorId);
  const usbProductId = Number(b.usbProductId);
  if (!Number.isInteger(usbVendorId) || !Number.isInteger(usbProductId)) return "usbVendorId and usbProductId required for a USB connection";
  const usbSerial = typeof b.usbSerial === "string" ? b.usbSerial : null;
  return { name: name || "KNX-USB", type, host: "", port: 3671, usbVendorId, usbProductId, usbSerial };
}

// /api/connections  -> reusable library of saved bus connections (IP / USB)
export async function handle(req: Request, url: URL, seg: string[], state: AppState): Promise<Response | null> {
  if (seg[1] !== "connections") return null;
  const { db } = state;

  // discovery: enumerate gateways on the LAN / KNX-USB sticks for the picker
  if (seg.length === 3 && seg[2] === "discover-ip" && req.method === "GET") {
    return json(await searchInterfaces());
  }
  if (seg.length === 3 && seg[2] === "discover-usb" && req.method === "GET") {
    try { return json(await listUsbInterfaces()); }
    catch { return err("USB_UNAVAILABLE", "USB support is not available on this server"); }
  }
  if (seg.length === 2 && req.method === "GET") return json(listConnections(db));
  if (seg.length === 2 && req.method === "POST") {
    const input = parseConnInput(await req.json().catch(() => ({})));
    if (typeof input === "string") return err("CONNECTION_FIELDS_INVALID", input);
    return json(createConnection(db, randomUUID(), input, state.now()), 201);
  }
  if (seg.length === 3) {
    const cid = decodeURIComponent(seg[2]);
    if (req.method === "PUT") {
      const input = parseConnInput(await req.json().catch(() => ({})));
      if (typeof input === "string") return err("CONNECTION_FIELDS_INVALID", input);
      const updated = updateConnection(db, cid, input);
      return updated ? json(updated) : err("CONNECTION_NOT_FOUND", "connection not found", 404);
    }
    if (req.method === "DELETE") {
      return deleteConnection(db, cid) ? json({ ok: true }) : err("CONNECTION_NOT_FOUND", "connection not found", 404);
    }
  }
  return err("NOT_FOUND", "not found", 404);
}
