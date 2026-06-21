import { inflateRawSync } from "node:zlib";
import { pbkdf2Sync, createCipheriv, createHmac, timingSafeEqual } from "node:crypto";

// Minimal ZIP reader, dependency-free. Handles STORE (0) and DEFLATE (8), plus
// WinZip-AES (method 99) used by ETS for the encrypted inner P-XXXX.zip.
// Returns each entry's decompressed (and decrypted) bytes keyed by name.

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

interface CDEntry { name: string; method: number; lfhOffset: number; compSize: number; }

function findEOCD(buf: Buffer): number {
  // EOCD is at the end; scan back from the last possible position (no comment up to 64k).
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip (no EOCD)");
}

function readCentralDirectory(buf: Buffer): CDEntry[] {
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: CDEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CD_SIG) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lfhOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, lfhOffset, compSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Locate the compressed payload and the AES extra field (if any) from the local
// file header, which is authoritative for where the data begins.
function readLocal(buf: Buffer, e: CDEntry): { data: Buffer; aes?: { strength: number; method: number } } {
  if (buf.readUInt32LE(e.lfhOffset) !== LFH_SIG) throw new Error("bad local header");
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
  throw new Error(`unsupported compression method ${method}`);
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
  if (!timingSafeEqual(verify, pwVerify)) throw new Error("wrong password");

  const mac = createHmac("sha1", macKey).update(cipher).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, authCode)) throw new Error("AES auth failed (corrupt data or wrong password)");

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

export function readZip(buf: Buffer, password?: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const e of readCentralDirectory(buf)) {
    if (e.name.endsWith("/")) continue;
    const { data, aes } = readLocal(buf, e);
    if (e.method === 99) {
      if (!aes) throw new Error(`AES entry ${e.name} missing AES extra field`);
      if (!password) throw new Error("password required");
      const plain = aesDecrypt(data, password, aes.strength);
      files.set(e.name, decompress(plain, aes.method));
    } else {
      files.set(e.name, decompress(data, e.method));
    }
  }
  return files;
}
