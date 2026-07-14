import os from "node:os";

// The local IPv4 address and MAC a KNXnet/IP peer must put on the wire. Both the client (whose
// SEARCH_RESPONSE is unicast back to the address it advertises) and the server (which advertises
// its data endpoint in every SEARCH_RESPONSE and CONNECT_RESPONSE) need a routable address here,
// never a loopback and never 0.0.0.0.

interface Nic { address: string; mac: string; }

function firstExternalIPv4(): Nic | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return { address: a.address, mac: a.mac };
    }
  }
  return null;
}

// Falls back to 0.0.0.0 rather than throwing: discovery on a host with no external interface
// finds nothing, which is a true answer. The server refuses on it instead, because a server that
// advertised 0.0.0.0 would be found and then be unreachable.
export const localIPv4 = (): string => firstExternalIPv4()?.address ?? "0.0.0.0";

export function localMac(): Buffer {
  const mac = firstExternalIPv4()?.mac ?? "";
  const parts = mac.split(":").map((h) => parseInt(h, 16));
  return parts.length === 6 && parts.every((n) => Number.isInteger(n)) ? Buffer.from(parts) : Buffer.alloc(6);
}
