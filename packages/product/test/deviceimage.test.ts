import { test, expect } from "bun:test";
import { parseAppConfig, parseApplication, buildDeviceConfig, decodeAbsoluteImage } from "../src/index.ts";
import { buildAbsoluteSegmentImages, buildAbsoluteSegmentTargets, buildRelativeSegmentTarget, mergeRelativeTarget, verifyRelativeOwned } from "../src/deviceimage.ts";
import type { RelativeSegmentTarget } from "../src/deviceimage.ts";
import { toAppModel, resolveModuleInstances } from "../src/index.ts";
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
  expect(decoded.size).toBeGreaterThan(0);
  let checked = 0;
  for (const [ref, v] of decoded) {
    const a = active.get(ref);
    if (a !== undefined && /^-?\d+$/.test(a)) { expect(v).toBe(a); checked++; }
  }
  expect(checked).toBeGreaterThan(0);
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
  expect(t.owned[0]).toBe(true);
  expect(t.bytes[0]).toBe(7);
  // P-2 Access=None and inactive: NOT owned -> the byte is left at the <Data> default,
  // and the flash will preserve whatever the device computed there.
  expect(t.owned[1]).toBe(false);
  // P-3 visible but inactive: still owned at its default (System B writes every default).
  expect(t.owned[2]).toBe(true);
  expect(t.bytes[2]).toBe(3);
  // Union: only the active member (P-A=5) is owned; the overlapping inactive P-B is not.
  expect(t.owned[3]).toBe(true);
  expect(t.bytes[3]).toBe(5);
  // Trailing gap owned by no parameter.
  expect(t.owned[4]).toBe(false);
});

// The flash merge writes only owned bytes over the live device read and preserves the
// rest; diffBytes counts only the owned bytes that actually change.
const relTarget = (owned: boolean[], bytes: number[]): RelativeSegmentTarget =>
  ({ lsm: 4, size: owned.length, bytes: Buffer.from(bytes), owned });

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

test("a top-level param displaced by an active module instance is not owned", () => {
  const app = parseAppConfig(readRealFixture(`${APP}.xml.gz`));
  // HMG 6 T: P-57 = 6 instantiates six MD-7 channel modules over the parameter memory.
  const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
  const instances = resolveModuleInstances(app, env);
  const target = buildRelativeSegmentTarget(app, env, 4, { moduleInstances: instances })!;
  // MD-7_M-19_MI-1 occupies bytes 74..105. The top-level relay param at offset 105
  // ("Schaltverzoegerung der Relais") sits inside that channel region but belongs to the
  // relay variant, inactive here; its memory is the module's, so it must stay UNOWNED.
  expect(target.owned[105]).toBe(false);
  // Sanity: an ACTIVE module-instance param's own byte (channel 1 P-1 at offset 74) IS owned.
  const model = toAppModel(app, { includeUnions: true, instances });
  const ch1 = model.params.get(model.refs.get(`${APP}_MD-7_M-19_MI-1_P-1_R-1`)!.paramId)!;
  expect(target.owned[ch1.offset!]).toBe(true);
});

test("a >48-bit ETS-computed 'Objektlink' union member is never owned (and does not crash the build)", () => {
  const app = parseAppConfig(readRealFixture(`${APP}.xml.gz`));
  // The 928-bit "Objektlink" union sits at offset 842 (CodeSegment RS-04). Since ETS
  // evaluates every matching <when>, an active branch can reach one of its members; the
  // integer codec cannot represent >48 bits, so the build must skip it (preserve the bytes)
  // rather than throw. Build a configured device and confirm both: no throw, byte unowned.
  const env = new Map([[`${APP}_P-57_R-57`, "6"]]);
  const instances = resolveModuleInstances(app, env);
  const target = buildRelativeSegmentTarget(app, env, 4, { moduleInstances: instances })!;
  expect(target.owned[842]).toBe(false); // computed link table: preserved, not authored
});
