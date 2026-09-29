import { randomBytes } from "node:crypto";
import type { KnxDevice } from "./device.ts";
import { OBJECT_TYPE_SECURITY, SECURITY_PID } from "./device.ts";
import { KnxError } from "./errors.ts";

// Taking a secure device from its factory key (FDSK) to a tool key of our own, as ETS does it
// (Jung 400021SE, 2026-09-28): a secured session under the FDSK, the security mode switched on,
// the new tool key written, and a new session under that key to prove it took.
//
// The new key is persisted BEFORE it is written to the device. Once written, it is the only way in
// short of a master reset, and a write interrupted after the device took the key but before we
// heard so must not lose it. That also makes the whole operation safe to repeat: a device that
// took the key opens under it (already active), one that did not still opens under its FDSK.

export interface ActivationDeps {
  // A connected, synced session with `key`. A device that does not accept the key does not answer
  // the Sync, which rejects with SECURE_SYNC_NO_RESPONSE.
  open(key: Buffer, serial: Buffer): Promise<KnxDevice>;
  close(dev: KnxDevice): Promise<void>;
}
export interface ActivationInput {
  fdsk: Buffer;
  serial: Buffer;           // the device's serial, for the Sync under the tool key
  storedKey?: Buffer;       // the tool key on file, if any: reused, so a repeated run converges
  persistKey: (key: Buffer) => void | Promise<void>;
  newKey?: () => Buffer;
}
export type ActivationResult = { outcome: "already-active" | "activated"; toolKey: Buffer };

// ETS sends the Sync under the factory key with the serial field zeroed.
const NO_SERIAL = Buffer.alloc(6);
const noSync = (e: unknown) => (e as { code?: string }).code === "SECURE_SYNC_NO_RESPONSE";

async function tryOpen(deps: ActivationDeps, key: Buffer, serial: Buffer): Promise<KnxDevice | null> {
  try { return await deps.open(key, serial); }
  catch (e) { if (noSync(e)) return null; throw e; }
}

async function switchModeOn(dev: KnxDevice): Promise<void> {
  if (await dev.securityMode()) return;
  // Reserved octet, service 0 (set mode), mode 1: ETS's bytes. Two octets are refused (0xF2).
  const { returnCode } = await dev.funcPropExtCommand(OBJECT_TYPE_SECURITY, 1, SECURITY_PID.SECURITY_MODE, Buffer.from([0x00, 0x00, 0x01]));
  if (returnCode !== 0) throw new KnxError("ACTIVATION_REFUSED", `the device refused to switch its security mode on (return code 0x${returnCode.toString(16)})`);
}

// Under the tool key: the security mode on (switched on if a device holds the key with it off),
// and confirmed by reading it back.
async function confirmSecure(deps: ActivationDeps, dev: KnxDevice): Promise<void> {
  try {
    await switchModeOn(dev);
    if (!(await dev.securityMode())) {
      throw new KnxError("ACTIVATION_UNCONFIRMED", "the device opens a session under the tool key, but its security mode stays off");
    }
  } finally { await deps.close(dev); }
}

export async function activateSecureDevice(deps: ActivationDeps, input: ActivationInput): Promise<ActivationResult> {
  if (input.storedKey) {
    const dev = await tryOpen(deps, input.storedKey, input.serial);
    if (dev) { await confirmSecure(deps, dev); return { outcome: "already-active", toolKey: input.storedKey }; }
  }
  const factory = await tryOpen(deps, input.fdsk, NO_SERIAL);
  if (!factory) {
    throw new KnxError("ACTIVATION_NO_KEY_ACCEPTED", "the device opened no secured session, neither under the tool key on file nor under its factory key: it is offline or busy, or it holds a tool key busforge does not know (set by another tool), which only a master reset returns to the factory key");
  }
  const key = input.storedKey ?? (input.newKey ?? (() => randomBytes(16)))();
  try {
    // The certificate's checksum does not catch every typo, and a factory key opens a session with
    // no serial in it: the device's own serial is what says this is the certificate's device.
    const serial = await factory.propRead(0, 11);
    if (!serial.equals(input.serial)) {
      throw new KnxError("CERTIFICATE_SERIAL_MISMATCH", `the device at this address has serial ${serial.toString("hex")}, the certificate is for ${input.serial.toString("hex")}`);
    }
    await input.persistKey(key);
    await switchModeOn(factory);
    await factory.writeToolKey(key);
  } finally { await deps.close(factory); }
  const dev = await tryOpen(deps, key, input.serial);
  if (!dev) throw new KnxError("ACTIVATION_UNCONFIRMED", "the device took the tool key write but opens no session under the new key");
  await confirmSecure(deps, dev);
  return { outcome: "activated", toolKey: key };
}
