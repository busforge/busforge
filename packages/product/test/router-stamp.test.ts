import { test, expect } from "bun:test";
import { crc16Ccitt, ownedRuns } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, buildRelativeSegmentTarget, mergeRelativeTarget, leaveUnreadUnchanged, relativeParWriteSet, declaredMcbWrites, checkedStamps, type ImageStamp } from "@busforge/product";
import { catalogueXml, captureText } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The MDT IP Interface/Router's download stamp (object 4, PID 27: size, control, access, CRC) is a CRC the unit
// computes over its parameter segment as it holds it when the download completes: CRC-16-CCITT in the augmented
// convention (crc16Ccitt), as on the thelsing/knx firmware. Its web interface password P-278 (20 bytes at offset 40)
// is in the segment while ETS's full download completes and reads FF afterwards, so the stamp of a full download
// covers the project's password and that of every later parameter download, ETS's own included, covers FF. Private
// corpus: ETS's logs of a full download, a partial download shortening the device name and one setting it back
// (captures/mdt-router-ets6log-*), the project's configuration (mdt-router-unit-config.json), and a read of the unit
// after a later full download and a group-address download by ETS (captures/mdt-router-unit-collect-nach-ets-ga-link.json),
// which holds the project's configuration (pinned below), so the partial downloads' writes apply to it.
corpusDescribe("the MDT IP Interface/Router's download stamp", () => {
  const xml = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const params = new Map((JSON.parse(captureText("mdt-router-unit-config.json")) as { params: [string, string][] }).params);
  const NAME = "M-0083_A-0137-20-7EB2_P-162_R-162";
  const PW = { offset: 40, size: 20 };
  const BASE = 0x14ea;
  const SEGMENT = 3972;
  const target = (values: Map<string, string>) => buildRelativeSegmentTarget(cfg, values, 4, { ownIdleUnionDefaults: true })!;

  // The PID 27 elements ETS read before its download (opening) and after its load controls began (closing, its record).
  const logStamps = (file: string) => {
    const opening: ImageStamp[] = [], closing: ImageStamp[] = [];
    let started = false;
    for (const l of captureText(file).split(/\r?\n/)) {
      if (/Executing: <LdCtrl(Unload|Load) /.test(l)) { started = true; closing.length = 0; }
      const m = l.match(/ReadProperty\([\d.]+, (\d+)\/27, PDT=\d+, (\d+)\.\.\.(\d+)\): ([0-9A-F ]+)$/);
      if (!m) continue;
      const data = Buffer.from(m[4].replace(/ /g, ""), "hex");
      const els = Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, k) => ({ obj: Number(m[1]), element: Number(m[2]) + k, hex: data.subarray(8 * k, 8 * k + 8).toString("hex") }));
      (started ? closing : opening).push(...els);
    }
    return { opening, closing };
  };
  const crcOf = (stamps: ImageStamp[]) => Buffer.from(stamps.find((s) => s.obj === 4 && s.element === 1)!.hex, "hex").readUInt16BE(6);
  // The memory ETS wrote into the segment inside its secured telegrams, as offsets into the segment.
  const etsWrites = (file: string) => new Map(captureText(file).split(/\r?\n/).flatMap((l) => {
    const m = l.match(/Sending Sec_req .*InnerTelegram=MemoryExtended_Write_req -> [\d.]+ \([^)]*\) Address=\$([0-9A-F]+) Count=\d+ Data=([0-9A-F]+)/);
    return m ? [...Buffer.from(m[2], "hex")].map((b, i) => [Number.parseInt(m[1], 16) - BASE + i, b] as [number, number]) : [];
  }));
  const segmentWrites = (file: string) => {
    const w = etsWrites(file);
    expect([file, [...w.keys()].filter((o) => o < 0 || o >= SEGMENT)]).toEqual([file, []]);
    return w;
  };
  const collected = JSON.parse(captureText("mdt-router-unit-collect-nach-ets-ga-link.json")) as { records: { space: string; target: { address?: number; object?: number; pid?: number; start?: number }; bytes?: string }[] };
  const unitSegment = () => Buffer.from(collected.records.find((r) => r.space === "memory" && r.target.address === BASE)!.bytes!, "hex");
  const unitStamp = Buffer.from(collected.records.find((r) => r.space === "property" && r.target.object === 4 && r.target.pid === 27 && r.target.start === 1)!.bytes!, "hex").readUInt16BE(6);

  test("ETS's full download: the stamp it reads after it is the CRC of the image Busforge builds (ETS's, byte for byte: tools/etsdiff.test.ts), the project's password in it", () => {
    const full = target(params).bytes;
    expect(full.subarray(PW.offset, PW.offset + PW.size).some((b) => b !== 0xff)).toBe(true);
    expect(crc16Ccitt(full)).toBe(crcOf(logStamps("mdt-router-ets6log-fulldownload.txt").closing));
  });

  test("each object's stamp is the CRC of what the unit holds: the tables as read, the segment with the password it reads as FF", () => {
    const stampOf = (obj: number) => Buffer.from(collected.records.find((r) => r.space === "property" && r.target.object === obj && r.target.pid === 27 && r.target.start === 1)!.bytes!, "hex");
    const memoryAt = (address: number) => Buffer.from(collected.records.find((r) => r.space === "memory" && r.target.address === address)!.bytes!, "hex");
    const at = (obj: number) => collected.records.find((r) => r.space === "property" && r.target.object === obj && r.target.pid === 7 && r.target.start === 1)!.bytes!;
    for (const obj of [1, 2, 3]) {
      const stamp = stampOf(obj);
      const mem = memoryAt(Number.parseInt(at(obj), 16));
      expect([obj, crc16Ccitt(mem.subarray(0, stamp.readUInt32BE(0)))]).toEqual([obj, stamp.readUInt16BE(6)]);
    }
    const seg = unitSegment();
    seg.set(target(params).bytes.subarray(PW.offset, PW.offset + PW.size), PW.offset);
    expect(crc16Ccitt(seg)).toBe(stampOf(4).readUInt16BE(6));
  });

  test("the unit after a full download reads the password as FF and still reports that stamp: what it reads covers another CRC", () => {
    const seg = unitSegment();
    const full = target(params).bytes;
    expect(seg.subarray(PW.offset, PW.offset + PW.size).every((b) => b === 0xff)).toBe(true);
    expect([...seg].flatMap((b, o) => (b !== full[o] ? [o] : []))).toEqual(Array.from({ length: PW.size }, (_, i) => PW.offset + i).filter((o) => full[o] !== 0xff));
    expect(unitStamp).toBe(crc16Ccitt(full));
    expect(crc16Ccitt(seg)).not.toBe(unitStamp);
  });

  test("ETS's own parameter downloads after it leave the CRC over the FF password", () => {
    let seg = unitSegment();
    for (const file of ["mdt-router-ets6log-partial-name.txt", "mdt-router-ets6log-partial-name-revert.txt"]) {
      seg = Buffer.from(seg);
      for (const [o, b] of segmentWrites(file)) seg[o] = b;
      expect([file, crc16Ccitt(seg)]).toEqual([file, crcOf(logStamps(file).closing)]);
    }
  });

  // Busforge's parameter flash of the same change and of its revert, from the unit as read, with ETS's record of the
  // download before it and without one: the unit then computes the stamp ETS's own download left.
  for (const withRecord of [true, false]) {
    test(`Busforge's parameter flash and its revert, ${withRecord ? "with" : "without"} a record, leave the stamps ETS's parameter downloads leave`, () => {
      const short = "MDT " + Buffer.from([...segmentWrites("mdt-router-ets6log-partial-name.txt")].sort(([a], [b]) => a - b).map(([, b]) => b)).toString("latin1").split("\0")[0];
      let unit = unitSegment();
      const steps: [string, string, string, string][] = [
        [params.get(NAME)!, short, "mdt-router-ets6log-fulldownload.txt", "mdt-router-ets6log-partial-name.txt"],
        [short, params.get(NAME)!, "mdt-router-ets6log-partial-name.txt", "mdt-router-ets6log-partial-name-revert.txt"],
      ];
      for (const [from, to, before, file] of steps) {
        const base = target(new Map(params).set(NAME, from));
        const next = target(new Map(params).set(NAME, to));
        const { target: t } = leaveUnreadUnchanged(unit, next, base, 0);
        const { image } = mergeRelativeTarget(unit, t);
        const record = checkedStamps(logStamps(before).closing);
        const read = record.map((r) => logStamps(file).opening.find((o) => o.obj === r.obj && o.element === r.element)!);
        const check = withRecord ? { equal: read.every((x, i) => x.hex === record[i].hex), read } : null;
        const mask = relativeParWriteSet(image, unit, t.owned, declaredMcbWrites(proc, t.size, "par"), check);
        unit = Buffer.from(unit);
        for (const r of ownedRuns(image, mask)) r.bytes.copy(unit, r.offset);
        expect([file, crc16Ccitt(unit)]).toEqual([file, crcOf(logStamps(file).closing)]);
      }
      expect(crc16Ccitt(unit)).not.toBe(unitStamp);
    });
  }
});
