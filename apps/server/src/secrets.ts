import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ApiError } from "./errors.ts";

// At-rest sealing of Busforge secrets (currently KNX Data Secure tool keys). A
// secret is sealed with a single instance MASTER KEY held OUTSIDE the database, so
// the busforge.db file alone never reveals a key. The sealed blob is what lands in
// the device_security table. See docs/knx-secure-design.md.
//
// Seal format: iv(12) | tag(16) | ciphertext, AES-256-GCM. GCM authenticates, so a
// wrong master key or any tampering fails open() loudly instead of returning garbage.

const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

function requireKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_LEN) throw new ApiError("MASTER_KEY_BAD", `master key must be ${KEY_LEN} bytes, got ${masterKey.length}`);
}

export function seal(plain: Buffer, masterKey: Buffer): Buffer {
  requireKey(masterKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function open(blob: Buffer, masterKey: Buffer): Buffer {
  requireKey(masterKey);
  if (blob.length < IV_LEN + TAG_LEN) throw new ApiError("SECRET_CORRUPT", "sealed secret too short");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // Wrong master key (e.g. a different instance, or a rotated/lost key) or tampering.
    throw new ApiError("SECRET_UNSEAL_FAILED", "cannot decrypt a stored key: wrong or missing master key");
  }
}

// Decode a master key supplied via env: 32 bytes as hex (64 chars) or base64.
function decodeEnvKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw.trim()) ? Buffer.from(raw.trim(), "hex") : Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_LEN) throw new Error(`BUSFORGE_MASTER_KEY must decode to ${KEY_LEN} bytes, got ${key.length}`);
  return key;
}

// Resolve the instance master key. Precedence: the BUSFORGE_MASTER_KEY env var
// (32 RANDOM bytes as hex or base64, not a passphrase: no KDF is applied), else a
// master.key file in the data dir, created with 32 random bytes on first use (0600).
// The file keeps the key out of the database while staying zero-config for a
// self-hosted server; production should pin BUSFORGE_MASTER_KEY via env/keychain.
//
// IMPORTANT: the master key is unrecoverable. Losing it (or restoring busforge.db
// onto a host without its master.key) makes every sealed tool key permanently
// unopenable. Back master.key up WITH the database, or pin the env var. createState
// refuses to start if sealed keys exist but no master key is available, rather than
// silently generating a new one that cannot open them.
export function getMasterKey(dataDir: string): Buffer {
  const env = process.env.BUSFORGE_MASTER_KEY;
  if (env) return decodeEnvKey(env);
  const path = join(dataDir, "master.key");
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== KEY_LEN) throw new Error(`${path} is not a ${KEY_LEN}-byte key (got ${key.length}); refusing to overwrite it`);
    return key;
  }
  const key = randomBytes(KEY_LEN);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}
