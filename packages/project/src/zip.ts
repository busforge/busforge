import { inflateRawSync } from "node:zlib";
import { pbkdf2Sync, createCipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { KnxprojError } from "./errors.ts";

// Minimal ZIP reader, dependency-free. Handles STORE (0) and DEFLATE (8), and the two
// encryptions ETS puts on a password-protected inner P-XXXX.zip: WinZip-AES (method 99, ETS 6)
// and traditional PKWARE encryption (ZipCrypto, ETS 4 and 5). Returns each entry's decompressed
// (and decrypted) bytes keyed by name.

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

interface CDEntry { name: string; method: number; flags: number; modTime: number; crc: number; lfhOffset: number; compSize: number; }

// General-purpose bit flags (APPNOTE 4.4.4).
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;

function findEOCD(buf: Buffer): number {
  // EOCD is at the end; scan back from the last possible position (no comment up to 64k).
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new KnxprojError("INVALID_KNXPROJ", "not a zip (no EOCD)");
}

function readCentralDirectory(buf: Buffer): CDEntry[] {
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: CDEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CD_SIG) throw new KnxprojError("INVALID_KNXPROJ", "bad central directory entry");
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const modTime = buf.readUInt16LE(off + 12);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lfhOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, flags, modTime, crc, lfhOffset, compSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Locate the compressed payload and the AES extra field (if any) from the local
// file header, which is authoritative for where the data begins.
function readLocal(buf: Buffer, e: CDEntry): { data: Buffer; aes?: { strength: number; method: number } } {
  if (buf.readUInt32LE(e.lfhOffset) !== LFH_SIG) throw new KnxprojError("INVALID_KNXPROJ", "bad local header");
  const nameLen = buf.readUInt16LE(e.lfhOffset + 26);
  const extraLen = buf.readUInt16LE(e.lfhOffset + 28);
  const extraStart = e.lfhOffset + 30 + nameLen;
  const dataStart = extraStart + extraLen;
  const data = buf.subarray(dataStart, dataStart + e.compSize);

  let aes: { strength: number; method: number } | undefined;
  let p = extraStart;
  while (p + 4 <= dataStart) {
    const id = buf.readUInt16LE(p);
    const len = buf.readUInt16LE(p + 2);
    if (id === 0x9901) {
      aes = { strength: buf[p + 8], method: buf.readUInt16LE(p + 9) };
    }
    p += 4 + len;
  }
  return { data, aes };
}

function decompress(data: Buffer, method: number): Buffer {
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new KnxprojError("INVALID_KNXPROJ", `unsupported compression method ${method}`);
}

// WinZip-AES (AE-1/AE-2): payload = salt | pwVerify(2) | ciphertext | authCode(10).
// Key material from PBKDF2-HMAC-SHA1(password, salt, 1000) = encKey | macKey | verify.
function aesDecrypt(payload: Buffer, password: string, strength: number): Buffer {
  const keyLen = strength === 1 ? 16 : strength === 2 ? 24 : 32;
  const saltLen = keyLen / 2;
  const salt = payload.subarray(0, saltLen);
  const pwVerify = payload.subarray(saltLen, saltLen + 2);
  const cipher = payload.subarray(saltLen + 2, payload.length - 10);
  const authCode = payload.subarray(payload.length - 10);

  const dk = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, keyLen * 2 + 2, "sha1");
  const encKey = dk.subarray(0, keyLen);
  const macKey = dk.subarray(keyLen, keyLen * 2);
  const verify = dk.subarray(keyLen * 2);
  if (!timingSafeEqual(verify, pwVerify)) throw new KnxprojError("WRONG_PASSWORD", "wrong password");

  const mac = createHmac("sha1", macKey).update(cipher).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, authCode)) throw new KnxprojError("DECRYPT_FAILED", "AES auth failed (corrupt data or wrong password)");

  // WinZip CTR: keystream = AES-ECB(counter); counter is a little-endian 128-bit
  // integer starting at 1, incremented per 16-byte block.
  const out = Buffer.alloc(cipher.length);
  const counter = Buffer.alloc(16);
  const ecb = () => { const c = createCipheriv(`aes-${keyLen * 8}-ecb`, encKey, null); c.setAutoPadding(false); return c; };
  let n = 0n;
  for (let i = 0; i < cipher.length; i += 16) {
    n += 1n;
    counter.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
    counter.writeBigUInt64LE(n >> 64n, 8);
    const ks = ecb().update(counter);
    const block = Math.min(16, cipher.length - i);
    for (let j = 0; j < block; j++) out[i + j] = cipher[i + j] ^ ks[j];
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crcStep = (crc: number, byte: number): number => (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = crcStep(c, b);
  return (c ^ 0xffffffff) >>> 0;
}

// Traditional PKWARE encryption (APPNOTE 6.1). Three 32-bit keys are seeded from the password and
// then advanced by every plaintext byte; each ciphertext byte is XORed with a keystream byte drawn
// from the third key. The payload starts with a 12-byte encryption header whose last byte, once
// decrypted, must equal the high byte of the entry's CRC-32, or of its DOS modification time when
// the sizes and CRC follow the data in a data descriptor (bit 3). That check is one byte, so a wrong
// password passes it once in 256 tries; the caller therefore also checks the CRC of the result.
function zipCryptoDecrypt(payload: Buffer, password: Buffer, checkByte: number): Buffer {
  let k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
  const update = (p: number) => {
    k0 = crcStep(k0, p);
    k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    k2 = crcStep(k2, k1 >>> 24);
  };
  for (const b of password) update(b);
  if (payload.length < 12) throw new KnxprojError("INVALID_KNXPROJ", "encrypted entry shorter than its encryption header");
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    const t = (k2 | 2) & 0xffff;
    const p = payload[i] ^ (((t * (t ^ 1)) >>> 8) & 0xff);
    out[i] = p;
    update(p);
  }
  if (out[11] !== checkByte) throw new KnxprojError("WRONG_PASSWORD", "wrong password");
  return out.subarray(12);
}

// A ZipCrypto entry decrypted with the password as UTF-8, inflated and checked against its CRC.
function zipCryptoEntry(e: CDEntry, data: Buffer, password: string): Buffer {
  const checkByte = e.flags & FLAG_DATA_DESCRIPTOR ? e.modTime >>> 8 : e.crc >>> 24;
  const plain = zipCryptoDecrypt(data, Buffer.from(password, "utf8"), checkByte);
  let out: Buffer;
  try { out = decompress(plain, e.method); } catch (err) {
    if (err instanceof KnxprojError) throw err;
    throw new KnxprojError("DECRYPT_FAILED", `entry ${e.name} did not inflate after decryption (wrong password or corrupt data)`);
  }
  if (crc32(out) !== e.crc) throw new KnxprojError("DECRYPT_FAILED", `entry ${e.name} fails its CRC after decryption (wrong password or corrupt data)`);
  return out;
}

// What protects a zip's entries: "aes" (WinZip-AES), "zipcrypto" (traditional PKWARE) or "none".
// ETS encrypts every entry of an inner archive the same way, so the first encrypted entry decides.
export function zipEncryption(buf: Buffer): "aes" | "zipcrypto" | "none" {
  const e = readCentralDirectory(buf).find((x) => x.flags & FLAG_ENCRYPTED || x.method === 99);
  return !e ? "none" : e.method === 99 ? "aes" : "zipcrypto";
}

export function readZip(buf: Buffer, password?: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const e of readCentralDirectory(buf)) {
    if (e.name.endsWith("/")) continue;
    const { data, aes } = readLocal(buf, e);
    if (e.method === 99) {
      if (!aes) throw new KnxprojError("INVALID_KNXPROJ", `AES entry ${e.name} missing AES extra field`);
      if (!password) throw new KnxprojError("PASSWORD_REQUIRED", "password required");
      const plain = aesDecrypt(data, password, aes.strength);
      files.set(e.name, decompress(plain, aes.method));
    } else if (e.flags & FLAG_ENCRYPTED) {
      // Strong encryption (bit 6) is PKWARE's certificate-based scheme, which no ETS version writes.
      if (e.flags & FLAG_STRONG_ENCRYPTION) throw new KnxprojError("ZIP_ENCRYPTION_UNSUPPORTED", `entry ${e.name} uses PKWARE strong encryption, which Busforge cannot decrypt`);
      if (!password) throw new KnxprojError("PASSWORD_REQUIRED", "password required");
      try {
        files.set(e.name, zipCryptoEntry(e, data, password));
      } catch (err) {
        // Only ASCII passwords are shown to open an ETS 4/5 archive. Which encoding ETS uses for other
        // characters is not established, so a failure with one does not show the password is wrong.
        if (err instanceof KnxprojError && (err.code === "WRONG_PASSWORD" || err.code === "DECRYPT_FAILED") && Buffer.byteLength(password, "utf8") !== password.length) {
          throw new KnxprojError("ZIPCRYPTO_PASSWORD_ENCODING", "this ETS 4/5 project did not open with a password that has characters outside ASCII; how ETS encodes them is not established, so the password may still be right");
        }
        throw err;
      }
    } else {
      files.set(e.name, decompress(data, e.method));
    }
  }
  return files;
}
