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
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_SENTINEL = 0xffffffff;

interface CDEntry { name: string; method: number; flags: number; modTime: number; crc: number; lfhOffset: number; compSize: number; size: number; }

// What one archive may unpack to. The largest entry of any project or product database in the corpus
// unpacks to about 73 MiB and the largest archive to about 98 MiB in all; the caps leave room above
// that and keep a deflate bomb from exhausting the server's memory before anything else can refuse it.
// They hold per readZip call: an archive inside an archive (a project's P-*.zip) has its own.
export const ZIP_ENTRY_LIMIT = 512 * 1024 * 1024;
export const ZIP_TOTAL_LIMIT = 1024 * 1024 * 1024;

// General-purpose bit flags (APPNOTE 4.4.4).
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;

// Every offset and length an archive declares is checked against the bytes it has before it is read,
// so a truncated or forged archive is refused with a code instead of read past its end.
function malformed(what: string): KnxprojError {
  return new KnxprojError("INVALID_KNXPROJ", `malformed zip: ${what}`);
}

function findEOCD(buf: Buffer): number {
  // EOCD is at the end; scan back from the last possible position (no comment up to 64k).
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw malformed("no end of central directory record (not a zip)");
}

function zip64(): KnxprojError {
  return new KnxprojError("ZIP64_UNSUPPORTED", "the archive is a ZIP64 archive, which Busforge does not read");
}

interface CentralDirectory { entries: CDEntry[]; start: number; }

function readCentralDirectory(buf: Buffer): CentralDirectory {
  const eocd = findEOCD(buf);
  // ZIP64 moves the directory's offset and the entries' sizes into records this reader does not parse;
  // its sentinels read as plain numbers would be taken for offsets and sizes that are not there.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) throw zip64();
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const start = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (cdSize === ZIP64_SENTINEL || start === ZIP64_SENTINEL) throw zip64();
  if (eocd + 22 + commentLen > buf.length) throw malformed(`end record comment of ${commentLen} bytes runs past the archive`);
  // The central directory lies between the entries' data and the end record, and holds exactly the
  // bytes the end record declares.
  const end = start + cdSize;
  if (end > eocd) throw malformed(`central directory of ${cdSize} bytes at ${start} runs past the end record at ${eocd}`);
  const pastEnd = (i: number) => malformed(`central directory entry ${i} of ${count} runs past the directory's end at ${end}`);
  let off = start;
  const entries: CDEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > end) throw pastEnd(i);
    if (buf.readUInt32LE(off) !== CD_SIG) throw malformed(`central directory entry ${i} of ${count} has no signature`);
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const modTime = buf.readUInt16LE(off + 12);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lfhOffset = buf.readUInt32LE(off + 42);
    if (compSize === ZIP64_SENTINEL || size === ZIP64_SENTINEL || lfhOffset === ZIP64_SENTINEL) throw zip64();
    const next = off + 46 + nameLen + extraLen + commentLen;
    if (next > end) throw pastEnd(i);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, flags, modTime, crc, lfhOffset, compSize, size });
    off = next;
  }
  if (off !== end) throw malformed(`central directory's ${count} entries end at ${off}, the end record declares ${end}`);
  return { entries, start };
}

// Locate the compressed payload and the AES extra field (if any) from the local file header, which is
// authoritative for where the data begins. An entry's local header and data lie before the central
// directory (cdStart).
function readLocal(buf: Buffer, e: CDEntry, cdStart: number): { data: Buffer; aes?: { strength: number; method: number } } {
  if (e.lfhOffset + 30 > cdStart) throw malformed(`local header of ${e.name} at ${e.lfhOffset} runs into the central directory`);
  if (buf.readUInt32LE(e.lfhOffset) !== LFH_SIG) throw malformed(`local header of ${e.name} has no signature`);
  const localCompSize = buf.readUInt32LE(e.lfhOffset + 18);
  const localSize = buf.readUInt32LE(e.lfhOffset + 22);
  if (localCompSize === ZIP64_SENTINEL || localSize === ZIP64_SENTINEL) throw zip64();
  // With a data descriptor (bit 3) the local sizes may be zero; otherwise they must be the directory's.
  if (!(e.flags & FLAG_DATA_DESCRIPTOR) && (localCompSize !== e.compSize || localSize !== e.size)) {
    throw malformed(`local header of ${e.name} declares ${localCompSize}/${localSize} bytes, its directory ${e.compSize}/${e.size}`);
  }
  const nameLen = buf.readUInt16LE(e.lfhOffset + 26);
  const extraLen = buf.readUInt16LE(e.lfhOffset + 28);
  const extraStart = e.lfhOffset + 30 + nameLen;
  const dataStart = extraStart + extraLen;
  if (dataStart + e.compSize > cdStart) throw malformed(`data of ${e.name} (${e.compSize} bytes at ${dataStart}) runs into the central directory at ${cdStart}`);
  const data = buf.subarray(dataStart, dataStart + e.compSize);

  let aes: { strength: number; method: number } | undefined;
  let p = extraStart;
  while (p + 4 <= dataStart) {
    const id = buf.readUInt16LE(p);
    const len = buf.readUInt16LE(p + 2);
    if (p + 4 + len > dataStart) throw malformed(`extra field of ${e.name} runs past its local header`);
    if (id === 0x9901) {
      // WinZip-AES extra field: version(2) vendor(2) strength(1) method(2).
      if (len < 7) throw malformed(`AES extra field of ${e.name} is ${len} bytes, shorter than 7`);
      aes = { strength: buf[p + 8], method: buf.readUInt16LE(p + 9) };
    }
    p += 4 + len;
  }
  return { data, aes };
}

function checkMethod(method: number): void {
  if (method !== 0 && method !== 8) throw malformed(`unsupported compression method ${method}`);
}

// Unpacks an entry to exactly the size its central directory declares: inflation stops one byte past
// it, so an entry can never unpack to more than readZip has already admitted under the caps.
function decompress(data: Buffer, method: number, e: CDEntry): Buffer {
  checkMethod(method);
  let out: Buffer;
  if (method === 0) {
    if (data.length !== e.size) throw malformed(`stored entry ${e.name} holds ${data.length} bytes, its directory declares ${e.size}`);
    out = Buffer.from(data);
  } else {
    try {
      out = inflateRawSync(data, { maxOutputLength: e.size + 1 });
    } catch {
      throw malformed(`entry ${e.name} does not inflate to the ${e.size} bytes its directory declares`);
    }
  }
  if (out.length !== e.size) throw malformed(`entry ${e.name} holds ${out.length} bytes, its directory declares ${e.size}`);
  return out;
}

// WinZip-AES (AE-1/AE-2): payload = salt | pwVerify(2) | ciphertext | authCode(10).
// Key material from PBKDF2-HMAC-SHA1(password, salt, 1000) = encKey | macKey | verify.
function aesDecrypt(payload: Buffer, password: string, strength: number): Buffer {
  if (strength !== 1 && strength !== 2 && strength !== 3) throw malformed(`AES key strength ${strength} is none of 1, 2, 3`);
  const keyLen = strength === 1 ? 16 : strength === 2 ? 24 : 32;
  const saltLen = keyLen / 2;
  if (payload.length < saltLen + 2 + 10) throw malformed(`AES entry of ${payload.length} bytes is shorter than its salt, check and authentication code`);
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
  if (payload.length < 12) throw malformed("encrypted entry shorter than its encryption header");
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
  checkMethod(e.method);
  const plain = zipCryptoDecrypt(data, Buffer.from(password, "utf8"), checkByte);
  let out: Buffer;
  try { out = decompress(plain, e.method, e); } catch {
    throw new KnxprojError("DECRYPT_FAILED", `entry ${e.name} did not inflate to its declared size after decryption (wrong password or corrupt data)`);
  }
  if (crc32(out) !== e.crc) throw new KnxprojError("DECRYPT_FAILED", `entry ${e.name} fails its CRC after decryption (wrong password or corrupt data)`);
  return out;
}

// What protects a zip's entries: "aes" (WinZip-AES), "zipcrypto" (traditional PKWARE) or "none".
// ETS encrypts every entry of an inner archive the same way, so the first encrypted entry decides.
export function zipEncryption(buf: Buffer): "aes" | "zipcrypto" | "none" {
  const e = readCentralDirectory(buf).entries.find((x) => x.flags & FLAG_ENCRYPTED || x.method === 99);
  return !e ? "none" : e.method === 99 ? "aes" : "zipcrypto";
}

export function readZip(buf: Buffer, password?: string): Map<string, Buffer> {
  const { entries, start } = readCentralDirectory(buf);
  const files = entries.filter((e) => !e.name.endsWith("/"));
  // Admitted before anything is unpacked, on the sizes the directory declares; decompress holds each
  // entry to its declared size.
  let total = 0;
  // Two entries of one name would leave one of them unread, and which one is the zip writer's accident.
  const names = new Set<string>();
  for (const e of files) {
    if (names.has(e.name)) throw malformed(`two entries are named ${e.name}`);
    names.add(e.name);
    if (e.size > ZIP_ENTRY_LIMIT) throw new KnxprojError("ARCHIVE_TOO_LARGE", `entry ${e.name} unpacks to ${e.size} bytes, over the ${ZIP_ENTRY_LIMIT}-byte limit per entry`);
    total += e.size;
  }
  if (total > ZIP_TOTAL_LIMIT) throw new KnxprojError("ARCHIVE_TOO_LARGE", `the archive unpacks to ${total} bytes, over the ${ZIP_TOTAL_LIMIT}-byte limit per archive`);

  const out = new Map<string, Buffer>();
  for (const e of entries) {
    // A directory entry's local header is checked like any other, though it unpacks to nothing.
    const { data, aes } = readLocal(buf, e, start);
    if (e.name.endsWith("/")) continue;
    if (e.method === 99) {
      if (!aes) throw malformed(`AES entry ${e.name} has no AES extra field`);
      if (!password) throw new KnxprojError("PASSWORD_REQUIRED", "password required");
      const plain = aesDecrypt(data, password, aes.strength);
      out.set(e.name, decompress(plain, aes.method, e));
    } else if (e.flags & FLAG_ENCRYPTED) {
      // Strong encryption (bit 6) is PKWARE's certificate-based scheme, which no ETS version writes.
      if (e.flags & FLAG_STRONG_ENCRYPTION) throw new KnxprojError("ZIP_ENCRYPTION_UNSUPPORTED", `entry ${e.name} uses PKWARE strong encryption, which Busforge cannot decrypt`);
      if (!password) throw new KnxprojError("PASSWORD_REQUIRED", "password required");
      try {
        out.set(e.name, zipCryptoEntry(e, data, password));
      } catch (err) {
        // Only ASCII passwords are shown to open an ETS 4/5 archive. Which encoding ETS uses for other
        // characters is not established, so a failure with one does not show the password is wrong.
        if (err instanceof KnxprojError && (err.code === "WRONG_PASSWORD" || err.code === "DECRYPT_FAILED") && Buffer.byteLength(password, "utf8") !== password.length) {
          throw new KnxprojError("ZIPCRYPTO_PASSWORD_ENCODING", "this ETS 4/5 project did not open with a password that has characters outside ASCII; how ETS encodes them is not established, so the password may still be right");
        }
        throw err;
      }
    } else {
      out.set(e.name, decompress(data, e.method, e));
    }
  }
  return out;
}
