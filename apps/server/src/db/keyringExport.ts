import type { Database } from "bun:sqlite";
import { readKeyring, writeKeyring, type KeyringDevice, type KeyringInterface } from "@busforge/project";
import { open } from "../secrets.ts";
import { ApiError } from "../errors.ts";
import { listGroupKeyRows } from "./groupKeys.ts";
import { sendersByGroup } from "./groupSenders.ts";
import { listDeviceCertificateRows } from "./deviceCertificates.ts";

// A project's KNX Data Secure keys as an ETS keyring (.knxkeys), for other tools. What each takes
// from it (docs/knx-secure.md#keyring-export): ETS 6 imports only the device certificates (serial +
// FDSK), so it takes over a device Busforge activated only after a master reset; xknx (Home
// Assistant) and Calimero read the tool keys, group keys, sequence numbers and senders as well.

export function exportKeyring(db: Database, projectId: string, password: string, now: number, masterKey: Buffer): { xml: string; name: string } {
  const project = db.query("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | null;
  if (!project) throw new ApiError("PROJECT_NOT_FOUND", "project not found", 404);
  const iaOf = new Map((db.query("SELECT instance_id AS id, ia FROM devices WHERE project_id = ?").all(projectId) as { id: string; ia: string }[]).map((d) => [d.id, d.ia]));
  const devices = new Map<string, KeyringDevice>();
  const deviceFor = (deviceId: string): KeyringDevice => {
    const ia = iaOf.get(deviceId);
    // A device placed without an address carries "x.y.NaN" from the import.
    if (!ia || ia.includes("NaN")) throw new ApiError("KEYRING_DEVICE_UNPLACED", `a key belongs to device ${deviceId}, which has no individual address in the project`, 409);
    const d = devices.get(deviceId) ?? { individualAddress: ia };
    devices.set(deviceId, d);
    return d;
  };
  // A pending key was generated and kept before it was written and is not confirmed on the device, so
  // it is not stated as the device's tool key. An empty sequence is an unknown one and is left out.
  const toolKeys = db.query("SELECT device_id AS deviceId, tool_key AS toolKey, serial_number AS serial, seq_group AS seq FROM device_security WHERE project_id = ? AND source <> 'pending' ORDER BY device_id")
    .all(projectId) as { deviceId: string; toolKey: Uint8Array; serial: Uint8Array; seq: string }[];
  for (const r of toolKeys) {
    if (r.seq !== "" && !/^\d+$/.test(r.seq)) throw new ApiError("KEYRING_SEQUENCE_INVALID", `the stored sequence number of device ${r.deviceId} is not a number`, 409);
    Object.assign(deviceFor(r.deviceId), { toolKey: open(Buffer.from(r.toolKey), masterKey), serialNumber: Buffer.from(r.serial), ...(r.seq !== "" ? { sequenceNumber: BigInt(r.seq) } : {}) });
  }
  for (const c of listDeviceCertificateRows(db, projectId)) {
    const d = deviceFor(c.deviceId);
    if (d.serialNumber && !Buffer.from(d.serialNumber).equals(c.serialNumber)) {
      throw new ApiError("KEYRING_SERIAL_CONFLICT", `device ${d.individualAddress} has a certificate for another serial than its tool key`, 409);
    }
    Object.assign(d, { serialNumber: c.serialNumber, fdsk: open(c.fdsk, masterKey) });
  }
  const groupRows = listGroupKeyRows(db, projectId);
  const groups = groupRows.map((g) => ({ address: g.raw, key: open(g.key, masterKey) }));
  if (devices.size === 0 && groups.length === 0) throw new ApiError("KEYRING_EMPTY", "this project holds no KNX Data Secure keys or device certificates", 409);

  // Each sender the project assigns to a secured address (a tunnelling channel, Busforge's own sending
  // address) as an interface, with the others that may send there: the other assigned senders and every
  // device with a tool key linked to the address. A software receiver only accepts secured telegrams
  // from addresses it lists, so the list leans to more than the devices' own security tables carry.
  const secured = new Set(groups.map((g) => g.address));
  const keyed = new Set(toolKeys.map((r) => r.deviceId));
  const linked = new Map<number, Set<string>>();
  for (const l of db.query("SELECT DISTINCT ga_raw AS g, device_id AS deviceId FROM device_links WHERE project_id = ?").all(projectId) as { g: number; deviceId: string }[]) {
    if (!secured.has(l.g) || !keyed.has(l.deviceId)) continue;
    linked.set(l.g, (linked.get(l.g) ?? new Set()).add(iaOf.get(l.deviceId)!));
  }
  const byIa = new Map<string, KeyringInterface>();
  for (const [g, ias] of sendersByGroup(db, projectId)) {
    if (!secured.has(g)) continue;
    for (const ia of ias) {
      const others = [...new Set([...ias, ...(linked.get(g) ?? [])])].filter((x) => x !== ia);
      const itf = byIa.get(ia) ?? { individualAddress: ia, groups: [] };
      itf.groups.push({ address: g, senders: others });
      byIa.set(ia, itf);
    }
  }

  const keyring = {
    project: project.name, createdBy: "Busforge", created: new Date(now).toISOString().slice(0, 19),
    devices: [...devices.values()], groups, interfaces: [...byIa.values()],
  };
  const xml = writeKeyring(keyring, password);
  // Read the file back the way a receiving tool does before it leaves: the signature must hold and
  // every key must come out as it went in.
  const back = readKeyring(xml, password);
  const same = (a?: Uint8Array, b?: Uint8Array) => (a && b ? Buffer.from(a).equals(Buffer.from(b)) : a === b);
  const ok = back.groups.length === groups.length && groups.every((g) => back.groups.some((x) => x.address === g.address && same(x.key, g.key)))
    && JSON.stringify(back.interfaces ?? []) === JSON.stringify(keyring.interfaces.map((i) => ({ ...i, groups: [...i.groups].sort((a, b) => a.address - b.address) })))
    && back.devices.length === keyring.devices.length
    && keyring.devices.every((d) => { const b = back.devices.find((x) => x.individualAddress === d.individualAddress); return !!b && same(b.toolKey, d.toolKey) && same(b.fdsk, d.fdsk) && same(b.serialNumber, d.serialNumber) && b.sequenceNumber === d.sequenceNumber; });
  if (!ok) throw new ApiError("KEYRING_SELF_CHECK_FAILED", "the written keyring did not read back with the same keys", 500);
  return { xml, name: project.name };
}
