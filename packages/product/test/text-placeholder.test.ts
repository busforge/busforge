import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { capturePath, catalogueXml } from "../../../tools/corpus.ts";
import { parseAppConfig } from "../src/appconfig.ts";
import { buildDeviceConfig, comObjectRefTexts, comObjectUniverse, type CfgItem } from "../src/config.ts";

// An ETS text may name the value of the parameter its element's TextParameterRefId points at:
// `{{0}}` stands for that value, `{{0:text}}` for that value or, while the value is empty, for
// `text`. Channels, blocks, separators and com-object references carry it.
const A = "M-TEST_A-44";
const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="44" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Placeholders">
<Static>
<ParameterTypes>
  <ParameterType Id="${A}_PT-Txt" Name="Txt"><TypeText SizeInBit="160" /></ParameterType>
</ParameterTypes>
<Parameters>
  <Parameter Id="${A}_P-1" Name="Name" ParameterType="${A}_PT-Txt" Text="Device name" Value=""><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0" /></Parameter>
</Parameters>
<ParameterRefs>
  <ParameterRef Id="${A}_P-1_R-1" RefId="${A}_P-1" />
  <ParameterRef Id="${A}_P-1_R-3" RefId="${A}_P-1" />
</ParameterRefs>
<ComObjectTable>
  <ComObject Id="${A}_O-1" Number="1" Name="Out" Text="{{0:Sensor}}: value" FunctionText="Output" ObjectSize="1 Bit" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
  <ComObject Id="${A}_O-2" Number="2" Name="Plain" Text="Plain {{0:x}}" FunctionText="Input" ObjectSize="1 Bit" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
</ComObjectTable>
<ComObjectRefs>
  <ComObjectRef Id="${A}_O-1_R-1" RefId="${A}_O-1" TextParameterRefId="${A}_P-1_R-1" />
  <ComObjectRef Id="${A}_O-2_R-2" RefId="${A}_O-2" />
  <ComObjectRef Id="${A}_O-1_R-3" RefId="${A}_O-1" TextParameterRefId="${A}_P-1_R-3" />
</ComObjectRefs>
<Code><RelativeSegment Id="${A}_RS-1" Offset="0" Size="32" LoadStateMachine="4" /></Code>
</Static>
<Dynamic>
  <Channel Id="${A}_CH-1" Name="Ch" Number="1" Text="Channel {{0:unnamed}}" TextParameterRefId="${A}_P-1_R-1">
    <ParameterBlock Id="${A}_PB-1" Name="Page" Text="Device 1: {{0: ...}}" TextParameterRefId="${A}_P-1_R-1">
      <ParameterSeparator Id="${A}_PS-1" Text="Window {{0:-}}" TextParameterRefId="${A}_P-1_R-1" UIHint="Headline" />
      <ParameterRefRef RefId="${A}_P-1_R-1" />
      <ParameterSeparator Id="${A}_PS-2" Text="Bare {{0}}" TextParameterRefId="${A}_P-1_R-1" />
      <ParameterSeparator Id="${A}_PS-3" Text="Unfed {{0:kept}}" />
      <ComObjectRefRef RefId="${A}_O-1_R-1" />
      <ComObjectRefRef RefId="${A}_O-2_R-2" />
    </ParameterBlock>
    <ParameterBlock Id="${A}_PB-2" Name="Head" Text="Header {{0:none}}" TextParameterRefId="${A}_P-1_R-1" />
  </Channel>
</Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer>
<Languages><Language Identifier="de-DE"><TranslationUnit RefId="${A}">
  <TranslationElement RefId="${A}_PB-1"><Translation AttributeName="Text" Text="Gerät 1: {{0: ...}}" /></TranslationElement>
  <TranslationElement RefId="${A}_O-1_R-1"><Translation AttributeName="Text" Text="{{0:Fühler}}: Wert" /></TranslationElement>
</TranslationUnit></Language></Languages>
</ManufacturerData></KNX>`;
const app = parseAppConfig(xml);

const texts = (items: CfgItem[]) => items.map((i) =>
  i.kind === "separator" ? i.text : i.kind === "param" ? i.param.name : i.kind === "comObject" ? i.comObject.name : "");

describe("text placeholders {{0}} and {{0:default}}", () => {
  test("an empty text parameter shows each default, verbatim", () => {
    const v = buildDeviceConfig(app, new Map());
    expect(v.blocks.map((b) => b.name)).toEqual(["Channel unnamed", "Device 1:  ...", "Header none"]);
    expect(texts(v.blocks[1].items)).toEqual(["Window -", "Device name", "Bare ", "Unfed {{0:kept}}", "Sensor: value", "Plain {{0:x}}"]);
  });

  test("a set text parameter replaces every placeholder it feeds", () => {
    const v = buildDeviceConfig(app, new Map([[`${A}_P-1_R-1`, "Cellar"]]));
    expect(v.blocks.map((b) => b.name)).toEqual(["Channel Cellar", "Device 1: Cellar", "Header Cellar"]);
    // An element without a TextParameterRefId has nothing to substitute: its placeholder stays
    // visible rather than being guessed away.
    expect(texts(v.blocks[1].items)).toEqual(["Window Cellar", "Device name", "Bare Cellar", "Unfed {{0:kept}}", "Cellar: value", "Plain {{0:x}}"]);
  });

  test("a value is inserted literally, replacement patterns included", () => {
    const v = buildDeviceConfig(app, new Map([[`${A}_P-1_R-1`, "A$&B$1"]]));
    expect(v.blocks[1].name).toBe("Device 1: A$&B$1");
  });

  test("a translated text carries the placeholder too", () => {
    const v = buildDeviceConfig(app, new Map(), "de-DE");
    expect(v.blocks[1].name).toBe("Gerät 1:  ...");
    expect(texts(v.blocks[1].items)[4]).toBe("Fühler: Wert");
    expect(buildDeviceConfig(app, new Map([[`${A}_P-1_R-1`, "Keller"]]), "de-DE").blocks[1].name).toBe("Gerät 1: Keller");
  });

  test("the com-object universe resolves the default the same way", () => {
    const u = comObjectUniverse(app);
    expect(u.map((e) => e.name)).toEqual(["Sensor: value", "Plain {{0:x}}", "Sensor: value"]);
  });

  test("a com-object outside the view takes the device's value, else the default", () => {
    const v = buildDeviceConfig(app, new Map([[`${A}_P-1_R-1`, "Attic"]]));
    expect(comObjectRefTexts(app, `${A}_O-1_R-1`, undefined, v.paramValue)?.name).toBe("Attic: value");
    // Fed by an unplaced ref of the same parameter: it holds the placed sibling's value, as in the view.
    expect(comObjectRefTexts(app, `${A}_O-1_R-3`, undefined, v.paramValue)?.name).toBe("Attic: value");
    expect(comObjectRefTexts(app, `${A}_O-1_R-1`, "de-DE", buildDeviceConfig(app, new Map()).paramValue)?.name).toBe("Fühler: Wert");
    expect(comObjectRefTexts(app, `${A}_O-2_R-2`)?.name).toBe("Plain {{0:x}}");
    expect(comObjectRefTexts(app, `${A}_O-9_R-9`)).toBeUndefined();
  });

  // A module argument may sit inside the default ("Button {{ChNo}}: {{0:Button {{ChNo}}}}"):
  // the argument is substituted first, then the text parameter.
  test("a module argument inside the default is substituted before the default applies", () => {
    const M = "M-TEST_A-45";
    const mod = parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="${M}" ApplicationNumber="45" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Module placeholders">
<Static><ParameterTypes><ParameterType Id="${M}_PT-Txt" Name="Txt"><TypeText SizeInBit="80" /></ParameterType></ParameterTypes>
<Parameters /><ParameterRefs /><ComObjectTable /><ComObjectRefs /></Static>
<ModuleDefs><ModuleDef Id="${M}_MD-1" Name="Btn">
<Arguments><Argument Id="${M}_MD-1_A-1" Name="ChNo" Type="Text" /></Arguments>
<Static><Parameters><Parameter Id="${M}_MD-1_P-1" Name="Name" ParameterType="${M}_PT-Txt" Text="Name" Value=""><Memory CodeSegment="${M}_RS-1" Offset="0" BitOffset="0" /></Parameter></Parameters>
<ParameterRefs><ParameterRef Id="${M}_MD-1_P-1_R-1" RefId="${M}_MD-1_P-1" /></ParameterRefs></Static>
<Dynamic><ParameterBlock Id="${M}_MD-1_PB-1" Name="b" Text="Button {{ChNo}}: {{0:Button {{ChNo}}}}" TextParameterRefId="${M}_MD-1_P-1_R-1">
<ParameterRefRef RefId="${M}_MD-1_P-1_R-1" /></ParameterBlock></Dynamic>
</ModuleDef></ModuleDefs>
<Dynamic><ChannelIndependentBlock><Module Id="${M}_MD-1_M-1" RefId="${M}_MD-1" Name="B" /></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
    const instances = [
      { id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "A" }] },
      { id: "MD-1_M-1_MI-2", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "B" }] },
    ];
    const v = buildDeviceConfig(mod, new Map([[`${M}_MD-1_M-1_MI-2_P-1_R-1`, "Hall"]]), undefined, instances);
    expect(v.blocks.map((b) => b.name)).toEqual(["Button A: Button A", "Button B: Hall"]);
  });
});

// The real catalogues that author `{{0:default}}`: the OpenKNX RaumController and the M-0004
// application. Their default views must not show a single unresolved placeholder that a
// TextParameterRefId feeds.
corpusDescribe("text placeholders in real catalogues", () => {
  const unresolved = (x: string) => {
    const s = JSON.stringify(buildDeviceConfig(parseAppConfig(x), new Map()));
    return s.match(/\{\{0[^}]*\}\}/g) ?? [];
  };

  test("OpenKNX RaumController: the 1-Wire, presence and push-button pages show their default name", () => {
    const x = gunzipSync(readFileSync(capturePath("openknx-raumcontroller-5.5.1-app.xml.gz"))).toString("utf8");
    const v = buildDeviceConfig(parseAppConfig(x), new Map());
    const names = v.blocks.map((b) => b.name);
    expect(names).toContain("Gerät 1:  ...");
    expect(JSON.stringify(v).match(/\{\{0[^}]*\}\}/g) ?? []).toEqual([]);
  }, 60_000); // a 75 MB application program, parsed once

  test("M-0004: channel headings show their default", () => {
    expect(unresolved(catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz"))).toEqual([]);
  }, 30_000);
});
