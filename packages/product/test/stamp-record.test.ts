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
