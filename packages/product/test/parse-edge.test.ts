import { test, expect, describe } from "bun:test";
import { parseAppConfig } from "../src/appconfig.ts";
import { parseApplication } from "../src/application.ts";
import { buildParameterImage, decodeParameterImage } from "../src/image.ts";

// Edge / malformed input behavior for the parser. Pins the cases that already
// degrade gracefully (empty model, skipped dangling refs, the segment-Data
// attribute fallback). Crash-prone malformed inputs (a Memory with no Offset, a
// segment with no Size) are tracked for the image.ts resilience hardening, not here.

const wrap = (inner: string) =>
  `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-1"><ApplicationPrograms>${inner}</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

describe("missing structure", () => {
  test("no ApplicationProgram throws a clear error", () => {
    expect(() => parseAppConfig("")).toThrow(/ApplicationProgram/);
    expect(() => parseAppConfig("<KNX></KNX>")).toThrow(/ApplicationProgram/);
    expect(() => parseApplication("<KNX></KNX>")).toThrow(/ApplicationProgram/);
  });

  test("an ApplicationProgram with no Static yields an empty, non-throwing model", () => {
    const xml = wrap(`<ApplicationProgram Id="M-1_A-1" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-1"/>`);
    const app = parseAppConfig(xml);
    expect(app.types.size).toBe(0);
    expect(app.params.size).toBe(0);
    expect(app.segments).toHaveLength(0);
    const model = parseApplication(xml);
    expect(model.params.size).toBe(0);
  });
});

describe("dangling references", () => {
  const xml = wrap(`<ApplicationProgram Id="M-1_A-1" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-1"><Static>
    <ParameterTypes><ParameterType Id="T"><TypeNumber SizeInBit="8"/></ParameterType></ParameterTypes>
    <Parameters><Parameter Id="P" ParameterType="T" Value="7"><Memory CodeSegment="S" Offset="0" BitOffset="0"/></Parameter></Parameters>
    <ParameterRefs>
      <ParameterRef Id="P_R" RefId="P"/>
      <ParameterRef Id="GHOST_R" RefId="P-does-not-exist"/>
    </ParameterRefs>
    <Code><RelativeSegment Id="S" LoadStateMachine="4" Size="4"><Data>AAAAAA==</Data></RelativeSegment></Code>
  </Static></ApplicationProgram>`);

  test("a ParameterRef pointing at a missing param is skipped, not fatal", () => {
    const model = parseApplication(xml);
    const img = buildParameterImage(model, 4, new Map());
    expect(img[0]).toBe(7); // the real ref placed
    const decoded = decodeParameterImage(model, 4, img);
    expect(decoded.get("P_R")).toBe("7");
    expect(decoded.has("GHOST_R")).toBe(false); // dangling ref produced nothing
  });
});

describe("segment Data as an attribute (older-catalogue form)", () => {
  test("attrOrText reads Data from an attribute, equivalent to the child element", () => {
    const asAttr = wrap(`<ApplicationProgram Id="M-1_A-1" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-1"><Static>
      <Code><RelativeSegment Id="S" LoadStateMachine="4" Size="4" Data="AQIDBA=="/></Code></Static></ApplicationProgram>`);
    const model = parseApplication(asAttr);
    expect(model.segments[0].data.toString("hex")).toBe("01020304");
  });
});
