import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readdirSync } from "node:fs";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { catalogueXml, corpusPath } from "../../../tools/corpus.ts";
import { parseAppConfig, initialValues } from "../src/index.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): the catalogue sweep takes up to
// 3 s with the file alone; twenty times that, at least 60 s.
setDefaultTimeout(60_000);

// A device added to an ETS project starts its text parameters at their InitialValue in the project's language: ETS
// 6.4.1 on bussard's syn-text-initialvalue, added to a de-DE project, wrote the de-DE InitialValue
// (tools/bussard-text.test.ts holds Busforge's image against that capture). What no capture shows refuses.
const A = "M-TEST_A-47";
const app = (params: string, refs: string, translations: string, moduleDefs = "", staticExtra = "") => parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="47" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Initial values">
<Static>
<ParameterTypes>
  <ParameterType Id="${A}_PT-Txt" Name="Txt"><TypeText SizeInBit="160" /></ParameterType>
  <ParameterType Id="${A}_PT-Num" Name="Num"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255" /></ParameterType>
</ParameterTypes>
<Parameters>${params}</Parameters>
<ParameterRefs>${refs}</ParameterRefs>
<Code><RelativeSegment Id="${A}_RS-1" Offset="0" Size="64" LoadStateMachine="4" /></Code>${staticExtra}
</Static>${moduleDefs}
</ApplicationProgram></ApplicationPrograms></Manufacturer>
<Languages><Language Identifier="de-DE"><TranslationUnit RefId="${A}">${translations}</TranslationUnit></Language></Languages>
</ManufacturerData></KNX>`);
const text = (n: number, attrs: string) => `<Parameter Id="${A}_P-${n}" Name="T${n}" ParameterType="${A}_PT-Txt" Text="Text ${n}" ${attrs}><Memory CodeSegment="${A}_RS-1" Offset="${n * 20}" BitOffset="0" /></Parameter>`;
const ref = (n: number, attrs = "") => `<ParameterRef Id="${A}_P-${n}_R-${n}" RefId="${A}_P-${n}" ${attrs}/>`;
const tr = (id: string, value: string) => `<TranslationElement RefId="${id}"><Translation AttributeName="InitialValue" Text="${value}" /></TranslationElement>`;

describe("initialValues", () => {
  const cfg = app(text(1, `Value="Nest" InitialValue="Nest"`) + text(2, `Value="Plain"`), ref(1) + ref(2), tr(`${A}_P-1`, "Horst Süd"));

  test("a text parameter starts at its InitialValue's translation into the placing language", () => {
    expect([...initialValues(cfg, "de")]).toEqual([[`${A}_P-1_R-1`, "Horst Süd"]]);
    expect(initialValues(cfg, "en").size).toBe(0);
    expect(initialValues(cfg).size).toBe(0);
  });

  test("an InitialValue equal to the default gives nothing to store", () => {
    expect(initialValues(app(text(1, `Value="Horst" InitialValue="Nest"`), ref(1), tr(`${A}_P-1`, "Horst")), "de").size).toBe(0);
  });

  const refused = (c: ReturnType<typeof app>, lang: string) => expect(() => initialValues(c, lang)).toThrow(expect.objectContaining({ code: "PARAM_INITIAL_VALUE_UNSUPPORTED" }));
  test("what no capture shows ETS taking refuses the placement where it differs from the default", () => {
    refused(app(text(1, `Value="Nest"`), ref(1, `Value="Taster"`), tr(`${A}_P-1_R-1`, "Schalter")), "de"); // on a ParameterRef
    refused(app(text(1, `Value="Nest" InitialValue="Nest"`), ref(1, `Value="Other"`), tr(`${A}_P-1`, "Horst")), "de"); // a ref Value beside it
    refused(app(`<Parameter Id="${A}_P-1" Name="N" ParameterType="${A}_PT-Num" Text="N" Value="1" InitialValue="2"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0" /></Parameter>`, ref(1), ""), "en"); // no text
    refused(app(text(1, `Value="Nest" InitialValue="Start"`), ref(1), ""), "en"); // untranslated
    refused(app(text(1, `Value="Nest"`), ref(1, `InitialValue="Start"`), ""), "en"); // the ParameterRef's own, untranslated
  });

  test("a ParameterRef's translated InitialValue equal to its Value is no refusal", () => {
    expect(initialValues(app(text(1, `Value="Nest"`), ref(1, `Value="Taster"`), tr(`${A}_P-1_R-1`, "Taster")), "de").size).toBe(0);
  });

  // The Jung 400021SE's form: a memoryless text <Assign>s set and read among memoryless ones, with a translated
  // InitialValue on its ParameterRef.
  const page = (n: number) => `<Parameter Id="${A}_P-${n}" Name="Page${n}" ParameterType="${A}_PT-Txt" Text="" Access="None" Value="TEST" />`;
  const memoryless = (dynamic: string) => app(page(1) + text(2, `Value="x"`) + page(3), ref(1, `Value="Farbwert"`) + ref(2) + ref(3), tr(`${A}_P-1_R-1`, "Taster"), dynamic);
  const dyn = (body: string) => `<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="B" Text="B"><ParameterRefRef RefId="${A}_P-2_R-2" />${body}</ParameterBlock></ChannelIndependentBlock></Dynamic>`;
  test("a memoryless parameter whose value reaches no device byte keeps its default; one a <choose> tests or an <Assign> sets a placed one from refuses", () => {
    expect(initialValues(memoryless(dyn(`<Assign TargetParamRefRef="${A}_P-1_R-1" SourceParamRefRef="${A}_P-2_R-2" />`)), "de").size).toBe(0);
    expect(initialValues(memoryless(dyn(`<Assign TargetParamRefRef="${A}_P-3_R-3" SourceParamRefRef="${A}_P-1_R-1" />`)), "de").size).toBe(0);
    refused(memoryless(dyn(`<Assign TargetParamRefRef="${A}_P-3_R-3" SourceParamRefRef="${A}_P-1_R-1" /><Assign TargetParamRefRef="${A}_P-2_R-2" SourceParamRefRef="${A}_P-3_R-3" />`)), "de");
    refused(memoryless(dyn(`<choose ParamRefId="${A}_P-1_R-1"><when test="Taster"><ParameterRefRef RefId="${A}_P-2_R-2" /></when></choose>`)), "de");
  });

  test("a memoryless parameter a <ParameterCalculation> computes a parameter with memory from refuses", () => {
    const calc = `<ParameterCalculations><ParameterCalculation Id="${A}_PC-1" Name="c" Language="JavaScript"><LRTransformation>function f(x){return x*2;}</LRTransformation>
      <LParameters><ParameterRefRef RefId="${A}_P-1_R-1" /></LParameters><RParameters><ParameterRefRef RefId="${A}_P-2_R-2" /></RParameters></ParameterCalculation></ParameterCalculations>`;
    const input = `<Parameter Id="${A}_P-1" Name="In" ParameterType="${A}_PT-Num" Text="In" Value="1" InitialValue="2" />`;
    const output = `<Parameter Id="${A}_P-2" Name="Out" ParameterType="${A}_PT-Num" Text="Out" Value="0"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0" /></Parameter>`;
    refused(app(input + output, ref(1) + ref(2), "", "", calc), "en");
    expect(initialValues(app(input + output, ref(1) + ref(2), ""), "en").size).toBe(0); // without the calculation it reaches nothing
  });
});

// No placement of a corpus application is refused, and none starts away from its defaults: the Jung 400021SE's
// translated InitialValues sit on memoryless ParameterRefs its <Assign>s set and read among themselves, the others
// equal their Value.
corpusDescribe("initialValues over the corpus catalogues", () => {
  test("every application, in its default language and in every one it carries", () => {
    const files = readdirSync(corpusPath("catalogue")).filter((f) => f.endsWith(".xml.gz"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const cfg = parseAppConfig(catalogueXml(f));
      for (const lang of [cfg.defaultLanguage, ...cfg.languages]) expect({ f, lang, values: [...initialValues(cfg, lang)] }).toEqual({ f, lang, values: [] });
    }
  });
});
