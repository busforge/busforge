import dgram from "node:dgram";
import { KNXPORT, SVC, knxFrame, hpai, numToIa } from "./frame.ts";
import { localIPv4 } from "./localnet.ts";

export const SEARCH_MULTICAST = "224.0.23.12";

export interface GatewayInfo {
  name: string;
  ip: string;
  port: number;
  ia: string;
  mac: string;
}

function parseSearchResponse(body: Buffer): GatewayInfo | null {
  if (body.length < 8 + 54) return null;
  const ip = `${body[2]}.${body[3]}.${body[4]}.${body[5]}`;
  const port = body.readUInt16BE(6);
  const dib = body.subarray(8); // Device Information DIB
  if (dib[1] !== 0x01) return null; // description type: device info
  const ia = numToIa(dib.readUInt16BE(4));
  const mac = Array.from(dib.subarray(18, 24)).map((b) => b.toString(16).padStart(2, "0")).join(":");
  // The friendly name is a fixed 30-byte field, NUL-padded: everything from the first NUL onwards
  // is padding, not name. Cut at it rather than matching it in a regex: a control character in a
  // pattern is invisible in the source, and this says the same thing out loud.
  const nameField = dib.subarray(24, 54).toString("latin1");
  const pad = nameField.indexOf("\u0000");
  const name = (pad === -1 ? nameField : nameField.slice(0, pad)).trim();
  return { name, ip, port, ia, mac };
}

// KNXnet/IP discovery: multicast SEARCH_REQUEST, collect SEARCH_RESPONSEs until
// the timeout. Returns [] when no interface answers (e.g. nothing on the LAN).
// A SOCKET failure (bind/permission/network) rejects instead: "the search could
// not run" must stay distinguishable from "the search ran and found nothing",
// or a misconfigured host looks like an empty LAN in the picker.
export function searchInterfaces(timeoutMs = 3000): Promise<GatewayInfo[]> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, GatewayInfo>();
    sock.on("message", (m) => {
      // The ephemeral port is reachable by any LAN host during the window; a short
      // or non-KNX datagram must not throw out of this listener (uncaught -> crash).
      if (m.length < 6 || m.readUInt16BE(2) !== SVC.SEARCH_RES) return;
      const g = parseSearchResponse(m.subarray(6));
      if (g) found.set(g.ip, g);
    });
    sock.on("error", (e) => { try { sock.close(); } catch { /* */ } reject(e); });
    sock.bind(0, () => {
      const local = localIPv4();
      const reqPort = sock.address().port;
      const req = knxFrame(SVC.SEARCH_REQ, hpai(local, reqPort));
      sock.send(req, KNXPORT, SEARCH_MULTICAST);
      setTimeout(() => { try { sock.close(); } catch { /* */ } resolve([...found.values()]); }, timeoutMs);
    });
  });
}

// The maximum local APDU length of a SEARCH_RESPONSE(_EXTENDED) body (HPAI, then DIBs), from its Extended
// Device Information DIB (type 0x08: medium status, reserved, maximum local APDU length, device
// descriptor); null without one, or with a length of 0.
export function extendedDeviceMaxApdu(body: Buffer): number | null {
  if (body.length < 8) return null;
  for (let at = body[0]; at + 2 <= body.length && body[at] >= 2;) {
    const len = body[at];
    if (body[at + 1] === 0x08 && len >= 6 && at + 6 <= body.length) { const n = body.readUInt16BE(at + 4); return n > 0 ? n : null; }
    at += len;
  }
  return null;
}

