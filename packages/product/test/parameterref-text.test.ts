import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { capturePath, catalogueXml } from "../../../tools/corpus.ts";
import { parseAppConfig } from "../src/appconfig.ts";
import { buildDeviceConfig, type CfgItem, type CfgParamView } from "../src/config.ts";

// A ParameterRef may carry its own Text and SuffixText, which ETS shows instead of its
// Parameter's. Its TextParameterRefId feeds the `{{0}}` / `{{0:default}}` in that text.
const A = "M-TEST_A-46";
const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="46" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Ref texts">
<Static>
<ParameterTypes>
  <ParameterType Id="${A}_PT-Txt" Name="Txt"><TypeText SizeInBit="160" /></ParameterType>
  <ParameterType Id="${A}_PT-Num" Name="Num"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255" /></ParameterType>
</ParameterTypes>
<Parameters>
  <Parameter Id="${A}_P-1" Name="GroupName" ParameterType="${A}_PT-Txt" Text="Group name" Value=""><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0" /></Parameter>
  <Parameter Id="${A}_P-2" Name="Delay" ParameterType="${A}_PT-Num" Text="Delay" SuffixText="s" Value="5"><Memory CodeSegment="${A}_RS-1" Offset="20" BitOffset="0" /></Parameter>
  <Parameter Id="${A}_P-3" Name="Use" ParameterType="${A}_PT-Num" Text="Use group" Value="0"><Memory CodeSegment="${A}_RS-1" Offset="21" BitOffset="0" /></Parameter>
</Parameters>
<ParameterRefs>
  <ParameterRef Id="${A}_P-1_R-1" RefId="${A}_P-1" />
  <ParameterRef Id="${A}_P-2_R-2" RefId="${A}_P-2" />
  <ParameterRef Id="${A}_P-2_R-3" RefId="${A}_P-2" Text="    Switch-off delay" SuffixText="min" />
  <ParameterRef Id="${A}_P-3_R-4" RefId="${A}_P-3" Text="{{0:Group 1}}" TextParameterRefId="${A}_P-1_R-1" />
  <ParameterRef Id="${A}_P-3_R-5" RefId="${A}_P-3" Text="Plain {{0:x}}" />
  <ParameterRef Id="${A}_P-2_R-6" RefId="${A}_P-2" Text="" SuffixText="" />
</ParameterRefs>
<Code><RelativeSegment Id="${A}_RS-1" Offset="0" Size="32" LoadStateMachine="4" /></Code>
</Static>
<Dynamic>
  <ChannelIndependentBlock>
    <ParameterBlock Id="${A}_PB-1" Name="Page" Text="Page">
      <ParameterRefRef RefId="${A}_P-1_R-1" />
      <ParameterRefRef RefId="${A}_P-2_R-2" />
      <ParameterRefRef RefId="${A}_P-2_R-3" />
      <ParameterRefRef RefId="${A}_P-3_R-4" />
      <ParameterRefRef RefId="${A}_P-3_R-5" />
      <ParameterRefRef RefId="${A}_P-2_R-6" />
    </ParameterBlock>
    <ParameterBlock Id="${A}_PB-2" Name="Head" ParamRefId="${A}_P-3_R-4" />
  </ChannelIndependentBlock>
</Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer>
<Languages><Language Identifier="de-DE"><TranslationUnit RefId="${A}">
  <TranslationElement RefId="${A}_P-2"><Translation AttributeName="Text" Text="Verzögerung" /></TranslationElement>
  <TranslationElement RefId="${A}_P-2_R-3"><Translation AttributeName="Text" Text="Ausschaltverzögerung" /><Translation AttributeName="SuffixText" Text="Min." /></TranslationElement>
  <TranslationElement RefId="${A}_P-3_R-4"><Translation AttributeName="Text" Text="{{0:Gruppe 1}}" /></TranslationElement>
</TranslationUnit></Language></Languages>
</ManufacturerData></KNX>`;
const app = parseAppConfig(xml);

const params = (items: CfgItem[]): CfgParamView[] => items.flatMap((i) => (i.kind === "param" ? [i.param] : []));
const page = (overrides = new Map<string, string>(), lang?: string) => buildDeviceConfig(app, overrides, lang).blocks.find((b) => b.id === `${A}_PB-1`)!;

describe("a ParameterRef's own text", () => {
  test("replaces its Parameter's text and suffix; a ref without one keeps the Parameter's", () => {
    const ps = params(page().items);
    expect(ps.map((p) => p.name)).toEqual(["Group name", "Delay", "    Switch-off delay", "Group 1", "Plain {{0:x}}", "Delay"]);
    expect(ps.map((p) => p.suffix)).toEqual([undefined, "s", "min", undefined, undefined, undefined]);
  });

  // An empty SuffixText clears the Parameter's unit (the OpenKNX RaumController clears a
  // temperature unit this way on refs that are not temperatures). An empty Text keeps the
  // Parameter's label: whether ETS shows none is not known, and hiding one ETS shows is worse.
  test("an empty SuffixText clears the Parameter's unit, an empty Text keeps its label", () => {
    const p = params(page().items)[5];
    expect([p.refId, p.name, p.suffix]).toEqual([`${A}_P-2_R-6`, "Delay", undefined]);
  });

  test("its placeholder is fed by its own TextParameterRefId", () => {
    const ps = params(page(new Map([[`${A}_P-1_R-1`, "Lights"]])).items);
    expect(ps[3].name).toBe("Lights");
    // A ref without a TextParameterRefId has nothing to substitute: its placeholder stays visible.
    expect(ps[4].name).toBe("Plain {{0:x}}");
  });

  test("its translation is shown in that language", () => {
    const ps = params(page(new Map(), "de-DE").items);
    expect(ps.map((p) => p.name)).toEqual(["Group name", "Verzögerung", "    Ausschaltverzögerung", "Gruppe 1", "Plain {{0:x}}", "Verzögerung"]);
    expect(ps[2].suffix).toBe("Min.");
  });

  test("a block headed by a parameter takes the ref's text", () => {
    const v = buildDeviceConfig(app, new Map([[`${A}_P-1_R-1`, "Lights"]]));
    expect(v.blocks.find((b) => b.id === `${A}_PB-2`)?.name).toBe("Lights");
  });

  // A module argument in the ref's text is substituted, then the text parameter.
  test("inside a module instance, arguments and the instance's value are substituted", () => {
    const M = "M-TEST_A-47";
    const mod = parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="${M}" ApplicationNumber="47" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Module ref texts">
<Static><ParameterTypes>
  <ParameterType Id="${M}_PT-Txt" Name="Txt"><TypeText SizeInBit="80" /></ParameterType>
  <ParameterType Id="${M}_PT-Num" Name="Num"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255" /></ParameterType>
</ParameterTypes>
<Parameters /><ParameterRefs /><ComObjectTable /><ComObjectRefs /></Static>
<ModuleDefs><ModuleDef Id="${M}_MD-1" Name="Ch">
<Arguments><Argument Id="${M}_MD-1_A-1" Name="ChNo" Type="Text" /></Arguments>
<Static><Parameters>
  <Parameter Id="${M}_MD-1_P-1" Name="Name" ParameterType="${M}_PT-Txt" Text="Name" Value=""><Memory CodeSegment="${M}_RS-1" Offset="0" BitOffset="0" /></Parameter>
  <Parameter Id="${M}_MD-1_P-2" Name="Mode" ParameterType="${M}_PT-Num" Text="Mode" Value="0"><Memory CodeSegment="${M}_RS-1" Offset="10" BitOffset="0" /></Parameter>
</Parameters>
<ParameterRefs>
  <ParameterRef Id="${M}_MD-1_P-1_R-1" RefId="${M}_MD-1_P-1" />
  <ParameterRef Id="${M}_MD-1_P-2_R-2" RefId="${M}_MD-1_P-2" Text="Mode of {{0:channel {{ChNo}}}}" TextParameterRefId="${M}_MD-1_P-1_R-1" />
</ParameterRefs></Static>
<Dynamic><ParameterBlock Id="${M}_MD-1_PB-1" Name="b" Text="Channel {{ChNo}}">
<ParameterRefRef RefId="${M}_MD-1_P-1_R-1" /><ParameterRefRef RefId="${M}_MD-1_P-2_R-2" /></ParameterBlock></Dynamic>
</ModuleDef></ModuleDefs>
<Dynamic><ChannelIndependentBlock><Module Id="${M}_MD-1_M-1" RefId="${M}_MD-1" Name="C" /></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
    const instances = [
      { id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "A" }] },
      { id: "MD-1_M-1_MI-2", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "B" }] },
    ];
    const v = buildDeviceConfig(mod, new Map([[`${M}_MD-1_M-1_MI-2_P-1_R-1`, "Hall"]]), undefined, instances);
    expect(v.blocks.map((b) => params(b.items)[1].name)).toEqual(["Mode of channel A", "Mode of Hall"]);
  });
});

// Real catalogues whose ParameterRefs carry their own texts. The overrides open the page that
// places the ref.
corpusDescribe("ParameterRef texts in real catalogues", () => {
  const named = (x: string, overrides: [string, string][]) => {
    const v = buildDeviceConfig(parseAppConfig(x), new Map(overrides));
    return { v, byRef: new Map(v.blocks.flatMap((b) => params(b.items).map((p) => [p.refId, p] as const))) };
  };

  test("OpenKNX RaumController: a 1-Wire group is labelled by its ref's placeholder, default or value", () => {
    const x = gunzipSync(readFileSync(capturePath("openknx-raumcontroller-5.5.1-app.xml.gz"))).toString("utf8");
    const R = "M-00FA_A-A012-55-0000";
    const open: [string, string][] = [[`${R}_UP-2001011_R-200101101`, "1"]];
    const empty = named(x, open);
    expect(empty.byRef.get(`${R}_UP-2001031_R-200103101`)?.name).toBe("Gruppe 1");
    expect(JSON.stringify(empty.v).match(/\{\{0[^}]*\}\}/g) ?? []).toEqual([]);
    const set = named(x, [...open, [`${R}_P-2000010_R-200001001`, "Flur"]]);
    expect(set.byRef.get(`${R}_UP-2001031_R-200103101`)?.name).toBe("Flur");
  }, 60_000); // a 75 MB application program, parsed twice

  test("M-0085: a fan's minimum time shows its ref's own indented text and suffix", () => {
    const M = "M-0085_A-0072-30-69AA";
    const { byRef } = named(catalogueXml(`${M}.xml.gz`), [[`${M}_P-3020_R-3020`, "3"], [`${M}_P-3154_R-3154`, "0"], [`${M}_UP-3193_R-3193`, "2"]]);
    const p = byRef.get(`${M}_UP-3194_R-3195`);
    // Its Parameter reads "  Delay time [1...65535]" in units of "*0.1s".
    expect(p?.name).toBe("  Minimum time [1...65535]");
    expect(p?.suffix).toBe("s");
  }, 30_000);
});
