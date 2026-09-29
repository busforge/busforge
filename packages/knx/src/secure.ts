import { createCipheriv } from "node:crypto";

// KNX Data Secure: AES-128-CCM as the KNX spec defines it (application-layer
// security). This is NOT RFC 3610 CCM: KNX builds its own B0 / Ctr0 blocks (no
// flags octet, the length in a fixed position), so a generic CCM library is the
// wrong tool. We assemble it from AES-CBC (the MAC) and AES-CTR (encryption), which
// is exactly what the reference stacks (Calimero, thelsing/knx) do. Byte layout and
// construction are documented in docs/knx-secure.md, cross-checked against
// those two interoperating implementations.
//
// This module is pure protocol math (no bus, no keys-at-rest); it is verified by
// known-answer vectors plus, ultimately, a real secure read-back on the device.

const MAC_LEN = 4; // KNX truncates the 16-byte CCM tag to 4 bytes
// Octets a secured APDU adds to the plain one it carries: its own TPCI/APCI pair (A_Data_Secure),
// the SCF, the 6-byte sequence and the MAC; the whole inner APDU, APCI included, is the ciphertext.
// Every size limit of the plain path shrinks by this much inside a secure session.
export const SECURE_APDU_OVERHEAD = 2 + 1 + 6 + MAC_LEN;
const SecureService = 0x03f1; // the 10-bit APCI of A_Data_Secure

// SCF (Security Control Field) bits: T A A A B S S S.
export const SCF = {
  TOOL: 0x80,        // bit7: tool access (use the tool key)
  AUTH_CONF: 0x10,   // bits6-4 = 1: CCM auth + confidentiality
  SYS_BCAST: 0x08,   // bit3: system broadcast
  S_A_DATA: 0x00,    // bits2-0: service S-A_Data
  S_A_SYNC_REQ: 0x02,
  S_A_SYNC_RSP: 0x03,
} as const;

// A normal tool-access management write/read: tool key, auth+conf, S-A_Data.
export const SCF_TOOL_DATA = SCF.TOOL | SCF.AUTH_CONF | SCF.S_A_DATA; // 0x90

const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);

// AES-128 single-block ECB (used to drive both CBC-MAC and CTR by hand).
function aesEcb(key: Buffer, block: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

// B0: the CBC-MAC initial block. seq(6) | src(2) | dst(2) | 00 | AT | TPCI | 0xF1 | 00 | len.
// AT = 0x80 when the destination is a group address, else 0x00 (P2P tool access).
// tpci is the outer secure APDU's TPCI byte; len is the plaintext inner APDU length.
function block0(seq: Buffer, src: number, dst: number, dstIsGroup: boolean, tpci: number, len: number): Buffer {
  const b = Buffer.alloc(16);
  seq.copy(b, 0, 0, 6);
  u16(src).copy(b, 6);
  u16(dst).copy(b, 8);
  b[10] = 0x00;
  b[11] = dstIsGroup ? 0x80 : 0x00;
  b[12] = tpci;
  b[13] = SecureService & 0xff; // 0xF1
  b[14] = 0x00;
  b[15] = len;
  return b;
}

// Ctr0: the CTR counter block. seq(6) | src(2) | dst(2) | 00 00 00 00 | 01 | 00.
function blockCtr0(seq: Buffer, src: number, dst: number): Buffer {
  const b = Buffer.alloc(16);
  seq.copy(b, 0, 0, 6);
  u16(src).copy(b, 6);
  u16(dst).copy(b, 8);
  b[14] = 0x01;
  b[15] = 0x00;
  return b;
}

// CBC-MAC over B0 || (len16(AAD) || AAD || plaintext), zero-padded ONCE at the end
// (KNX does not pad the AAD to its own block boundary the way RFC 3610 CCM does; it
// concatenates length+AAD+plaintext and pads the whole run). IV = 0. Returns the
// final 16-byte block; KNX takes its first 4 bytes as the tag.
function cbcMac(key: Buffer, b0: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const macInput = pad16(Buffer.concat([u16(aad.length), aad, plaintext]));
  let y = aesEcb(key, b0); // CBC-MAC, IV = 0: y0 = E(B0)
  for (const blk of chunks(macInput, 16)) {
    y = aesEcb(key, xor(y, blk));
  }
  return y;
}

// AES-CTR keystream applied to data, counter starting at ctr0 (big-endian increment
// of the last bytes). Node's aes-128-ctr treats the 16-byte iv as the initial counter.
function aesCtr(key: Buffer, ctr0: Buffer, data: Buffer): Buffer {
  const c = createCipheriv("aes-128-ctr", key, ctr0);
  return Buffer.concat([c.update(data), c.final()]);
}

function pad16(b: Buffer): Buffer {
  const rem = b.length % 16;
  return rem === 0 ? b : Buffer.concat([b, Buffer.alloc(16 - rem)]);
}
function chunks(b: Buffer, n: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n));
  return out;
}
function xor(a: Buffer, b: Buffer): Buffer {
  const o = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i];
  return o;
}

export interface SecureFields {
  key: Buffer;       // 16-byte AES-128 key (tool key for tool access)
  src: number;       // source individual address
  dst: number;       // destination address
  dstIsGroup: boolean;
  seq: Buffer;       // 6-byte sequence (or random, for Sync.rsp)
  scf: number;       // security control field
  tpci: number;      // outer secure APDU TPCI byte (goes into B0[12])
  aad: Buffer;       // additional authenticated data after the implicit length prefix
  plaintext: Buffer; // the inner APDU to protect
}

// Encode the secured ASDU body: SCF | seq(6) | encryptedPayload | encryptedMAC(4).
// The MAC sits at offset 0 of the CTR buffer (shares the Ctr0 keystream block with
// the payload), but on the wire the payload comes first and the MAC last.
export function secureEncode(f: SecureFields): Buffer {
  // The plaintext length lives in a single B0 byte; a longer APDU would corrupt the
  // MAC silently. Management APDUs are far smaller, so this only guards a misuse.
  if (f.plaintext.length > 0xff) throw new Error(`secure APDU plaintext too long: ${f.plaintext.length} > 255`);
  if (f.seq.length < 6) throw new Error(`secure APDU sequence must be 6 bytes, got ${f.seq.length}`);
  const b0 = block0(f.seq, f.src, f.dst, f.dstIsGroup, f.tpci, f.plaintext.length);
  const tag = cbcMac(f.key, b0, f.aad, f.plaintext).subarray(0, MAC_LEN);
  const ctr0 = blockCtr0(f.seq, f.src, f.dst);
  const enc = aesCtr(f.key, ctr0, Buffer.concat([tag, f.plaintext])); // [macCt | payloadCt]
  const macCt = enc.subarray(0, MAC_LEN);
  const payloadCt = enc.subarray(MAC_LEN);
  return Buffer.concat([Buffer.from([f.scf]), f.seq.subarray(0, 6), payloadCt, macCt]);
}

// Decode and authenticate a secured ASDU body. Returns the recovered plaintext, or
// null when the MAC does not verify (wrong key, tampering, or a desynced sequence
// the caller must Sync to recover). Never returns unauthenticated data.
export function secureDecode(
  body: Buffer,
  f: { key: Buffer; src: number; dst: number; dstIsGroup: boolean; tpci: number; aadFor: (scf: number) => Buffer },
): { seq: Buffer; plaintext: Buffer } | null {
  if (body.length < 1 + 6 + MAC_LEN) return null;
  const scf = body[0];
  const seq = body.subarray(1, 7);
  const payloadCt = body.subarray(7, body.length - MAC_LEN);
  const macCt = body.subarray(body.length - MAC_LEN);
  // CTR buffer order is [mac | payload]; decrypt to [tag | plaintext].
  const ctr0 = blockCtr0(seq, f.src, f.dst);
  const dec = aesCtr(f.key, ctr0, Buffer.concat([macCt, payloadCt]));
  const tag = dec.subarray(0, MAC_LEN);
  const plaintext = dec.subarray(MAC_LEN);
  const b0 = block0(seq, f.src, f.dst, f.dstIsGroup, f.tpci, plaintext.length);
  const expect = cbcMac(f.key, b0, f.aadFor(scf), plaintext).subarray(0, MAC_LEN);
  if (!timingEqual(tag, expect)) return null;
  return { seq, plaintext };
}

function timingEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// A TPDU carrying A_Data_Secure (APCI 0x3F1): the low two bits of octet 0 and all of octet 1.
export function isSecureApdu(tpdu: Buffer): boolean {
  return tpdu.length >= 2 && (tpdu[0] & 0x03) === 0x03 && tpdu[1] === 0xf1;
}

export type SecureGroupOpen =
  | { state: "decrypted"; apdu: Buffer; seq: bigint }
  | { state: "noKey" | "authFailed" | "unsupported" };

// A secured group telegram as a passive observer sees it, opened with the key of its destination
// address. Only S-A_Data with authentication and confidentiality (SCF 0x10), the form ETS loads for a
// secured group object, is opened; tool access, auth-only, system broadcast and Sync are reported
// unsupported rather than decoded. Replay is not judged here: that needs per-sender state.
export function openSecureGroupTpdu(src: number, dst: number, tpdu: Buffer, key: Buffer | undefined): SecureGroupOpen {
  const body = tpdu.subarray(2);
  if (body.length < 1 + 6 + MAC_LEN || body[0] !== SCF.AUTH_CONF) return { state: "unsupported" };
  if (!key) return { state: "noKey" };
  const got = secureDecode(body, { key, src, dst, dstIsGroup: true, tpci: tpdu[0], aadFor: (scf) => Buffer.from([scf]) });
  if (!got) return { state: "authFailed" };
  return { state: "decrypted", apdu: Buffer.from(got.plaintext), seq: BigInt(got.seq.readUIntBE(0, 6)) };
}
