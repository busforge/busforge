import { test, expect } from "bun:test";
import { relativeParWriteSet, checkedStamps } from "../src/profiles.ts";

const el = (obj: number, element: number, size: number, control: number, crc: number) =>
  ({ obj, element, hex: Buffer.concat([Buffer.from([size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, control, 0xff]), Buffer.from([crc >> 8, crc & 0xff])]).toString("hex") });

test("only the application objects' regions with CRC control 0 are checked", () => {
  const record = [el(1, 1, 4, 0, 1), el(2, 1, 6, 0, 2), el(3, 1, 20, 1, 3), el(4, 1, 1, 1, 4), el(4, 2, 7, 0, 5)];
  expect(checkedStamps(record)).toEqual([record[4]]);
});

test("the unit's regions are laid out from all its elements, a control-1 region whole, a control-0 region by its changes", () => {
  const owned = new Array<number>(8).fill(0xff);
  const current = Buffer.alloc(8);
  const image = Buffer.alloc(8); image[3] = 9;           // a change in the control-0 region
  const read = [el(4, 1, 1, 1, 0xaa), el(4, 2, 7, 0, 0xbb)]; // byte 0: its own region, control 1
  expect(relativeParWriteSet(image, current, owned, [], { equal: true, read })).toEqual([0xff, 0, 0, 0xff, 0, 0, 0, 0]);
  expect(relativeParWriteSet(image, current, owned, [], { equal: false, read })).toEqual(owned);
  expect(relativeParWriteSet(image, current, owned, [], null)).toEqual(owned);
});

// A byte the unit reads as FF says nothing about what it holds (a write-only field, a password). Where the project
// set it to FF since the last programming, the read cannot show the change; ETS, comparing with its record's image,
// writes it, and so does the differential, deciding such a byte against the image of the programmed baseline.
test("a byte read as FF that the project changed to FF since the baseline is written; one unchanged is not", () => {
  const owned = new Array<number>(4).fill(0xff);
  const current = Buffer.from([0xff, 0xff, 0x00, 0x00]);
  const image = Buffer.from([0xff, 0xff, 0x00, 0x05]);
  const base = Buffer.from([0x41, 0xff, 0x00, 0x00]); // byte 0: was "A", now FF; byte 1: FF before and after
  const read = [el(4, 1, 4, 0, 0xbb)];
  expect(relativeParWriteSet(image, current, owned, [], { equal: true, read }, base)).toEqual([0xff, 0, 0, 0xff]);
  expect(relativeParWriteSet(image, current, owned, [], { equal: true, read })).toEqual([0, 0, 0, 0xff]);
});
