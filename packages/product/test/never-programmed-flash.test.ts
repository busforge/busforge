import { test, expect, setDefaultTimeout } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify } from "../src/index.ts";

// Timeouts measured (docs/testing.md, "Timeouts of heavy tests"): tests here take under 0.1 s, so each gets the floor of
// 60 s.
setDefaultTimeout(60_000);

// A device never programmed from this project holds nothing the programmed baseline describes: the parameter flash
// judges what it cannot encode against the application's defaults, as a full download does, not against that baseline.
// System B application: P-1 (memory, shown) feeds a <ParameterCalculation> whose other side P-3 has memory; P-4 is raw
// data with memory, shown.
const A = "M-0005_A-0001-01-0001";
const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" MinEtsVersion="5.0" DefaultLanguage="en-US" Name="Never programmed">
<Static>
<ParameterTypes><ParameterType Id="${A}_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType><ParameterType Id="${A}_PT-Raw" Name="Raw"><TypeRawData MaxSize="1"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="${A}_P-1" ParameterType="${A}_PT-8" Text="Input" Value="7"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="${A}_P-3" ParameterType="${A}_PT-8" Text="Result" Value="3"><Memory CodeSegment="${A}_RS-1" Offset="1" BitOffset="0"/></Parameter>
<Parameter Id="${A}_P-4" ParameterType="${A}_PT-Raw" Text="Raw" Value="00"><Memory CodeSegment="${A}_RS-1" Offset="2" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs><ParameterRef Id="${A}_P-1_R" RefId="${A}_P-1"/><ParameterRef Id="${A}_P-3_R" RefId="${A}_P-3"/><ParameterRef Id="${A}_P-4_R" RefId="${A}_P-4"/></ParameterRefs>
<Code><RelativeSegment Id="${A}_RS-1" LoadStateMachine="4" Size="3"><Data>AAAA</Data></RelativeSegment></Code>
<ParameterCalculations><ParameterCalculation Id="${A}_PC-1" Language="JavaScript" Name="calc"><LParameters><ParameterRefRef RefId="${A}_P-1_R" AliasName="a"/></LParameters><RParameters><ParameterRefRef RefId="${A}_P-3_R" AliasName="b"/></RParameters></ParameterCalculation></ParameterCalculations>
</Static>
<Dynamic><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${A}_P-1_R"/><ParameterRefRef RefId="${A}_P-4_R"/></ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
// The same application with an HSV colour (P-5, memory, shown), whose bytes no ETS download shows.
const colourXml = xml
  .replace("</ParameterTypes>", `<ParameterType Id="${A}_PT-HSV"><TypeColor Space="HSV"/></ParameterType></ParameterTypes>`)
  .replace("</Parameters>", `<Parameter Id="${A}_P-5" ParameterType="${A}_PT-HSV" Text="Colour" Value="#000000"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0"/></Parameter></Parameters>`)
  .replace("</ParameterRefs>", `<ParameterRef Id="${A}_P-5_R" RefId="${A}_P-5"/></ParameterRefs>`)
  .replace(`<ParameterRefRef RefId="${A}_P-1_R"/><ParameterRefRef RefId="${A}_P-4_R"/>`, `<ParameterRefRef RefId="${A}_P-5_R"/>`);
// Every refusal runs before the first request: a device the flash would use answers with this error.
const untouched = new Proxy({}, { get: (_t, k) => () => { throw new Error(`the device was used: ${String(k)}`); } }) as unknown as KnxDevice;
const flash = (values: Map<string, string>, neverProgrammed: boolean, appXml = xml) =>
  classify(parseAppConfig(appXml)).flashParameters(untouched, "MV-07B0", { deviceId: "d", appXml, params: values, baseParams: values, moduleInstances: [], dryRun: false, persistBackups: () => "backup", neverProgrammed })
    .then(() => "flashed", (e: { code?: string; message?: string }) => e.code ?? e.message);

test("a calculation input away from its default: refused on a never-programmed device, the same value as the baseline flashed otherwise", async () => {
  const input = new Map([[`${A}_P-1_R`, "8"]]);
  expect(await flash(input, false)).toBe("the device was used: tableAddr");
  expect(await flash(input, true)).toBe("PARAM_CALCULATION_UNSUPPORTED");
  expect(await flash(new Map(), true)).toBe("the device was used: tableAddr");
});

test("a raw-data value away from its default: refused on a never-programmed device, the same value as the baseline flashed otherwise", async () => {
  const raw = new Map([[`${A}_P-4_R`, "01"]]);
  expect(await flash(raw, false)).toBe("the device was used: tableAddr");
  expect(await flash(raw, true)).toBe("PARAM_RAW_DATA_UNSUPPORTED");
});

test("a colour in use whose bytes no download shows: refused on a never-programmed device, the same value as the baseline flashed otherwise", async () => {
  expect(await flash(new Map(), false, colourXml)).toBe("the device was used: tableAddr");
  expect(await flash(new Map(), true, colourXml)).toBe("PARAM_COLOR_UNSUPPORTED");
});
