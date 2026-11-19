import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { readZip, zipEncryption, ZIP_ENTRY_LIMIT, ZIP_TOTAL_LIMIT } from "../src/zip.ts";
import { deriveWinzipPassword } from "../src/knxproj.ts";
import { KnxprojError } from "../src/errors.ts";

const fixture = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n));

interface Entry { name: string; data: Buffer; method?: number; size?: number; extra?: Buffer; }

// A zip of the given entries. `data` is written as is (already compressed for method 8); `size` is the
// uncompressed size the central directory declares, so a test can make an entry lie about it.
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const extra = e.extra ?? Buffer.alloc(0);
    const size = e.size ?? e.data.length;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(e.method ?? 0, 8);
    lfh.writeUInt32LE(e.data.length, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(extra.length, 28);
    const local = Buffer.concat([lfh, name, extra, e.data]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.method ?? 0, 10);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local);
    central.push(Buffer.concat([cd, name]));
    offset += local.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const deflated = (text: string): Entry => ({ name: "d.xml", data: deflateRawSync(Buffer.from(text)), method: 8, size: Buffer.byteLength(text) });
const stored = (text: string): Entry => ({ name: "s.txt", data: Buffer.from(text) });
const sample = () => zip([stored("stored entry"), deflated("<x>deflated entry</x>".repeat(20))]);

// Offsets inside the sample: the central directory starts where the entries' data ends.
const EOCD = (b: Buffer) => b.length - 22;
const CD = (b: Buffer) => b.readUInt32LE(EOCD(b) + 16);

// The thrown value, so a test asserts the code and not only that something threw.
function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) {
    if (e instanceof KnxprojError) return e.code;
    return `uncoded ${(e as Error).name}: ${(e as Error).message}`;
  }
  return "no error";
}

// Either reads, or refuses with a KnxprojError: never a RangeError or a zlib error out of the reader.
function readsOrRefusesCoded(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (e) {
    return e instanceof KnxprojError ? undefined : `${(e as Error).name}: ${(e as Error).message}`;
  }
}

describe("zip reader: offsets and lengths outside the archive", () => {
  test("the sample reads", () => {
    const files = readZip(sample());
    expect(files.get("s.txt")!.toString()).toBe("stored entry");
    expect(files.get("d.xml")!.toString()).toBe("<x>deflated entry</x>".repeat(20));
  });

  test("a central directory offset past the end record is refused", () => {
    const b = sample();
    b.writeUInt32LE(EOCD(b) + 1, EOCD(b) + 16);
    expect(codeOf(() => readZip(b))).toBe("INVALID_KNXPROJ");
  });

  test("an entry count larger than the directory holds is refused", () => {
    const b = sample();
    b.writeUInt16LE(9, EOCD(b) + 10);
    expect(codeOf(() => readZip(b))).toBe("INVALID_KNXPROJ");
  });

  test("a name, extra or comment length past the end record is refused", () => {
    for (const field of [28, 30, 32]) {
      const b = sample();
      b.writeUInt16LE(0xffff, CD(b) + field);
      expect(codeOf(() => readZip(b))).toBe("INVALID_KNXPROJ");
    }
  });

  test("a local header offset past the data is refused", () => {
    for (const lfh of [0xfffffff0, 0]) {
      const b = sample();
      b.writeUInt32LE(lfh === 0 ? CD(b) - 10 : lfh, CD(b) + 42);
      expect(codeOf(() => readZip(b))).toBe("INVALID_KNXPROJ");
    }
  });

  test("a compressed size running into the central directory is refused", () => {
    const b = sample();
    b.writeUInt32LE(CD(b), CD(b) + 20);
    expect(codeOf(() => readZip(b))).toBe("INVALID_KNXPROJ");
  });

  test("a local extra length running past the data is refused", () => {
    const b = sample();
    b.writeUInt16LE(0xffff, 28);
    expect(codeOf(() => readZip(b))).toBe("INVALID_KNXPROJ");
  });

  test("an extra field longer than the local header's extra area is refused", () => {
    const extra = Buffer.alloc(4);
    extra.writeUInt16LE(0x1234, 0);
    extra.writeUInt16LE(40, 2);
    expect(codeOf(() => readZip(zip([{ ...stored("x"), extra }])))).toBe("INVALID_KNXPROJ");
  });

  test("an AES extra field shorter than its seven bytes is refused", () => {
    const extra = Buffer.alloc(6);
    extra.writeUInt16LE(0x9901, 0);
    extra.writeUInt16LE(2, 2);
    expect(codeOf(() => readZip(zip([{ ...stored("x"), method: 99, extra }]), "pw"))).toBe("INVALID_KNXPROJ");
  });

  test("an AES entry shorter than its salt, check and authentication code is refused", () => {
    const extra = Buffer.alloc(11);
    extra.writeUInt16LE(0x9901, 0);
    extra.writeUInt16LE(7, 2);
    extra[8] = 3;
    expect(codeOf(() => readZip(zip([{ name: "a", data: Buffer.alloc(20), method: 99, extra }]), "pw"))).toBe("INVALID_KNXPROJ");
  });

  test("an AES key strength other than 1, 2, 3 is refused", () => {
    const extra = Buffer.alloc(11);
    extra.writeUInt16LE(0x9901, 0);
    extra.writeUInt16LE(7, 2);
    extra[8] = 4;
    expect(codeOf(() => readZip(zip([{ name: "a", data: Buffer.alloc(64), method: 99, extra }]), "pw"))).toBe("INVALID_KNXPROJ");
  });

  test("a ZIP64 archive is refused as such, not read by its sentinels", () => {
    for (const field of [20, 24, 42]) {
      const b = sample();
      b.writeUInt32LE(0xffffffff, CD(b) + field);
      expect(codeOf(() => readZip(b))).toBe("ZIP64_UNSUPPORTED");
    }
    const b = sample();
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    expect(codeOf(() => readZip(Buffer.concat([b.subarray(0, EOCD(b)), locator, b.subarray(EOCD(b))])))).toBe("ZIP64_UNSUPPORTED");
  });

  test("corrupt deflate data is refused with a code", () => {
    expect(codeOf(() => readZip(zip([{ name: "d", data: Buffer.from([0xff, 0xff, 0xff, 0xff]), method: 8, size: 10 }])))).toBe("INVALID_KNXPROJ");
  });
});

// Every archive the reader knows, cut at every length and with every byte set to 0x00 and to 0xFF:
// each reads or is refused with a code. Cuts that keep the end record are the truncated archives
// whose directory then points past the bytes left.
describe("zip reader: truncated and damaged archives never escape uncoded", () => {
  const cases: [string, Buffer, string | undefined][] = [
    ["stored and deflated", sample(), undefined],
    ["ETS 6 project", fixture("sample-encrypted.knxproj"), undefined],
    ["ETS 6 inner AES archive", readZip(fixture("sample-encrypted.knxproj")).get([...readZip(fixture("sample-encrypted.knxproj")).keys()].find((k) => /P-.*\.zip$/.test(k))!)!, deriveWinzipPassword("tester12")],
    ["ZipCrypto archive", fixture("zipcrypto-crc-check.zip"), "secret12"],
    ["ZipCrypto archive with a data descriptor", fixture("zipcrypto-data-descriptor.zip"), "secret12"],
  ];

  for (const [label, buf, password] of cases) {
    test(`${label}: every cut`, () => {
      const escapes: string[] = [];
      for (let n = 0; n < buf.length; n++) {
        const cut = buf.subarray(0, n);
        const tail = Buffer.concat([cut, buf.subarray(buf.length - 22)]);
        for (const b of [cut, tail]) {
          const bad = readsOrRefusesCoded(() => readZip(b, password)) ?? readsOrRefusesCoded(() => zipEncryption(b));
          if (bad) escapes.push(`cut at ${n}: ${bad}`);
        }
      }
      expect(escapes).toEqual([]);
    });

    test(`${label}: every byte set to 0x00 and 0xff`, () => {
      const escapes: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        for (const v of [0x00, 0xff]) {
          const b = Buffer.from(buf);
          b[i] = v;
          const bad = readsOrRefusesCoded(() => readZip(b, password)) ?? readsOrRefusesCoded(() => zipEncryption(b));
          if (bad) escapes.push(`byte ${i} = ${v}: ${bad}`);
        }
      }
      expect(escapes).toEqual([]);
    });
  }
});

describe("zip reader: unpacking bounded by the declared size and the caps", () => {
  // 64 MiB of zeros deflate to about 64 KiB: a bomb that declares a small size.
  const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024));

  test("an entry that inflates past its declared size is refused", () => {
    expect(codeOf(() => readZip(zip([{ name: "bomb.xml", data: bomb, method: 8, size: 1000 }])))).toBe("INVALID_KNXPROJ");
  });

  test("an entry that inflates short of its declared size is refused", () => {
    const e = deflated("short");
    expect(codeOf(() => readZip(zip([{ ...e, size: e.size! + 1 }])))).toBe("INVALID_KNXPROJ");
  });

  test("a stored entry whose size disagrees with its declared size is refused", () => {
    expect(codeOf(() => readZip(zip([{ ...stored("abc"), size: 4 }])))).toBe("INVALID_KNXPROJ");
  });

  test("an entry declared over the per-entry cap is refused before it is unpacked", () => {
    expect(codeOf(() => readZip(zip([{ name: "bomb.xml", data: bomb, method: 8, size: ZIP_ENTRY_LIMIT + 1 }])))).toBe("ARCHIVE_TOO_LARGE");
  });

  test("entries declared over the per-archive cap in all are refused before any is unpacked", () => {
    const each = Math.floor(ZIP_TOTAL_LIMIT / 3) + 1;
    expect(each).toBeLessThanOrEqual(ZIP_ENTRY_LIMIT);
    const entries = ["a", "b", "c"].map((name) => ({ name, data: bomb, method: 8, size: each }));
    expect(codeOf(() => readZip(zip(entries)))).toBe("ARCHIVE_TOO_LARGE");
  });

  test("an entry that declares its true size under the cap reads", () => {
    const files = readZip(zip([{ name: "zeros", data: deflateRawSync(Buffer.alloc(1 << 20)), method: 8, size: 1 << 20 }]));
    expect(files.get("zeros")!.length).toBe(1 << 20);
  });
});
