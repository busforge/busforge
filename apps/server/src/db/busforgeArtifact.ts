import { gzipSync, gunzipSync } from "node:zlib";
import { randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import { ApiError } from "../errors.ts";

// Async scrypt runs on the libuv thread pool, so the ~150 ms key derivation does
// not block the single-threaded request loop the way scryptSync would.
const scrypt = promisify(scryptCb) as (password: Buffer, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>;

// The .busforge artifact container (our own format, documented in
// docs/export-format.md). The payload is always the export JSON.
//
//   unencrypted: a bare gzip stream of the JSON (utf-8). Open it with one
//                command, no busforge needed: `gunzip < project.busforge`.
//   encrypted:   "BF1E" | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(JSON))
//                key = scrypt(password, salt, N=2^17, r=8, p=1) -> 32 bytes.
//
// We compress THEN encrypt: ciphertext is indistinguishable from random and
// would not compress, so the order is load-bearing, not cosmetic. AES-256 is not
// the weak link here; the password is, which is why the key derivation is the
// memory-hard scrypt (slows offline brute-force far more than plain PBKDF2).
//
// A legacy plaintext `.busforge.json` (a bare JSON object, first byte '{') is
// still accepted by unpack so older exports keep importing.

const MAGIC = Buffer.from("BF1E", "ascii"); // BusForge format 1, Encrypted
const GZIP_MAGIC = 0x1f8b; // first two bytes of any gzip stream (RFC 1952)
const JSON_BRACE = 0x7b; // '{'  -> legacy plaintext .busforge.json
const SALT_LEN = 16;
const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16; // GCM auth tag
const KEY_LEN = 32; // AES-256
// scrypt cost: OWASP-recommended minimum (N=2^17, r=8, p=1 ~= 128 MiB per call).
// maxmem must be raised past the ~128 MiB working set or scrypt throws.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return scrypt(Buffer.from(password, "utf8"), salt, KEY_LEN, SCRYPT);
}

// Serialize an export object into a .busforge artifact. With a password the gzip
// payload is AES-256-GCM sealed; without one it is a bare gzip stream.
export async function packBusforge(data: unknown, password?: string): Promise<Buffer> {
  const gz = gzipSync(Buffer.from(JSON.stringify(data), "utf8"), { level: 9 });
  if (!password) return gz;
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(password, salt), iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

// Parse a .busforge artifact back into its export JSON, sniffing the container:
// a gzip stream is inflated directly, a "BF1E" header is decrypted first, and a
// bare JSON object is read as a legacy plaintext export. Throws a coded ApiError
// the API surfaces (encrypted-but-no-password, wrong password, corrupt input).
export async function unpackBusforge(bytes: Buffer, password?: string): Promise<unknown> {
  if (bytes.length >= 2 && bytes.readUInt16BE(0) === GZIP_MAGIC) {
    return parseJsonGzip(bytes);
  }
  if (bytes.length > MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (!password) throw new ApiError("BUSFORGE_PASSWORD_REQUIRED", "this .busforge export is encrypted; a password is required");
    let off = MAGIC.length;
    const salt = bytes.subarray(off, (off += SALT_LEN));
    const iv = bytes.subarray(off, (off += IV_LEN));
    const tag = bytes.subarray(off, (off += TAG_LEN));
    const ct = bytes.subarray(off);
    const decipher = createDecipheriv("aes-256-gcm", await deriveKey(password, salt), iv);
    decipher.setAuthTag(tag);
    let gz: Buffer;
    try {
      gz = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new ApiError("BUSFORGE_WRONG_PASSWORD", "wrong password, or the .busforge export is corrupt");
    }
    return parseJsonGzip(gz);
  }
  if (bytes.length > 0 && bytes[0] === JSON_BRACE) {
    try { return JSON.parse(bytes.toString("utf8")); } catch { /* fall through */ }
  }
  throw new ApiError("BUSFORGE_INVALID", "not a valid .busforge export");
}

// Cap the inflated size so a tiny crafted gzip can't expand into a multi-GB
// allocation (the unencrypted path is reachable with no password). 1 GiB sits
// far above any realistic project export yet well below Node's buffer limit.
const MAX_INFLATED = 1024 * 1024 * 1024;

function parseJsonGzip(gz: Buffer): unknown {
  let text: string;
  try { text = gunzipSync(gz, { maxOutputLength: MAX_INFLATED }).toString("utf8"); } catch { throw new ApiError("BUSFORGE_INVALID", "corrupt or oversized .busforge export"); }
  try { return JSON.parse(text); } catch { throw new ApiError("BUSFORGE_INVALID", "corrupt .busforge export (invalid JSON)"); }
}
