import { test, expect, describe } from "bun:test";
import { parseAppConfig, buildAbsoluteSegmentTargets, buildRelativeSegmentTarget, hiddenParameterRule, type AppConfig } from "../src/index.ts";

// What Busforge writes for a parameter the configuration does not show (docs/load-procedures.md, R14): the
// application's <Options DownloadInvisibleParameters> and its MinEtsVersion decide, where an ETS download shows
// the combination (the captures each rule cites are held in tools/bussard-synthetic.test.ts, tools/etsdiff.test.ts
// and tools/ets-records.test.ts); every other combination refuses where the default and the template differ.

const A = "M-00FA_A-0601-01-0000";
const P = (n: number) => `${A}_P-${n}`;
const R = (n: number) => `${A}_P-${n}_R`;

// P-1 shown (default 1); P-2 in no block; P-3 only in the branch `when test="2"` of a choose on P-1, which the
// defaults reject; P-4 LegacyPatchAlways in no block. Four bytes of template, all zero.
function app(opts: { mask: "MV-07B0" | "MV-0705"; minEts?: string; option?: string; hidden?: number; branch?: number; patch?: number; secondRef?: boolean; colour?: boolean; overlap?: number }): AppConfig {
  const seg = opts.mask === "MV-07B0" ? `${A}_RS-04-00000` : `${A}_AS-0100`;
  const mem = (offset: number) => `<Memory CodeSegment="${seg}" Offset="${offset}" BitOffset="0"/>`;
  const param = (n: number, value: number, extra = "") => `<Parameter Id="${P(n)}" Name="p${n}" ParameterType="${A}_PT-8" Text="p${n}" Value="${value}"${extra}>${mem(n - 1)}</Parameter>`;
  const code = opts.mask === "MV-07B0"
    ? `<RelativeSegment Id="${seg}" Name="main" LoadStateMachine="4" Size="4" Offset="0"><Data>AAAAAA==</Data></RelativeSegment>`
    : `<AbsoluteSegment Id="${seg}" Address="256" Size="4"><Data>AAAAAA==</Data></AbsoluteSegment>`;
  return parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-00FA"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="1537" ApplicationVersion="1" MaskVersion="${opts.mask}"${opts.minEts ? ` MinEtsVersion="${opts.minEts}"` : ""} DefaultLanguage="en-US" Name="Hidden">
<Static>
<Code>${code}</Code>
<ParameterTypes><ParameterType Id="${A}_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType><ParameterType Id="${A}_PT-C"><TypeColor ColorSpace="RGB"/></ParameterType></ParameterTypes>
<Parameters>${param(1, 1)}${param(2, opts.hidden ?? 9)}${param(3, opts.branch ?? 3)}${param(4, opts.patch ?? 4, ' LegacyPatchAlways="true"')}${opts.overlap !== undefined ? `<Parameter Id="${P(6)}" Name="p6" ParameterType="${A}_PT-8" Text="p6" Value="${opts.overlap}">${mem(1)}</Parameter>` : ""}${opts.colour ? `<Parameter Id="${P(5)}" Name="p5" ParameterType="${A}_PT-C" Text="p5" Value="#000000"><Memory CodeSegment="${seg}" Offset="1" BitOffset="0"/></Parameter>` : ""}</Parameters>
<ParameterRefs>${[1, 2, 3, 4, ...(opts.colour ? [5] : []), ...(opts.overlap !== undefined ? [6] : [])].map((n) => `<ParameterRef Id="${R(n)}" RefId="${P(n)}"/>`).join("")}${opts.secondRef ? `<ParameterRef Id="${R(3)}2" RefId="${P(3)}"/>` : ""}</ParameterRefs>
${opts.option ? `<Options DownloadInvisibleParameters="${opts.option}"/>` : ""}
</Static>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="main" Text="Main">
<ParameterRefRef RefId="${R(1)}"/>
<choose ParamRefId="${R(1)}"><when test="2"><ParameterRefRef RefId="${R(3)}"/></when></choose>
</ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
}

const relative = (cfg: AppConfig, skip = false, fullFill?: number) =>
  buildRelativeSegmentTarget(cfg, new Map(), 4, { ownIdleUnionDefaults: true, ...(skip ? { textRefusals: "skip" as const } : {}), ...(fullFill !== undefined ? { fullFill } : {}) })!;
const absolute = (cfg: AppConfig, skip = false) => buildAbsoluteSegmentTargets(cfg, new Map(), skip ? { textRefusals: "skip" } : {})[0];
const hex = (t: { bytes: Buffer }) => t.bytes.toString("hex");
const refused = (what: RegExp) => expect.objectContaining({ code: "PARAM_HIDDEN_UNSUPPORTED", message: expect.stringMatching(what) });

test("the rule: the combinations an ETS download shows, and a refusal for every other", () => {
  const rule = (mask: "MV-07B0" | "MV-0705", option: string | undefined, minEts: string | undefined, rejected: boolean, patchAlways: boolean) => {
    const r = hiddenParameterRule(app({ mask, option, minEts }), { rejected, patchAlways });
    return typeof r === "string" ? r : "refuse";
  };
  const rows: [mask: "MV-07B0" | "MV-0705", option: string | undefined, minEts: string | undefined, rejected: boolean, patchAlways: boolean, expected: string][] = [
    ["MV-07B0", undefined, "5.0", false, false, "default"],
    ["MV-07B0", undefined, "6.0", true, false, "default"],
    ["MV-07B0", undefined, "5.0", false, true, "default"],
    ["MV-07B0", undefined, "4.0", false, false, "template"],
    ["MV-07B0", undefined, "4.0", false, true, "refuse"],
    ["MV-07B0", undefined, "3.0d", false, false, "refuse"],
    ["MV-07B0", undefined, undefined, false, false, "refuse"],
    ["MV-07B0", "None", "5.0", true, false, "template"],
    ["MV-07B0", "None", "5.0", false, false, "refuse"],
    ["MV-07B0", "None", "5.0", false, true, "default"],
    ["MV-07B0", "None", "5.0", true, true, "refuse"],
    ["MV-07B0", "Background", "6.0", false, true, "default"],
    ["MV-07B0", "Background", "6.0", false, false, "refuse"],
    ["MV-07B0", "Background", "6.0", true, false, "refuse"],
    ["MV-07B0", "All", "5.0", false, false, "refuse"],
    ["MV-0705", "Background", undefined, true, false, "template"],
    ["MV-0705", "Background", "3.0d", false, false, "template"],
    ["MV-0705", "Background", "5.0", false, true, "refuse"],
    ["MV-0705", undefined, "6.0", false, false, "default"],
    ["MV-0705", undefined, "5.0", true, false, "default"],
    ["MV-0705", undefined, "4.0", false, false, "template"],
    ["MV-0705", undefined, "3.0f", false, false, "refuse"],
    ["MV-0705", undefined, undefined, false, false, "refuse"],
    ["MV-0705", "None", "5.0", true, false, "refuse"],
  ];
  expect(rows.map((r) => [...r.slice(0, 5), rule(...(r.slice(0, 5) as [never, never, never, never, never]))])).toEqual(rows.map((r) => [...r.slice(0, 5), r[5]]));
});

describe("System B: the relative segment", () => {
  test("no option, MinEtsVersion 5: every hidden parameter at its default, owned", () => {
    const t = relative(app({ mask: "MV-07B0", minEts: "5.0" }));
    expect(hex(t)).toBe("01090304");
    expect(t.owned).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  test("no option, MinEtsVersion 4: the template, not owned", () => {
    const t = relative(app({ mask: "MV-07B0", minEts: "4.0", patch: 0 }));
    expect(hex(t)).toBe("01000000");
    expect(t.owned).toEqual([0xff, 0, 0, 0]);
  });

  test('"None": the rejected parameter at the template, the LegacyPatchAlways one outside a rejected branch at its default', () => {
    const t = relative(app({ mask: "MV-07B0", minEts: "5.0", option: "None", hidden: 0 }));
    expect(hex(t)).toBe("01000004");
    expect(t.owned).toEqual([0xff, 0, 0, 0xff]);
  });

  test("a combination no ETS download shows is refused where the default differs from the template, and only there", () => {
    expect(() => relative(app({ mask: "MV-07B0", minEts: "5.0", option: "None" }))).toThrow(refused(new RegExp(`${R(2)} at offset 1 .*"None"`)));
    expect(() => relative(app({ mask: "MV-07B0", minEts: "6.0", option: "Background" }))).toThrow(refused(/"Background"/));
    expect(() => relative(app({ mask: "MV-07B0" }))).toThrow(refused(/MinEtsVersion not declared/));
    expect(() => relative(app({ mask: "MV-07B0", minEts: "4.0" }))).toThrow(refused(new RegExp(`${R(4)} .*LegacyPatchAlways`)));
    // Where the default is the template's byte, both answers are the same byte.
    expect(hex(relative(app({ mask: "MV-07B0", minEts: "6.0", option: "Background", hidden: 0, branch: 0 })))).toBe("01000004");
  });

  test("a parameter whose refs are hidden in ways ETS writes differently is refused", () => {
    // P-3's first ref lies in the rejected branch (the template under "None"), its second in no block (refused).
    expect(() => relative(app({ mask: "MV-07B0", minEts: "5.0", option: "None", hidden: 0, secondRef: true }))).toThrow(refused(new RegExp(`${R(3)}`)));
    expect(hex(relative(app({ mask: "MV-07B0", minEts: "5.0", option: "None", hidden: 0 })))).toBe("01000004");
  });

  test("two hidden parameters on the same bits: one default where they agree, refused where they differ", () => {
    // P-6 lies on P-2's byte, in no block.
    expect(hex(relative(app({ mask: "MV-07B0", minEts: "5.0", overlap: 9 })))).toBe("01090304");
    expect(() => relative(app({ mask: "MV-07B0", minEts: "5.0", overlap: 7 }))).toThrow(refused(/another hidden parameter's default on the same bits differs/));
  });

  test("the read-back leaves such a parameter unowned instead of refusing", () => {
    const t = relative(app({ mask: "MV-07B0" }), true);
    expect(hex(t)).toBe("01000000");
    expect(t.owned).toEqual([0xff, 0, 0, 0]);
  });

  test("dataless RelativeSegment with fullFill=255 refuses an unknown hidden rule whose default differs from 0xFF on an unowned byte, without affecting partial/par builds", () => {
    const dataless = (hiddenVal: number, opts: { shareByte?: boolean; hsvColor?: boolean } = {}) => parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-00FA"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="1537" ApplicationVersion="1" MaskVersion="MV-07B0" MinEtsVersion="5.0" DefaultLanguage="en-US" LoadProcedureStyle="MergedProcedure" Name="DatalessHidden">
<Static>
<Code><RelativeSegment Id="${A}_RS-04-00000" Name="main" LoadStateMachine="4" Size="4" Offset="0"/></Code>
<ParameterTypes>
  <ParameterType Id="${A}_PT-1"><TypeNumber SizeInBit="1" Type="unsignedInt" minInclusive="0" maxInclusive="1"/></ParameterType>
  <ParameterType Id="${A}_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType>
  <ParameterType Id="${A}_PT-HSV"><TypeColor ColorSpace="HSV"/></ParameterType>
</ParameterTypes>
<Parameters>
  <Parameter Id="${P(1)}" Name="p1" ParameterType="${opts.shareByte ? `${A}_PT-1` : `${A}_PT-8`}" Text="p1" Value="1"><Memory CodeSegment="${A}_RS-04-00000" Offset="0" BitOffset="0"/></Parameter>
  <Parameter Id="${P(2)}" Name="p2" ParameterType="${opts.hsvColor ? `${A}_PT-HSV` : opts.shareByte ? `${A}_PT-1` : `${A}_PT-8`}" Text="p2" Value="${opts.hsvColor ? "#000000" : hiddenVal}"><Memory CodeSegment="${A}_RS-04-00000" Offset="${opts.shareByte ? 0 : 1}" BitOffset="${opts.shareByte ? 1 : 0}"/></Parameter>
</Parameters>
<ParameterRefs><ParameterRef Id="${R(1)}" RefId="${P(1)}"/><ParameterRef Id="${R(2)}" RefId="${P(2)}"/></ParameterRefs>
<LoadProcedures><LoadProcedure MergeId="2"><LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="4" Mode="1" Fill="255"/></LoadProcedure></LoadProcedures>
<Options DownloadInvisibleParameters="None"/>
</Static>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="main" Text="Main"><ParameterRefRef RefId="${R(1)}"/></ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
    // Full download (fullFill=0xFF): unowned byte holds 0xFF, so hidden default 0 refuses and 255 agrees.
    expect(() => relative(dataless(0), false, 0xff)).toThrow(refused(new RegExp(`${R(2)} at offset 1`)));
    expect(hex(relative(dataless(255), false, 0xff))).toBe("01000000");
    // Partial/par build (no fullFill): keeps 0x00 template comparison (0 agrees, 255 refuses).
    expect(hex(relative(dataless(0)))).toBe("01000000");
    expect(() => relative(dataless(255))).toThrow(refused(new RegExp(`${R(2)} at offset 1`)));
    // Byte 0 is already owned by active p1 (bit 0 -> 0x80), so its unowned bits are 0: hidden bit 1 = 0 agrees, 1 refuses.
    expect(hex(relative(dataless(0, { shareByte: true }), false, 0xff))).toBe("80000000");
    expect(() => relative(dataless(1, { shareByte: true }), false, 0xff)).toThrow(refused(new RegExp(`${R(2)} at offset 0`)));
    // A zero-width unencodable memory type (HSV TypeColor) with an unknown hidden rule is still refused, never skipped.
    expect(() => relative(dataless(0, { hsvColor: true }), false, 0xff)).toThrow(refused(new RegExp(`${R(2)} at offset 1`)));
    expect(() => relative(dataless(0, { hsvColor: true }))).toThrow(refused(new RegExp(`${R(2)} at offset 1`)));
  });
});

describe("System 7: the absolute segment", () => {
  test("no option, MinEtsVersion 5 or later: every hidden parameter at its default, unowned like the <Data> around it", () => {
    const t = absolute(app({ mask: "MV-0705", minEts: "6.0", patch: 0 }));
    expect(hex(t)).toBe("01090300");
    expect(t.owned).toEqual([0xff, 0, 0, 0]);
    // The image's bits a parameter flash writes where no active parameter lies, and guards on a project not known
    // to hold the parameters without memory (refuseHiddenBytes).
    expect(t.dataBits).toEqual([0, 0xff, 0xff, 0xff]);
    // Still hidden bits for the read-back's comparison: the configuration does not show them.
    expect(t.hidden).toEqual([0, 0xff, 0xff, 0xff]);
  });

  test('"Background", or no option at MinEtsVersion 4: the template, not owned', () => {
    for (const cfg of [app({ mask: "MV-0705", option: "Background", patch: 0 }), app({ mask: "MV-0705", minEts: "4.0", patch: 0 })]) {
      const t = absolute(cfg);
      expect(hex(t)).toBe("01000000");
      expect(t.owned).toEqual([0xff, 0, 0, 0]);
    }
  });

  test("a combination no ETS download shows is refused where the default differs from the template; the read-back skips it", () => {
    expect(() => absolute(app({ mask: "MV-0705", minEts: "5.0", option: "None", patch: 0 }))).toThrow(refused(new RegExp(`${R(2)} at offset 1 of ${A}_AS-0100`)));
    expect(() => absolute(app({ mask: "MV-0705", patch: 0 }))).toThrow(refused(/MinEtsVersion not declared/));
    expect(() => absolute(app({ mask: "MV-0705", option: "Background" }))).toThrow(refused(new RegExp(`${R(4)} .*LegacyPatchAlways`)));
    // Two hidden parameters on the same bits (P-6 on P-2's byte) whose defaults differ.
    expect(hex(absolute(app({ mask: "MV-0705", minEts: "6.0", patch: 0, overlap: 9 })))).toBe("01090300");
    expect(() => absolute(app({ mask: "MV-0705", minEts: "6.0", patch: 0, overlap: 7 }))).toThrow(refused(/another hidden parameter's default on the same bits differs/));
    // A colour hidden on the bits of no active parameter: no ETS download shows it at its default.
    expect(() => absolute(app({ mask: "MV-0705", minEts: "6.0", patch: 0, colour: true }))).toThrow(refused(new RegExp(`${R(5)} .*colour`)));
    const t = absolute(app({ mask: "MV-0705" }), true);
    expect(hex(t)).toBe("01000000");
    expect(t.owned).toEqual([0xff, 0, 0, 0]);
  });
});
