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
