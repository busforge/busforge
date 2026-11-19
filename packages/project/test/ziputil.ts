// Minimal zip writer for tests. readZip checks CRCs only on ZipCrypto entries, so a zero CRC is
// fine; this builds synthetic .knxproj/.knxprod-shaped archives without a binary fixture. Shared by
// the project and server test suites.

export interface ZipEntry {
  name: string;
  // Written as is: already compressed for method 8.
  data: Buffer;
  // Compression method, 0 (STORE) by default.
  method?: number;
  // Uncompressed size the headers declare, data.length by default, so a test can make an entry lie.
  size?: number;
  // Local header extra field.
  extra?: Buffer;
}

export function zipOf(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name);
    const extra = e.extra ?? Buffer.alloc(0);
    const size = e.size ?? e.data.length;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(e.method ?? 0, 8);
    lfh.writeUInt32LE(e.data.length, 18); // comp size (crc at 14 left 0, unchecked)
    lfh.writeUInt32LE(size, 22); // uncomp size
    lfh.writeUInt16LE(nameB.length, 26);
    lfh.writeUInt16LE(extra.length, 28);
    locals.push(Buffer.concat([lfh, nameB, extra, e.data]));

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(e.method ?? 0, 10);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameB.length, 28);
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameB]));

    offset += locals[locals.length - 1].length;
  }
  const cdBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

// A STORE zip of the given files.
export function storeZip(files: Record<string, string | Buffer>): Buffer {
  return zipOf(Object.entries(files).map(([name, content]) => ({ name, data: typeof content === "string" ? Buffer.from(content) : content })));
}
