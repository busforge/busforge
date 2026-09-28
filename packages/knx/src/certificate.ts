import { KnxError } from "./errors.ts";

// A KNX Data Secure device certificate: the 36-character label (and QR code) printed on a secure
// device, six groups of six separated by dashes. It is RFC 4648 base32 (A-Z, 2-7, no padding) of
// 23 bytes: the 6-byte serial number, the 16-byte factory default setup key (FDSK), used as is for
// the first secured session, and a CRC-4 in the high nibble of the last byte (polynomial
// x^4 + x + 1, over the 22 bytes a nibble at a time, high nibble first). A label that does not
// decode, or whose checksum does not match, is refused: a mistyped FDSK would only show as a device
// that never answers.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CRC4 = [0x0, 0x3, 0x6, 0x5, 0xc, 0xf, 0xa, 0x9, 0xb, 0x8, 0xd, 0xe, 0x7, 0x4, 0x1, 0x2];

function crc4(bytes: Buffer): number {
  let c = 0;
  for (const b of bytes) {
    c = CRC4[c ^ (b >> 4)];
    c = CRC4[c ^ (b & 0x0f)];
  }
  return c;
}

export interface DeviceCertificate { serial: Buffer; fdsk: Buffer; }

export function decodeCertificate(label: string): DeviceCertificate {
  const text = label.replace(/[-\s]/g, "").toUpperCase();
  if (!/^[A-Z2-7]{36}$/.test(text)) {
    throw new KnxError("CERTIFICATE_INVALID", "a device certificate is 36 base32 characters (A-Z, 2-7), optionally in dash-separated groups");
  }
  const out = Buffer.alloc(23);
  let acc = 0, bits = 0, n = 0;
  for (const ch of text) {
    acc = (acc << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8 && n < out.length) { out[n++] = (acc >> (bits - 8)) & 0xff; bits -= 8; }
    acc &= (1 << bits) - 1;
  }
  out[22] = (acc << (8 - bits)) & 0xff; // 180 bits: the last 4 are the checksum nibble
  const payload = out.subarray(0, 22);
  if ((out[22] >> 4) !== crc4(payload)) {
    throw new KnxError("CERTIFICATE_INVALID", "the device certificate's checksum does not match; check it for a mistyped character");
  }
  return { serial: Buffer.from(out.subarray(0, 6)), fdsk: Buffer.from(out.subarray(6, 22)) };
}

// The label for a serial and FDSK, the inverse of decodeCertificate (for tests and for showing a
// stored certificate back in the form printed on the device).
export function encodeCertificate(serial: Buffer, fdsk: Buffer): string {
  if (serial.length !== 6 || fdsk.length !== 16) throw new KnxError("CERTIFICATE_INVALID", "a certificate carries a 6-byte serial and a 16-byte key");
  const bytes = Buffer.concat([serial, fdsk, Buffer.from([crc4(Buffer.concat([serial, fdsk])) << 4])]);
  let acc = 0, bits = 0, text = "";
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5 && text.length < 36) { text += ALPHABET[(acc >> (bits - 5)) & 0x1f]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return text.match(/.{6}/g)!.join("-");
}
