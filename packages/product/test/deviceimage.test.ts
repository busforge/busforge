import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import { parseAppConfig, parseApplication, buildDeviceConfig, decodeAbsoluteImage } from "../src/index.ts";
import { encode } from "../src/image.ts";
import { buildAbsoluteSegmentImages, buildAbsoluteSegmentTargets, buildRelativeSegmentTarget, mergeRelativeTarget, verifyRelativeOwned } from "../src/deviceimage.ts";
import type { RelativeSegmentTarget } from "../src/deviceimage.ts";
import { toAppModel, resolveModuleInstances } from "../src/index.ts";
import { readRealFixture } from "./real-catalogue.snapshot.ts";
import { corpusDescribe, corpusTest } from "../../../tools/corpus-test.ts";

// M-0081 is a real MV-0705 (absolute-segment) device. Its image build is hardware
// byte-verified on 13 instances (docs/device-memory-model.md); these tests pin the
// behaviour that produces that match WITHOUT embedding real device memory (which is
// gitignored): the segment parses, the build is surgical (only visible parameters
// touch the <Data> default), and an override lands exactly at the parameter's bytes.
corpusDescribe("the real M-0081 absolute segment", () => {
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

  test("decodeAbsoluteImage reads back the values the absolute build wrote (round-trip, MV-0705 read-back)", () => {
    // Build the absolute image the same way the flash/read-back path does, then decode it.
    // Every integer/enum value the build placed must decode back identically, i.e.
    // decodeAbsoluteImage is the inverse of the encode used by buildAbsoluteSegmentTargets.
    const instances = app.hasModules ? resolveModuleInstances(app, new Map()) : [];
    const m = toAppModel(app, { includeUnions: true, instances });
    const targets = buildAbsoluteSegmentTargets(app, new Map(), { moduleInstances: instances });
    const active = buildDeviceConfig(app, new Map(), undefined, instances).imageValues;
    const seg = targets.find((t) => t.size > 0)!;
    const decoded = decodeAbsoluteImage(m, seg.id, seg.bytes);
    // Expected counts, derived from the fixture XML (not from running this loop):
    // AS-4200 is targeted by exactly 48 <Parameter><Memory CodeSegment=...AS-4200>
    // entries (grep count), all typed 8-bit Value/Number (integer-decodable, so none
    // are skipped by the codec), and exactly 611 <ParameterRef> elements point at
    // those 48 parameters (grep count) -> decoded carries one entry per such ref.
    expect(decoded.size).toBe(611);
    let checked = 0;
    for (const [ref, v] of decoded) {
      const a = active.get(ref);
      if (a !== undefined && /^-?\d+$/.test(a)) { expect(v).toBe(a); checked++; }
    }
    // `active` (imageValues) is the default-config walk of the fixture's <Dynamic>:
    // each ParameterBlock's unconditional ParameterRefRefs plus the branches of
    // chooses whose gate's catalogue default matches a <when> test. Re-deriving that
    // walk independently from the XML (defaults from Parameter/@Value overridden by
    // ParameterRef/@Value; 7 of the 17 reachable chooses take a branch) reaches 33
    // refs, of which exactly these 18 resolve to AS-4200 parameters, all with
    // integer defaults: R-3, R-4, R-6, R-7, R-9, R-10, R-11, R-12, R-15, R-21,
    // R-36, R-38, R-39, R-42, R-45, R-48, R-50, R-106. So the decode/active
    // cross-check above must fire for exactly those 18, no fewer (a visibility or
    // codec regression that silently shrinks the overlap must fail here).
    expect(checked).toBe(18);
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
});

// Access="None" internal parameters are hidden from the UI but ETS still writes them
// to the memory image; their value comes from whichever ParameterRef the active
// dynamic branch references. buildDeviceConfig exposes these via imageValues (not via
// the visible blocks), which is what unlocked the complex M-0008 device. This pins
// that mechanism on a minimal app.
const internalXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0002"><ApplicationPrograms>
<ApplicationProgram Id="M-0002_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Internal Test">
<Static>
<ParameterTypes><ParameterType Id="M-0002_A-0001-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0002_A-0001-01-0001_P-1" ParameterType="M-0002_A-0001-01-0001_PT-8" Text="Visible" Value="0"><Memory CodeSegment="M-0002_A-0001-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0002_A-0001-01-0001_P-2" ParameterType="M-0002_A-0001-01-0001_PT-8" Access="None" Text="Internal" Value="255"><Memory CodeSegment="M-0002_A-0001-01-0001_AS-1" Offset="1" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0002_A-0001-01-0001_P-1_R-1" RefId="M-0002_A-0001-01-0001_P-1"/>
<ParameterRef Id="M-0002_A-0001-01-0001_P-2_R-a" RefId="M-0002_A-0001-01-0001_P-2"/>
<ParameterRef Id="M-0002_A-0001-01-0001_P-2_R-b" RefId="M-0002_A-0001-01-0001_P-2" Value="85"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0002_A-0001-01-0001_AS-1" Address="100" Size="2"><Data>AAA=</Data></AbsoluteSegment></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0002_A-0001-01-0001_PB-1" Name="Main" Text="Main">
<ParameterRefRef RefId="M-0002_A-0001-01-0001_P-1_R-1"/>
<ParameterRefRef RefId="M-0002_A-0001-01-0001_P-2_R-b"/>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("Access=None internal params reach imageValues (via the active ref) but not the UI", () => {
  const app = parseAppConfig(internalXml);
  const view = buildDeviceConfig(app, new Map());
  // The internal param is NOT shown as a UI parameter row...
  const shownRefs = view.blocks.flatMap((b) => b.items).filter((i) => i.kind === "param").map((i: any) => i.param.refId);
  expect(shownRefs).not.toContain("M-0002_A-0001-01-0001_P-2_R-b");
  // ...but its active ref's Value IS in imageValues for the memory image.
  expect(view.imageValues.get("M-0002_A-0001-01-0001_P-2_R-b")).toBe("85");
});

test("the build writes the Access=None internal param's value into the segment", () => {
  const app = parseAppConfig(internalXml);
  const img = buildAbsoluteSegmentImages(app, new Map())[0].bytes;
  expect(img.length).toBe(2);
  expect(img[0]).toBe(0); // visible param, default 0
  expect(img[1]).toBe(85); // internal param, value 85 from its active ref (not its 255 default)
});

test("an Access=None internal byte is OWNED (written) but excluded from verify", () => {
  // The download-marker class (M-008E AS-4B00[0:2], MV-0701 P-2228): we write it as part of
  // the correct image, but the device re-stamps it on download, so it must not be checked by
  // the post-flash read-back verify or every successful flash would report as failed.
  const t = buildAbsoluteSegmentTargets(parseAppConfig(internalXml), new Map())[0];
  expect(!!t.owned[1]).toBe(true);   // Access=None internal: still written
  expect(!!t.verify[1]).toBe(false); // ...but not asserted against the device read-back
});

// Regression: the image-value pass must resolve choose/Assign in its OWN document
// order, not against the UI walk's already-fully-mutated env. Here a <choose> on
// `ctrl` precedes an <Assign ctrl=1>: in document order the choose sees ctrl=0 and
// selects branch A. A shared post-walk env (ctrl already 1) would wrongly select B.
const assignOrderXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0003"><ApplicationPrograms>
<ApplicationProgram Id="M-0003_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Assign Order">
<Static>
<ParameterTypes><ParameterType Id="M-0003_A-0001-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0003_A-0001-01-0001_P-ctrl" ParameterType="M-0003_A-0001-01-0001_PT-8" Text="ctrl" Value="0"><Memory CodeSegment="M-0003_A-0001-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0003_A-0001-01-0001_P-A" ParameterType="M-0003_A-0001-01-0001_PT-8" Text="A" Value="0"><Memory CodeSegment="M-0003_A-0001-01-0001_AS-1" Offset="1" BitOffset="0"/></Parameter>
<Parameter Id="M-0003_A-0001-01-0001_P-B" ParameterType="M-0003_A-0001-01-0001_PT-8" Text="B" Value="0"><Memory CodeSegment="M-0003_A-0001-01-0001_AS-1" Offset="2" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0003_A-0001-01-0001_P-ctrl_R" RefId="M-0003_A-0001-01-0001_P-ctrl"/>
<ParameterRef Id="M-0003_A-0001-01-0001_P-A_R" RefId="M-0003_A-0001-01-0001_P-A" Value="10"/>
<ParameterRef Id="M-0003_A-0001-01-0001_P-B_R" RefId="M-0003_A-0001-01-0001_P-B" Value="20"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0003_A-0001-01-0001_AS-1" Address="100" Size="3"><Data>AAAA</Data></AbsoluteSegment></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0003_A-0001-01-0001_PB-1" Name="Main" Text="Main">
<choose ParamRefId="M-0003_A-0001-01-0001_P-ctrl_R">
<when test="0"><ParameterRefRef RefId="M-0003_A-0001-01-0001_P-A_R"/></when>
<when default="true"><ParameterRefRef RefId="M-0003_A-0001-01-0001_P-B_R"/></when>
</choose>
<Assign TargetParamRefRef="M-0003_A-0001-01-0001_P-ctrl_R" Value="1"/>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("imageValues resolves choose/Assign in document order, independent of the UI env", () => {
  const view = buildDeviceConfig(parseAppConfig(assignOrderXml), new Map());
  // Document order: ctrl=0 at the choose -> branch A is active -> A's ref value present, B's absent.
  expect(view.imageValues.get("M-0003_A-0001-01-0001_P-A_R")).toBe("10");
  expect(view.imageValues.has("M-0003_A-0001-01-0001_P-B_R")).toBe(false);
});

// Some devices (e.g. Steinel M-008E) declare AbsoluteSegments WITHOUT a <Data>
// default. Such a segment has no precomputed default image: ETS clears the parameter
// memory before download, so a PARAMETER-owned byte starts at 0x00 (a disabled
// feature's params read back as 0) while the GAPS between parameters stay at the
// erased 0xFF. Active parameter values overlay that. Hardware-verified on M-008E (a
// 1024-byte Data-less segment went from 339 byte diffs to 4 with this model). Here
// P-1 is active (offset 0), P-2 is present in memory but not referenced in the active
// tree (offset 1), and offsets 2-3 are gaps owned by no parameter.
const noDataXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0004"><ApplicationPrograms>
<ApplicationProgram Id="M-0004_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="No Data">
<Static>
<ParameterTypes><ParameterType Id="M-0004_A-0001-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0004_A-0001-01-0001_P-1" ParameterType="M-0004_A-0001-01-0001_PT-8" Text="V" Value="0"><Memory CodeSegment="M-0004_A-0001-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0004_A-0001-01-0001_P-2" ParameterType="M-0004_A-0001-01-0001_PT-8" Text="Inactive" Value="9"><Memory CodeSegment="M-0004_A-0001-01-0001_AS-1" Offset="1" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0004_A-0001-01-0001_P-1_R" RefId="M-0004_A-0001-01-0001_P-1" Value="5"/>
<ParameterRef Id="M-0004_A-0001-01-0001_P-2_R" RefId="M-0004_A-0001-01-0001_P-2"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0004_A-0001-01-0001_AS-1" Address="100" Size="4" MemoryType="EEPROM"/></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0004_A-0001-01-0001_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="M-0004_A-0001-01-0001_P-1_R"/></ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("a Data-less segment: param bytes default to 0, gaps stay 0xFF, active overlays", () => {
  const app = parseAppConfig(noDataXml);
  const seg = app.absoluteSegments.find((s) => s.id.endsWith("AS-1"));
  expect(seg!.data.length).toBe(0); // no <Data>
  const img = buildAbsoluteSegmentImages(app, new Map())[0].bytes;
  expect(img.length).toBe(4);
  expect(img[0]).toBe(5); // P-1 active -> its value
  expect(img[1]).toBe(0); // P-2 owns this byte but is not active -> cleared to 0, NOT its 9 default and NOT 0xFF
  expect(img[2]).toBe(0xff); // gap (no parameter) -> erased EEPROM state
  expect(img[3]).toBe(0xff);
});

// RelativeSegment (System B) surgical target ownership. The relative path writes EVERY
// non-union default (hardware: the PSU M-0162 full-image byte-match needs them), so a
// visible param is owned even when inactive. But an Access="None" inactive param is NOT
// owned (its on-device value is ETS-computed, e.g. the Theben "Objektlink" union tables;
// our static default would corrupt it), and a union member is owned only when active.
const relXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="M-0005_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Relative Owned">
<Static>
<ParameterTypes><ParameterType Id="M-0005_A-0001-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0005_A-0001-01-0001_P-1" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="Visible active" Value="1"><Memory CodeSegment="M-0005_A-0001-01-0001_RS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0005_A-0001-01-0001_P-2" ParameterType="M-0005_A-0001-01-0001_PT-8" Access="None" Text="Internal inactive" Value="9"><Memory CodeSegment="M-0005_A-0001-01-0001_RS-1" Offset="1" BitOffset="0"/></Parameter>
<Parameter Id="M-0005_A-0001-01-0001_P-3" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="Visible inactive" Value="3"><Memory CodeSegment="M-0005_A-0001-01-0001_RS-1" Offset="2" BitOffset="0"/></Parameter>
<Union SizeInBit="8"><Memory CodeSegment="M-0005_A-0001-01-0001_RS-1" Offset="3" BitOffset="0"/>
<Parameter Id="M-0005_A-0001-01-0001_P-A" ParameterType="M-0005_A-0001-01-0001_PT-8" Access="None" Text="Union A" Value="0" Offset="0" BitOffset="0"/>
<Parameter Id="M-0005_A-0001-01-0001_P-B" ParameterType="M-0005_A-0001-01-0001_PT-8" Access="None" Text="Union B" Value="0" Offset="0" BitOffset="0"/></Union>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0005_A-0001-01-0001_P-1_R" RefId="M-0005_A-0001-01-0001_P-1" Value="7"/>
<ParameterRef Id="M-0005_A-0001-01-0001_P-2_R" RefId="M-0005_A-0001-01-0001_P-2"/>
<ParameterRef Id="M-0005_A-0001-01-0001_P-3_R" RefId="M-0005_A-0001-01-0001_P-3"/>
<ParameterRef Id="M-0005_A-0001-01-0001_P-A_R" RefId="M-0005_A-0001-01-0001_P-A" Value="5"/>
<ParameterRef Id="M-0005_A-0001-01-0001_P-B_R" RefId="M-0005_A-0001-01-0001_P-B" Value="6"/></ParameterRefs>
<Code><RelativeSegment Id="M-0005_A-0001-01-0001_RS-1" LoadStateMachine="4" Size="5"><Data>AAAAAAA=</Data></RelativeSegment></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0005_A-0001-01-0001_PB-1" Name="Main" Text="Main">
<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-1_R"/>
<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-A_R"/>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("relative target: visible owned (active+inactive), Access=None-inactive preserved, union active-only", () => {
  const app = parseAppConfig(relXml);
  const t = buildRelativeSegmentTarget(app, new Map(), 4)!;
  expect(t.size).toBe(5);
  // P-1 visible + active: owned, value from its active ref (7), not the 1 default.
  expect(!!t.owned[0]).toBe(true);
  expect(t.bytes[0]).toBe(7);
  // P-2 Access=None and inactive: NOT owned -> the byte is left at the <Data> default,
  // and the flash will preserve whatever the device computed there.
  expect(!!t.owned[1]).toBe(false);
  // P-3 visible but inactive: still owned at its default (System B writes every default).
  expect(!!t.owned[2]).toBe(true);
  expect(t.bytes[2]).toBe(3);
  // Union: only the active member (P-A=5) is owned; the overlapping inactive P-B is not.
  expect(!!t.owned[3]).toBe(true);
  expect(t.bytes[3]).toBe(5);
  // Trailing gap owned by no parameter.
  expect(!!t.owned[4]).toBe(false);
  // verify mask: user-facing bytes are checked post-flash; device-internal Access=None bytes
  // are owned (written) but EXCLUDED from verify. P-A (offset 3) is an ACTIVE union member but
  // Access=None, so it is written yet not verified, exactly like the M-008E download marker.
  expect(!!t.verify[0]).toBe(true);  // P-1 user-facing: verified
  expect(!!t.verify[2]).toBe(true);  // P-3 user-facing default: verified
  expect(!!t.verify[3]).toBe(false); // active Access=None union member: owned/written, not verified
});

// The flash merge writes only owned bytes over the live device read and preserves the
// rest; diffBytes counts only the owned bytes that actually change.
const relTarget = (owned: (boolean | number)[], bytes: number[], verify: (boolean | number)[] = owned): RelativeSegmentTarget => {
  const bits = (m: (boolean | number)[]) => m.map((o) => (o === true ? 0xff : o === false ? 0 : o));
  return { lsm: 4, size: owned.length, bytes: Buffer.from(bytes), owned: bits(owned), verify: bits(verify) };
};

test("mergeRelativeTarget overlays owned bytes, preserves unowned, counts owned changes", () => {
  const current = Buffer.from([10, 20, 30, 40]);
  // own bytes 0 and 2; byte 0 changes (10->7), byte 2 unchanged (30->30), bytes 1/3 unowned.
  const target = relTarget([true, false, true, false], [7, 99, 30, 99]);
  const { image, diffBytes } = mergeRelativeTarget(current, target);
  expect([...image]).toEqual([7, 20, 30, 40]); // owned 0 written, unowned 1/3 preserved, owned-but-equal 2 kept
  expect(diffBytes).toBe(1); // only byte 0 actually changed
});

test("mergeRelativeTarget on an unchanged config is a no-op (diffBytes 0)", () => {
  const current = Buffer.from([5, 6, 7]);
  const target = relTarget([true, false, true], [5, 0, 7]); // owned values already match the device
  const { diffBytes } = mergeRelativeTarget(current, target);
  expect(diffBytes).toBe(0);
});

test("a byte shared with bits no parameter owns takes only the owned bits; the rest stay as the device holds them", () => {
  const current = Buffer.from([0b00000000, 0xa5]);
  const target = relTarget([0b11000000, 0], [0b01111111, 0]); // a 2-bit field at bit offset 0 set to 01; template 1s beside it
  const { image, diffBytes } = mergeRelativeTarget(current, target);
  expect([...image]).toEqual([0b01000000, 0xa5]);
  expect(diffBytes).toBe(1);
  expect(verifyRelativeOwned(Buffer.from([0b01000000, 0]), target)).toBe(true);
  expect(verifyRelativeOwned(Buffer.from([0b01111111, 0]), target)).toBe(true); // unowned bits are not asserted
  expect(verifyRelativeOwned(Buffer.from([0b10000000, 0]), target)).toBe(false);
});

test("verifyRelativeOwned checks only owned bytes; unowned drift does not fail it", () => {
  const target = relTarget([true, false, true], [7, 0, 9]);
  // back: owned bytes match (7, 9); unowned byte 1 differs (device recomputed it) -> still OK.
  expect(verifyRelativeOwned(Buffer.from([7, 123, 9]), target)).toBe(true);
  // an owned byte differs -> fails.
  expect(verifyRelativeOwned(Buffer.from([7, 0, 8]), target)).toBe(false);
});

// A channel configured as a module replaces a top-level channel variant whose parameter
// memory the module instance now occupies. Those displaced top-level params are inactive,
// and writing their static default would corrupt the channel the module placed there. The
// surgical target must NOT own them. Real Theben HMG 6T fixture (hardware-mapped: offsets
// 617/1129 on the unit were exactly this, the inactive "Zeit fuer zykl. Senden" param inside
// the JME channel-module region; owning its default 2 was the spurious 2-byte "drift").
const APP = "M-0048_A-493B-21-B471";

corpusTest("a top-level param displaced by an active module instance is not owned", () => {
  const app = parseAppConfig(readRealFixture(`${APP}.xml.gz`));
  // HMG 6 T: P-57 = 6 instantiates six MD-7 channel modules over the parameter memory.
  const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
  const instances = resolveModuleInstances(app, env);
  const target = buildRelativeSegmentTarget(app, env, 4, { moduleInstances: instances })!;
  // MD-7_M-19_MI-1 occupies bytes 74..105. The top-level relay param at offset 105
  // ("Schaltverzoegerung der Relais") sits inside that channel region but belongs to the
  // relay variant, inactive here; its memory is the module's, so it must stay UNOWNED.
  expect(!!target.owned[105]).toBe(false);
  // Sanity: an ACTIVE module-instance param's own byte (channel 1 P-1 at offset 74) IS owned.
  const model = toAppModel(app, { includeUnions: true, instances });
  const ch1 = model.params.get(model.refs.get(`${APP}_MD-7_M-19_MI-1_P-1_R-1`)!.paramId)!;
  expect(!!target.owned[ch1.offset!]).toBe(true);
});

// DPT-9 (2-byte KNX float) parameters whose STORED value is not byte-canonical. Two
// distinct cases, both absent from the real-fixture corpus (see the round-trip test in
// real-catalogue.test.ts, which points here):
//  - a stored DEFAULT the codec must round: "21.001" is below DPT-9's resolution at
//    that magnitude, so encode writes the rounded value's bytes and decode returns the
//    rounded value, not the stored string;
//  - a manufacturer <Data> pattern that is a valid but NON-canonical encoding (same
//    value, non-minimal exponent): decode -> re-encode normalizes it, flipping bytes.
// P-F (active, default "21.001") sits at offset 0; P-G (has a ref but is never
// referenced in <Dynamic>, i.e. inactive) sits at offset 2 over the <Data> bytes
// DE AD (segment <Data> base64 "AADerQ==" = 00 00 DE AD).
const floatXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0006"><ApplicationPrograms>
<ApplicationProgram Id="M-0006_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Float Default">
<Static>
<ParameterTypes><ParameterType Id="M-0006_A-0001-01-0001_PT-F"><TypeFloat SizeInBit="16"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0006_A-0001-01-0001_P-F" ParameterType="M-0006_A-0001-01-0001_PT-F" Text="Setpoint" Value="21.001"><Memory CodeSegment="M-0006_A-0001-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0006_A-0001-01-0001_P-G" ParameterType="M-0006_A-0001-01-0001_PT-F" Text="Hidden" Value="1"><Memory CodeSegment="M-0006_A-0001-01-0001_AS-1" Offset="2" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0006_A-0001-01-0001_P-F_R" RefId="M-0006_A-0001-01-0001_P-F"/>
<ParameterRef Id="M-0006_A-0001-01-0001_P-G_R" RefId="M-0006_A-0001-01-0001_P-G"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0006_A-0001-01-0001_AS-1" Address="100" Size="4"><Data>AADerQ==</Data></AbsoluteSegment></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0006_A-0001-01-0001_PB-1" Name="Main" Text="Main">
<ParameterRefRef RefId="M-0006_A-0001-01-0001_P-F_R"/>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("a DPT-9 float default the codec must round: encode writes the rounded bytes, decode returns the rounded value, owned iff written", () => {
  // Hand-derived bytes for "21.001" per encodeDpt9 (image.ts): mant = round(21.001*100)
  // = 2100; 2100 > 2047, so mant = round(2100/2) = 1050, exp = 1; raw = (1<<11) | 1050
  // = 0x0C1A. That equals the canonical encoding of 21.0 (image.ts reference vector),
  // i.e. the ".001" is below DPT-9 resolution here and is rounded away at encode time.
  const app = parseAppConfig(floatXml);
  const t = buildAbsoluteSegmentTargets(app, new Map())[0];
  expect([...t.bytes]).toEqual([0x0c, 0x1a, 0xde, 0xad]); // P-F encoded, P-G's <Data> untouched
  // Ownership follows the write: the active float's two bytes are owned and (being
  // user-facing) verified; the inactive P-G wrote nothing, so it owns nothing.
  expect(t.owned.map(Boolean)).toEqual([true, true, false, false]);
  expect(t.verify.map(Boolean)).toEqual([true, true, false, false]);
  // decode returns the ROUNDED value, not the stored default string. decodeDpt9(0x0C1A):
  // mant = 0x41A = 1050, exp = 1 -> 1050*2/100 = 21. This is the defined round-trip:
  // a re-flash from the decoded value reproduces the same bytes (asserted below).
  const m = toAppModel(app, { includeUnions: true, instances: [] });
  const decoded = decodeAbsoluteImage(m, t.id, t.bytes);
  expect(decoded.get("M-0006_A-0001-01-0001_P-F_R")).toBe("21");
  const copy = Buffer.from(t.bytes);
  const type = m.types.get(m.params.get("M-0006_A-0001-01-0001_P-F")!.typeId)!;
  expect(encode(copy, 0, 0, type, "21")).toBe(true);
  expect(copy.equals(t.bytes)).toBe(true); // 0x0C1A is canonical: re-encode is a no-op
});

test("a non-canonical DPT-9 <Data> pattern decodes to its value but re-encodes to the canonical bytes", () => {
  // The inactive P-G keeps the manufacturer bytes DE AD. Hand-derived decode
  // (decodeDpt9): sign set, exp = (0xDEAD>>11)&0xF = 11, mant = 0x6AD = 1709 -> 1709 -
  // 2048 = -339; value = -339 * 2^11 / 100 = -6942.72. Re-encoding that value
  // (encodeDpt9): mant = -694272, halved 9 times (each step even, so no rounding loss)
  // -> mant = -1356, exp = 9; raw = 0x8000 | (9<<11) | (-1356 & 0x7FF = 0x2B4) =
  // 0xCAB4. Same value, minimal exponent: the encoder normalizes, so decode->encode is
  // NOT byte-identity on a non-canonical stored pattern. This is exactly why the
  // real-catalogue round-trip test may assume clean inverses only because no corpus
  // fixture places a float over such a pattern; the behavior itself is pinned here.
  const app = parseAppConfig(floatXml);
  const t = buildAbsoluteSegmentTargets(app, new Map())[0];
  const m = toAppModel(app, { includeUnions: true, instances: [] });
  const decoded = decodeAbsoluteImage(m, t.id, t.bytes);
  expect(decoded.get("M-0006_A-0001-01-0001_P-G_R")).toBe("-6942.72");
  const copy = Buffer.from(t.bytes);
  const type = m.types.get(m.params.get("M-0006_A-0001-01-0001_P-G")!.typeId)!;
  expect(encode(copy, 2, 0, type, "-6942.72")).toBe(true);
  expect([...copy.subarray(2)]).toEqual([0xca, 0xb4]); // normalized, no longer DE AD
});

corpusTest("a >48-bit ETS-computed 'Objektlink' union member is never owned (and does not crash the build)", () => {
  const app = parseAppConfig(readRealFixture(`${APP}.xml.gz`));
  // The 928-bit "Objektlink" union sits at offset 842 (CodeSegment RS-04). Since ETS
  // evaluates every matching <when>, an active branch can reach one of its members; the
  // integer codec cannot represent >48 bits, so the build must skip it (preserve the bytes)
  // rather than throw. Build a configured device and confirm both: no throw, byte unowned.
  const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
  const instances = resolveModuleInstances(app, env);
  const target = buildRelativeSegmentTarget(app, env, 4, { moduleInstances: instances })!;
  expect(!!target.owned[842]).toBe(false); // computed link table: preserved, not authored
});

// A field that is not byte-aligned spans more bytes than its width alone suggests: 12 bits at
// BitOffset 6 touches THREE bytes (2 bits + 8 + 2). The ownership mask must claim all of them,
// or the flash writes only part of the field and sources the rest from the live device read: the
// device keeps its old bits while the verify, which checks owned bytes only, reports success.
// That is the fake-green this codebase refuses, so pin the span here. The byte-match corpus
// cannot pin it (none of its 110 non-aligned params is ever actually written, see
// docs/device-memory-model.md), and neither can a width that ignores the bit offset: only a span
// computed as ceil((BitOffset + SizeInBit) / 8) gets this right.
const nonAlignedXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0002"><ApplicationPrograms>
<ApplicationProgram Id="M-0002_A-0002-01-0001" ApplicationNumber="2" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Non-aligned">
<Static>
<ParameterTypes><ParameterType Id="M-0002_A-0002-01-0001_PT-12"><TypeNumber SizeInBit="12" Type="unsignedInt" minInclusive="0" maxInclusive="4000"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0002_A-0002-01-0001_P-1" ParameterType="M-0002_A-0002-01-0001_PT-12" Text="Delay" Value="0"><Memory CodeSegment="M-0002_A-0002-01-0001_RS-04-00000" Offset="1" BitOffset="6"/></Parameter>
</Parameters>
<ParameterRefs><ParameterRef Id="M-0002_A-0002-01-0001_P-1_R-1" RefId="M-0002_A-0002-01-0001_P-1"/></ParameterRefs>
<Code><RelativeSegment Id="M-0002_A-0002-01-0001_RS-04-00000" Offset="0" Size="8" LoadStateMachine="4"/></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0002_A-0002-01-0001_PB-1" Name="Main" Text="Main">
<ParameterRefRef RefId="M-0002_A-0002-01-0001_P-1_R-1"/>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("a non-byte-aligned wide field owns EVERY byte it spans (not just the first)", () => {
  const nonAlignedApp = parseAppConfig(nonAlignedXml);
  const ref = "M-0002_A-0002-01-0001_P-1_R-1";
  const target = buildRelativeSegmentTarget(nonAlignedApp, new Map([[ref, "3000"]]), 4)!;

  // 12 bits at BitOffset 6 of the byte at offset 1 -> bytes 1, 2 AND 3.
  expect(target.owned.slice(1, 4).map(Boolean)).toEqual([true, true, true]);
  expect(target.verify.slice(1, 4).map(Boolean)).toEqual([true, true, true]);
  expect(!!target.owned[0]).toBe(false); // and nothing outside the field
  expect(!!target.owned[4]).toBe(false);

  // The verify must therefore catch a device that kept the field's last byte: a flash whose
  // ownership stopped short would call such a device correct.
  const deviceKeptLastByte = Buffer.from(target.bytes);
  deviceKeptLastByte[3] ^= 0xc0; // the 2 bits of the field that live in byte 3
  expect(verifyRelativeOwned(deviceKeptLastByte, target)).toBe(false);
});

corpusTest("a LegacyPatchAlways parameter is written with its value, and a user's edit reaches the image", () => {
  // MDT BE-02001.02 P-7 "Debounce time" (visible, editable) carries LegacyPatchAlways; its <Data>
  // byte is 0x32, and two ETS captures (captures/ in the private corpus) write the parameter's value 0x1e over it.
  const mdt = parseAppConfig(readRealFixture("M-0083_A-00B6-32-9642.xml.gz"));
  const ref = [...mdt.refs.values()].find((r) => r.id.endsWith("_P-7_R-6"))!;
  expect(mdt.params.get(ref.paramId)?.patchAlways).toBe(true);
  const seg = (values: Map<string, string>) => {
    const instances = mdt.hasModules ? resolveModuleInstances(mdt, values) : [];
    return buildAbsoluteSegmentTargets(mdt, values, { moduleInstances: instances }).find((t) => t.id.endsWith("AS-4468"))!;
  };
  const defaults = seg(new Map());
  expect(defaults.bytes[3]).toBe(0x1e);
  expect(!!defaults.owned[3]).toBe(true);
  expect(seg(new Map([[ref.id, "100"]])).bytes[3]).toBe(100);
});

// buildRelativeSegmentTarget is the System B image both the full download and the surgical parameter
// flash write, and golden.json (buildParameterImage) does not cover it. Fingerprints of bytes/owned/
// owned-count at application defaults. The full download owns the default member of every idle
// union (GVS capture); the surgical flash does not, so it keeps a device's own bytes there.
corpusTest("the relative images of the full download and the parameter flash stay pinned", () => {
  const h = (b: Buffer | boolean[]) => createHash("sha256").update(Buffer.isBuffer(b) ? b : Buffer.from(b.map((x) => (x ? 1 : 0)))).digest("hex").slice(0, 16);
  const pinned: [string, string, string][] = [
    ["M-0004_A-7072-21-99A7-O000A.xml.gz", "ac1f3be247fc3306/55d68d3167e051f6/186", "ac1f3be247fc3306/55d68d3167e051f6/186"],
    ["M-0048_A-493B-21-B471.xml.gz", "6ba718daaf224267/d6ff5b529294fa99/28", "6ba718daaf224267/d6ff5b529294fa99/28"],
    ["M-0048_A-9071-20-F258-O00EF.xml.gz", "46cbaee9e105624c/92067062ffcf6d7e/2993", "46cbaee9e105624c/92067062ffcf6d7e/2993"],
    ["M-0083_A-0137-20-7EB2.xml.gz", "1e314970f1fcd316/ec139466568e418e/249", "1e314970f1fcd316/ec139466568e418e/249"],
    ["M-0085_A-0072-30-69AA.xml.gz", "92c7b74b07859d64/50280f1974b73b94/229", "0637574cc5dee1f2/89a5a7b7cbcadf73/158"],
    ["M-0162_A-0004-11-F245.xml.gz", "193046a5b142618e/1ac1e7503513d72a/163", "193046a5b142618e/1ac1e7503513d72a/163"],
  ];
  for (const [f, full, surgical] of pinned) {
    const app = parseAppConfig(readRealFixture(f));
    const inst = app.hasModules ? resolveModuleInstances(app, new Map()) : [];
    const r = (own: boolean) => { const t = buildRelativeSegmentTarget(app, new Map(), 4, { moduleInstances: inst, ownIdleUnionDefaults: own })!; return `${h(t.bytes)}/${h(t.owned.map(Boolean))}/${t.owned.filter(Boolean).length}`; };
    expect([f, r(true), r(false)]).toEqual([f, full, surgical]);
  }
});

// GVS AMMA byte 64: "Output 3&4 function" (2 bits at bit offset 0) shares the byte with that
// channel's unions. With the channel disabled the unions are idle: the parameter flash owns only
// the parameter's two bits, the full download owns the whole byte (it writes the union defaults,
// as ETS does). Writing the template's bits beside the parameter set idle union bits that the
// device's firmware then acted on.
corpusTest("a sub-byte parameter owns only its own bits of the byte it shares", () => {
  const app = parseAppConfig(readRealFixture("M-0085_A-0072-30-69AA.xml.gz"));
  const values = new Map([["M-0085_A-0072-30-69AA_P-20_R-20", "1"], ["M-0085_A-0072-30-69AA_UP-142_R-142", "1"]]);
  expect(buildRelativeSegmentTarget(app, values, 4)!.owned[64]).toBe(0xc0);
  expect(buildRelativeSegmentTarget(app, values, 4, { ownIdleUnionDefaults: true })!.owned[64]).toBe(0xff);
  const merged = mergeRelativeTarget(Buffer.alloc(buildRelativeSegmentTarget(app, values, 4)!.size), buildRelativeSegmentTarget(app, values, 4)!).image;
  expect(merged[64]).toBe(0x00); // the device's zeros beside P-9 survive, not the template's 0x3f
});
