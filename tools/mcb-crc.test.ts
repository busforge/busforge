import { expect } from "bun:test";
import { crc16Ccitt, mcbProves } from "../packages/knx/src/flash.ts";
import { captureText } from "./corpus.ts";
import { corpusTest } from "./corpus-test.ts";
import { parseCapture, captureDevice, memoryImage, etsAllocations, reportedTableReferences } from "./etsdiff.ts";

// What a download's verify takes in place of reading a segment back (mcbProves): the CRCs the device
// computes over each region of a loaded segment and reports in its memory-control block (PID 27). Pinned
// here against ETS: after each of these full downloads ETS reads that block of every object, and the CRC
// each region reports is the CRC over exactly the bytes ETS wrote there (on the allocation's fill). The
// OpenKNX RaumController's tables report no block to ETS, which reads only the application's.
const DOWNLOADS: [string, number][] = [
  ["jung-400021se-ets-fulldownload.log", 4],
  ["mix2-rmg8t-ets-fulldownload.log", 4],
  ["mix2-jmg4t-ets-fulldownload.log", 4],
  ["mix2-hmg6t-ets-fulldownload.log", 4],
  ["gvs-amma-ets-fulldownload-defaults.log", 4],
  ["openknx-ets-fulldownload.log", 1],
  ["dali-ets-fulldownload-real.log", 4],
  ["meanwell-ets-fulldownload.log", 4],
];

for (const [file, objects] of DOWNLOADS) {
  corpusTest(`the memory-control block CRCs after ETS's download prove the bytes ETS wrote (${file})`, () => {
    const text = captureText(file);
    const cap = parseCapture(text, captureDevice(text));
    const mem = memoryImage(cap.writes), alloc = etsAllocations(cap), refs = reportedTableReferences(cap);
    let proven = 0;
    for (const obj of [1, 2, 3, 4]) {
      const block = cap.propResponses.filter((r) => r.obj === obj && r.pid === 27).at(-1);
      if (!block) continue;
      const a = alloc.get(obj)!, at = refs.get(obj)!;
      const seg = Buffer.alloc(a.size, a.fill ?? 0);
      for (let i = 0; i < a.size; i++) seg[i] = mem.get(at + i) ?? seg[i];
      const entries = [];
      for (let p = 0; p + 8 <= block.data.length; p += 8) entries.push({ size: block.data.readUInt32BE(p), control: block.data[p + 4], crc: block.data.readUInt16BE(p + 6) });
      expect([obj, mcbProves(entries, seg)]).toEqual([obj, true]);
      // A single byte off proves nothing.
      seg[seg.length - 1] ^= 0xff;
      expect([obj, mcbProves(entries, seg)]).toEqual([obj, false]);
      proven++;
    }
    expect(proven).toBe(objects);
  });
}

// That the device computes the CRC from its memory again after a restart, not keeps the one of the load:
// every download ETS sends writes 01 into the Jung 400021SE's one-byte second region, and the Jung clears
// that byte after the download (findings §27). In the next session, before ETS writes anything, the region
// reports the CRC over 00.
corpusTest("the Jung 400021SE reports the CRC over the byte it cleared after the restart, not over the byte the download wrote", () => {
  const text = captureText("jung-400021se-ets-partial-links.log");
  const first = parseCapture(text, captureDevice(text)).propResponses.find((r) => r.obj === 4 && r.pid === 27)!;
  const second = { size: first.data.readUInt32BE(8), crc: first.data.readUInt16BE(14) };
  expect(second).toEqual({ size: 1, crc: crc16Ccitt(Buffer.from([0x00])) });
  expect(second.crc).not.toBe(crc16Ccitt(Buffer.from([0x01])));
});
