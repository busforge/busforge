import { test, expect } from "bun:test";
import { parseAppConfig } from "../src/index.ts";
import { planAbsoluteSegmentFlash } from "../src/deviceflash.ts";
import { buildAbsoluteSegmentImages } from "../src/deviceimage.ts";
import { readRealFixture } from "./real-catalogue.snapshot.ts";

// A minimal Data-less MV-0705 app: P-1 and P-3 are active (offsets 0 and 2), P-2 is a
// parameter that owns offset 1 but is NOT referenced in the active tree, offset 3 is a
// gap owned by no parameter. The flash plan must write ONLY the active-parameter bytes
// (offsets 0 and 2): the inactive parameter and the gap are never touched, which is
// exactly how the surgical model avoids clobbering values it cannot reconstruct.
const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="M-0005_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Flash Plan">
<Static>
<ParameterTypes><ParameterType Id="M-0005_A-0001-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0005_A-0001-01-0001_P-1" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="A" Value="0"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0005_A-0001-01-0001_P-2" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="Inactive" Value="9"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="1" BitOffset="0"/></Parameter>
<Parameter Id="M-0005_A-0001-01-0001_P-3" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="C" Value="0"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="2" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0005_A-0001-01-0001_P-1_R" RefId="M-0005_A-0001-01-0001_P-1" Value="5"/>
<ParameterRef Id="M-0005_A-0001-01-0001_P-2_R" RefId="M-0005_A-0001-01-0001_P-2"/>
<ParameterRef Id="M-0005_A-0001-01-0001_P-3_R" RefId="M-0005_A-0001-01-0001_P-3" Value="7"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0005_A-0001-01-0001_AS-1" Address="100" Size="4" MemoryType="EEPROM"/></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0005_A-0001-01-0001_PB-1" Name="Main" Text="Main">
<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-1_R"/>
<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-3_R"/>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const app = parseAppConfig(xml);

test("the plan writes only active-parameter bytes, never the inactive param or the gap", () => {
  const plan = planAbsoluteSegmentFlash(app, new Map());
  expect(plan.segments.length).toBe(1);
  const seg = plan.segments[0];
  expect(seg.address).toBe(100);
  expect(seg.ownedBytes).toBe(2); // P-1 and P-3 only
  expect(seg.writtenBytes).toBe(2); // no `current`: every owned byte is scheduled
  expect(seg.skippedUnowned).toBe(2); // inactive param byte + gap

  // Two non-adjacent owned bytes -> two single-byte runs at the right addresses.
  expect(seg.runs.map((r) => r.address)).toEqual([100, 102]);
  expect([...seg.runs[0].bytes]).toEqual([5]); // P-1 value
  expect([...seg.runs[1].bytes]).toEqual([7]); // P-3 value
  // The inactive parameter's address (101) is never written.
  expect(seg.runs.some((r) => r.address === 101)).toBe(false);
});

// A text parameter is NOT represented in the parameter image (encode writes nothing).
// It must therefore own NO bytes: claiming its bytes would make the planner push the
// segment's init value over device memory the parameter never derived. P-1 is an
// active 32-bit text param at offset 0; P-2 is an active numeric param at offset 4.
const textXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0006"><ApplicationPrograms>
<ApplicationProgram Id="M-0006_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Text Owns Nothing">
<Static>
<ParameterTypes>
<ParameterType Id="M-0006_A-0001-01-0001_PT-T"><TypeText SizeInBit="32"/></ParameterType>
<ParameterType Id="M-0006_A-0001-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType>
</ParameterTypes>
<Parameters>
<Parameter Id="M-0006_A-0001-01-0001_P-1" ParameterType="M-0006_A-0001-01-0001_PT-T" Text="Label" Value="hi"><Memory CodeSegment="M-0006_A-0001-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0006_A-0001-01-0001_P-2" ParameterType="M-0006_A-0001-01-0001_PT-8" Text="N" Value="0"><Memory CodeSegment="M-0006_A-0001-01-0001_AS-1" Offset="4" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0006_A-0001-01-0001_P-1_R" RefId="M-0006_A-0001-01-0001_P-1" Value="hi"/>
<ParameterRef Id="M-0006_A-0001-01-0001_P-2_R" RefId="M-0006_A-0001-01-0001_P-2" Value="3"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0006_A-0001-01-0001_AS-1" Address="100" Size="5" MemoryType="EEPROM"/></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0006_A-0001-01-0001_PB-1" Name="Main" Text="Main">
<ParameterRefRef RefId="M-0006_A-0001-01-0001_P-1_R"/>
<ParameterRefRef RefId="M-0006_A-0001-01-0001_P-2_R"/>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("a text parameter owns no bytes: only the numeric param is scheduled", () => {
  const plan = planAbsoluteSegmentFlash(parseAppConfig(textXml), new Map());
  const seg = plan.segments[0];
  // Offsets 0-3 (the text param) are NOT owned; only offset 4 (the numeric param) is.
  expect(seg.ownedBytes).toBe(1);
  expect(seg.runs.map((r) => r.address)).toEqual([104]);
  expect([...seg.runs[0].bytes]).toEqual([3]);
});

test("with a device read-back, only owned bytes that actually differ are scheduled", () => {
  // Device already holds the correct P-1 value (5) but a stale P-3 value (0).
  const current = new Map([["M-0005_A-0001-01-0001_AS-1", Buffer.from([5, 0xff, 0, 0xff])]]);
  const plan = planAbsoluteSegmentFlash(app, new Map(), { current });
  const seg = plan.segments[0];
  expect(seg.ownedBytes).toBe(2);
  expect(seg.writtenBytes).toBe(1); // only P-3 changed
  expect(seg.runs.map((r) => r.address)).toEqual([102]);
  expect([...seg.runs[0].bytes]).toEqual([7]);
});

test("a device already matching the config yields an empty plan (no writes)", () => {
  const current = new Map([["M-0005_A-0001-01-0001_AS-1", Buffer.from([5, 0xff, 7, 0xff])]]);
  const plan = planAbsoluteSegmentFlash(app, new Map(), { current });
  expect(plan.totalWrittenBytes).toBe(0);
  expect(plan.segments[0].runs).toEqual([]);
});

test("adjacent owned bytes coalesce into a single contiguous run", () => {
  // Override both active params; their bytes are 0 and 2, still non-adjacent here, so
  // assert the coalescing on the real M-0081 device whose visible params are dense.
  const realApp = parseAppConfig(readRealFixture("M-0081_A-FE01-11-75D9.xml.gz"));
  const plan = planAbsoluteSegmentFlash(realApp, new Map());
  // Every run must be internally contiguous and the bytes must match the full image.
  const full = buildAbsoluteSegmentImages(realApp, new Map());
  const byId = new Map(full.map((s) => [s.id, s]));
  for (const seg of plan.segments) {
    const img = byId.get(seg.id)!;
    for (const run of seg.runs) {
      const start = run.address - seg.address;
      expect([...run.bytes]).toEqual([...img.bytes.subarray(start, start + run.bytes.length)]);
    }
    // Runs are sorted and non-overlapping.
    for (let i = 1; i < seg.runs.length; i++) {
      const prev = seg.runs[i - 1];
      expect(seg.runs[i].address).toBeGreaterThanOrEqual(prev.address + prev.bytes.length);
    }
  }
});
