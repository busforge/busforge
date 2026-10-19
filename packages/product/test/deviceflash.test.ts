import { test, expect } from "bun:test";
import { parseAppConfig, buildDeviceConfig } from "../src/index.ts";
import { planAbsoluteSegmentFlash, planAbsoluteFullDownload } from "../src/deviceflash.ts";
import { parseLoadProcedures } from "../src/loadproc.ts";
import { buildAbsoluteSegmentImages, buildAbsoluteSegmentTargets, constantParams } from "../src/deviceimage.ts";
import { readRealFixture } from "./real-catalogue.snapshot.ts";
import { corpusTest } from "../../../tools/corpus-test.ts";

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
<ApplicationProgram Id="M-0006_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Text On An Absolute Segment">
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

// No ETS capture of a System 7 product shows an active text parameter (the Meteodata 140 S's are inactive in every
// captured configuration): an absolute-segment build refuses one; the read-back's build
// leaves it out of the comparison.
test("an active text parameter on an absolute segment is refused; the read-back target leaves it unowned", () => {
  expect(() => planAbsoluteSegmentFlash(parseAppConfig(textXml), new Map())).toThrow(expect.objectContaining({ code: "PARAM_TEXT_UNSUPPORTED" }));
  const [t] = buildAbsoluteSegmentTargets(parseAppConfig(textXml), new Map(), { textRefusals: "skip" });
  expect(t.owned.map((m) => (m ? 1 : 0))).toEqual([0, 0, 0, 0, 1]);
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

// The minimal app with one more Access="None" parameter at offset 3 (value $AA, as the Theben
// TheLuxa P300's download marker P-2228), placed by `placement`, plus `extra` dynamic nodes.
const withNoneXml = (placement: "top" | "choose", extra = "") => xml
  .replace("</Parameters>", '<Parameter Id="M-0005_A-0001-01-0001_P-4" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="Marker" Value="170" Access="None"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="3" BitOffset="0"/></Parameter></Parameters>')
  .replace("</ParameterRefs>", '<ParameterRef Id="M-0005_A-0001-01-0001_P-4_R" RefId="M-0005_A-0001-01-0001_P-4"/></ParameterRefs>')
  .replace('<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-3_R"/>', `<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-3_R"/>${placement === "top"
    ? '<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-4_R"/>'
    : '<choose ParamRefId="M-0005_A-0001-01-0001_P-1_R"><when test="5"><ParameterRefRef RefId="M-0005_A-0001-01-0001_P-4_R"/></when></choose>'}${extra}`);
const withNone = (placement: "top" | "choose", extra = "") => parseAppConfig(withNoneXml(placement, extra));
const SEG = "M-0005_A-0001-01-0001_AS-1";
const plan = (a: ReturnType<typeof parseAppConfig>, unit: number[]) => planAbsoluteSegmentFlash(a, new Map(), { current: new Map([[SEG, Buffer.from(unit)]]) });
const runs = (p: ReturnType<typeof planAbsoluteSegmentFlash>) => p.segments[0].runs.map((r) => [r.address, [...r.bytes]]);

test("a unit that differs only in a constant Access=\"None\" parameter (a download marker it clears) gets an empty plan", () => {
  const p = plan(withNone("top"), [5, 0xff, 7, 0x00]);
  expect([p.totalWrittenBytes, runs(p)]).toEqual([0, []]);
  // Named, so the difference is seen: by its text, else its name, else its id.
  expect(p.constantsDiffer).toEqual([{ paramRefId: "M-0005_A-0001-01-0001_P-4_R", label: "Marker" }]);
  expect(plan(withNone("top"), [5, 0xff, 7, 0xaa]).constantsDiffer).toEqual([]);
  const named = parseAppConfig(withNoneXml("top").replace('Text="Marker" Value="170"', 'Name="A_Download" Text="" Value="170"'));
  expect(plan(named, [5, 0xff, 7, 0x00]).constantsDiffer.map((c) => c.label)).toEqual(["A_Download"]);
  const multiline = parseAppConfig(withNoneXml("top").replace('Text="Marker" Value="170"', 'Text="Wert $AA,&amp;#xD;&amp;#xA;Download" Value="170"'));
  expect(plan(multiline, [5, 0xff, 7, 0x00]).constantsDiffer.map((c) => c.label)).toEqual(["Wert $AA, Download"]);
  // Two active refs of the parameter: named once, by the text its ref gives it.
  const twoRefs = parseAppConfig(withNoneXml("top")
    .replace('<ParameterRef Id="M-0005_A-0001-01-0001_P-4_R" RefId="M-0005_A-0001-01-0001_P-4"/>', '<ParameterRef Id="M-0005_A-0001-01-0001_P-4_R" RefId="M-0005_A-0001-01-0001_P-4" Text="Marker of the ref"/><ParameterRef Id="M-0005_A-0001-01-0001_P-4_R2" RefId="M-0005_A-0001-01-0001_P-4"/>')
    .replace('<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-4_R"/>', '<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-4_R"/><ParameterRefRef RefId="M-0005_A-0001-01-0001_P-4_R2"/>'));
  expect(plan(twoRefs, [5, 0xff, 7, 0x00]).constantsDiffer.map((c) => c.label)).toEqual(["Marker of the ref"]);
});

test("with any other change the constant parameter is written with it, as ETS writes the download marker in every download", () => {
  const p = plan(withNone("top"), [5, 0xff, 0, 0x00]);
  expect(runs(p)).toEqual([[102, [7, 0xaa]]]);
  expect(p.constantsDiffer).toEqual([]);
  expect(p.totalWrittenBytes).toBe(2);
});

test("an Access=\"None\" parameter a configuration can set is a change on its own: one an <Assign> sets, one placed in a choose", () => {
  const assigned = withNone("top", '<choose ParamRefId="M-0005_A-0001-01-0001_P-1_R"><when test="6"><Assign TargetParamRefRef="M-0005_A-0001-01-0001_P-4_R" Value="1"/></when></choose>');
  expect(runs(plan(assigned, [5, 0xff, 7, 0x00]))).toEqual([[103, [0xaa]]]);
  expect(runs(plan(withNone("choose"), [5, 0xff, 7, 0x00]))).toEqual([[103, [0xaa]]]);
});

test("a constant parameter is a change on its own where its value is not the constant, another parameter shares its bits, a calculation reads it, or the dynamic tree is not fully parsed", () => {
  const unit = [5, 0xff, 7, 0x00];
  expect(runs(planAbsoluteSegmentFlash(withNone("top"), new Map([["M-0005_A-0001-01-0001_P-4_R", "171"]]), { current: new Map([[SEG, Buffer.from(unit)]]) }))).toEqual([[103, [0xab]]]);
  const shared = parseAppConfig(xml
    .replace("</Parameters>", '<Parameter Id="M-0005_A-0001-01-0001_P-4" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="Marker" Value="170" Access="None"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="3" BitOffset="0"/></Parameter><Parameter Id="M-0005_A-0001-01-0001_P-5" ParameterType="M-0005_A-0001-01-0001_PT-8" Text="Other" Value="0"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="3" BitOffset="0"/></Parameter></Parameters>')
    .replace("</ParameterRefs>", '<ParameterRef Id="M-0005_A-0001-01-0001_P-4_R" RefId="M-0005_A-0001-01-0001_P-4"/><ParameterRef Id="M-0005_A-0001-01-0001_P-5_R" RefId="M-0005_A-0001-01-0001_P-5"/></ParameterRefs>')
    .replace('<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-3_R"/>', '<ParameterRefRef RefId="M-0005_A-0001-01-0001_P-3_R"/><ParameterRefRef RefId="M-0005_A-0001-01-0001_P-4_R"/>'));
  expect(runs(plan(shared, unit))).toEqual([[103, [0xaa]]]);
  const calculated = parseAppConfig(withNoneXml("top").replace("</Static>", '<ParameterCalculations><ParameterCalculation Id="M-0005_A-0001-01-0001_PC-1" Language="JavaScript" Name="c"><LParameters><ParameterRefRef RefId="M-0005_A-0001-01-0001_P-4_R" AliasName="p1"/></LParameters><RParameters><ParameterRefRef RefId="M-0005_A-0001-01-0001_P-1_R" AliasName="p2"/></RParameters></ParameterCalculation></ParameterCalculations></Static>'));
  expect(runs(plan(calculated, unit))).toEqual([[103, [0xaa]]]);
  expect(runs(plan(withNone("top", "<Unknown/>"), unit))).toEqual([[103, [0xaa]]]);
  expect([withNone("top"), calculated, withNone("top", "<Unknown/>")].map((a) => constantParams(a).has("M-0005_A-0001-01-0001_P-4"))).toEqual([true, false, false]);
  // A colour parameter of a space whose width no capture shows (RGBW) in the segment: its bits cannot be
  // told, so none is constant there, though it lies apart from the marker.
  const colour = parseAppConfig(withNoneXml("top")
    .replace("</ParameterTypes>", '<ParameterType Id="M-0005_A-0001-01-0001_PT-C"><TypeColor ColorSpace="RGBW"/></ParameterType></ParameterTypes>')
    .replace("</Parameters>", '<Parameter Id="M-0005_A-0001-01-0001_P-6" ParameterType="M-0005_A-0001-01-0001_PT-C" Text="Colour" Value="#00000000"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="1" BitOffset="0"/></Parameter></Parameters>'));
  expect(colour.types.get("M-0005_A-0001-01-0001_PT-C")?.sizeInBit).toBe(0);
  expect(runs(plan(colour, unit))).toEqual([[103, [0xaa]]]);
});

// The Gira M-0008's status LED function (P-579) has no memory; what it changes in the image are
// Access="None" parameters ETS computes from it (LED_Aktion and its kin). A change of it reaches the
// unit only through them, so they are a change, not a marker.
corpusTest("a memoryless parameter that changes only Access=\"None\" bytes is a change", () => {
  const gira = parseAppConfig(readRealFixture("M-0008_A-10D7-11-2783-O000A.xml.gz"));
  const P = "M-0008_A-10D7-11-2783-O000A_";
  const values = (led: string) => new Map([[`${P}P-224_R-224`, "2"], [`${P}P-2194_R-2194`, "2"], [`${P}P-579_R-579`, led], [`${P}P-1286_R-1286`, "3"]]);
  const unit = new Map(buildAbsoluteSegmentTargets(gira, values("3")).map((t) => [t.id, Buffer.from(t.bytes)]));
  expect(planAbsoluteSegmentFlash(gira, values("3"), { current: unit }).totalWrittenBytes).toBe(0);
  const changed = buildAbsoluteSegmentTargets(gira, values("0"));
  const differing = changed.flatMap((t) => t.owned.flatMap((own, i) => ((t.bytes[i] ^ unit.get(t.id)![i]) & own ? [t.verify[i] & own] : [])));
  expect([differing.length > 0, differing.every((v) => v === 0)]).toEqual([true, true]);
  expect(planAbsoluteSegmentFlash(gira, values("0"), { current: unit }).totalWrittenBytes).toBe(differing.length);
});

corpusTest("adjacent owned bytes coalesce into a single contiguous run", () => {
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

corpusTest("a memory-mapped full download authors the com-object table as ETS does", () => {
  // ABB US/U 4.2 (MV-0701), com-object table AS-43FE: [count][2 B] then 4-byte entries, config byte
  // at 3+4n+2. ETS 6 captures: at application defaults no object is configured and
  // every config byte is the template's 0xdf with the link bit 0x04 cleared (0xdb); with channel A
  // controlling an LED, object 1 linked and object 3 not, ETS wrote 0x17 and 0x13 (write, low
  // priority, link bit only on the linked one).
  const xml = readRealFixture("M-0002_A-A001-13-63C2.xml.gz");
  const app = parseAppConfig(xml);
  const cfgAt = (n: number) => 3 + 4 * n + 2;
  const template = app.absoluteSegments.find((s) => s.address === 0x43fe)!.data;
  const l3 = (params: Map<string, string>, links: { comObjNum: number; gaRaws: number[] }[]) => {
    const active = buildDeviceConfig(app, params).imageComObjects;
    return planAbsoluteFullDownload(app, params, links, 0x11c9, parseLoadProcedures(xml), { requireReboot: false, propertyMapped: false, form: "declared", comObjectTable: { active, linked: new Set(links.map((l) => l.comObjNum)) } })
      .segments.find((s) => s.address === 0x43fe)!.image;
  };
  const defaults = l3(new Map(), []);
  for (let n = 0; n < template[0]; n++) expect([n, defaults[cfgAt(n)]]).toEqual([n, template[cfgAt(n)] & ~0x04]);
  const led = l3(new Map([["M-0002_A-A001-13-63C2_P-9_R-9", "104"]]), [{ comObjNum: 1, gaRaws: [0x1b04] }]);
  expect([led[cfgAt(1)], led[cfgAt(3)]]).toEqual([0x17, 0x13]);
});

// A byte an absolute segment's parameters own only in part keeps the device's other bits on a
// parameter flash (every partly owned byte of a real System 7 application, device bits all set).
corpusTest("an absolute parameter flash writes only the owned bits of a shared byte", () => {
  const app = parseAppConfig(readRealFixture("M-0083_A-00B6-32-9642.xml.gz"));
  const targets = buildAbsoluteSegmentTargets(app, new Map());
  const partly = targets.flatMap((t) => t.owned.map((m, i) => ({ t, i, m })).filter(({ m }) => m !== 0 && m !== 0xff));
  expect(partly.length).toBeGreaterThan(0);
  const current = new Map(targets.map((t) => [t.id, Buffer.alloc(t.size, 0xff)]));
  const plan = planAbsoluteSegmentFlash(app, new Map(), { current });
  for (const { t, i, m } of partly) {
    const run = plan.segments.find((s) => s.id === t.id)!.runs.find((r) => t.address + i >= r.address && t.address + i < r.address + r.bytes.length);
    const written = run ? run.bytes[t.address + i - run.address] : 0xff;
    expect(written & ~m & 0xff).toBe(~m & 0xff); // every unowned bit is the device's 1
    expect(written & m).toBe(t.bytes[i] & m);
  }
});
