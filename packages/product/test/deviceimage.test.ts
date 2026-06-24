import { test, expect } from "bun:test";
import { parseAppConfig, parseApplication, buildDeviceConfig } from "../src/index.ts";
import { buildAbsoluteSegmentImages } from "../src/deviceimage.ts";
import { readRealFixture } from "./real-catalogue.snapshot.ts";

// M-0081 is a real MV-0705 (absolute-segment) device. Its image build is hardware
// byte-verified on 13 instances (docs/mv0705-spike-findings.md); these tests pin the
// behaviour that produces that match WITHOUT embedding real device memory (which is
// gitignored): the segment parses, the build is surgical (only visible parameters
// touch the <Data> default), and an override lands exactly at the parameter's bytes.
const xml = readRealFixture("M-0081_A-FE01-11-75D9.xml.gz");
const app = parseAppConfig(xml);
const model = parseApplication(xml);

test("parses the AbsoluteSegment with its fixed address and default image", () => {
  const seg = app.absoluteSegments.find((s) => s.id.endsWith("AS-4200"));
  expect(seg).toBeDefined();
  expect(seg!.address).toBe(16896);
  expect(seg!.size).toBe(256);
  expect(seg!.data.length).toBe(256); // default image present, not blank
});

test("builds one absolute-segment image at the fixed address, sized from the segment", () => {
  const imgs = buildAbsoluteSegmentImages(app, new Map());
  expect(imgs.length).toBe(1);
  expect(imgs[0].id).toMatch(/AS-4200$/);
  expect(imgs[0].address).toBe(16896);
  expect(imgs[0].bytes.length).toBe(256);
});

test("the default build only differs from the raw <Data> at visible-parameter offsets", () => {
  const seg = app.absoluteSegments.find((s) => s.id.endsWith("AS-4200"))!;
  const built = buildAbsoluteSegmentImages(app, new Map())[0].bytes;
  // Every byte that differs from the manufacturer default must be owned by a
  // parameter that targets this segment (no stray writes outside parameter memory).
  const ownedBytes = new Set<number>();
  for (const ref of model.refs.values()) {
    const p = model.params.get(ref.paramId);
    if (!p || p.codeSegment !== seg.id || p.offset === undefined) continue;
    const t = model.types.get(p.typeId);
    const bytes = t && t.sizeInBit >= 8 ? t.sizeInBit >> 3 : 1;
    for (let b = 0; b < bytes; b++) ownedBytes.add(p.offset + b);
  }
  for (let i = 0; i < built.length; i++) if (built[i] !== seg.data[i]) expect(ownedBytes.has(i)).toBe(true);
});

test("overriding a visible parameter changes only that parameter's byte", () => {
  // Pick a visible, single-byte enum/number parameter that targets the segment.
  const view = buildDeviceConfig(app, new Map());
  const visible = new Map<string, string>();
  for (const blk of view.blocks) for (const it of blk.items) if (it.kind === "param") visible.set(it.param.refId, it.param.value);

  let target: { refId: string; offset: number; next: string } | undefined;
  for (const ref of model.refs.values()) {
    if (!visible.has(ref.id)) continue;
    const p = model.params.get(ref.paramId);
    const t = p && model.types.get(p.typeId);
    if (!p || p.offset === undefined || !t || t.sizeInBit !== 8 || (t.base !== "Number" && t.base !== "Value")) continue;
    const cur = Number(visible.get(ref.id) ?? "0");
    const next = String(cur === 1 ? 2 : 1); // a different in-range small value
    if (String(cur) === next) continue;
    target = { refId: ref.id, offset: p.offset, next };
    break;
  }
  expect(target).toBeDefined();

  const base = buildAbsoluteSegmentImages(app, new Map())[0].bytes;
  const overridden = buildAbsoluteSegmentImages(app, new Map([[target!.refId, target!.next]]))[0].bytes;
  const diffs: number[] = [];
  for (let i = 0; i < base.length; i++) if (base[i] !== overridden[i]) diffs.push(i);
  expect(diffs).toEqual([target!.offset]);
  expect(overridden[target!.offset]).toBe(Number(target!.next));
});
