// Minimal STORE (uncompressed) zip writer for tests. readZip does not verify
// CRCs, so a zero CRC is fine; this builds synthetic .knxproj/.knxprod-shaped
// archives without a binary fixture. Shared by the project and server test suites.
export function storeZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = Buffer.from(name);
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt32LE(data.length, 18); // comp size (crc at 14 left 0, unchecked)
    lfh.writeUInt32LE(data.length, 22); // uncomp size
    lfh.writeUInt16LE(nameB.length, 26);
    locals.push(Buffer.concat([lfh, nameB, data]));

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
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
