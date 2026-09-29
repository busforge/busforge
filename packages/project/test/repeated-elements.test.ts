import { test, expect, describe } from "bun:test";
import { parseProject, deviceParamValues } from "../src/parse.ts";

// fast-xml-parser turns a REPEATED element into an array and a lone one into a bare object. Every
// fixture in this directory has exactly one <Line>, so `Line` is never an array in them, and for a
// while nothing here noticed that the document walkers had stopped descending into arrays: a real
// project (two lines, two areas, two group ranges) imported every device with zero parameters, zero
// links and zero security, reported zero of each, and would then have been flashed with the
// application's DEFAULTS instead of the ETS configuration. Silently.
//
// So this file is the one that keeps an array on the path to everything that matters.
const twoLinesTwoRanges = `<?xml version="1.0"?>
<KNX>
  <Project>
    <Installation Name="Repeated">
      <Topology>
        <Area Id="A-1" Address="1" Name="Area 1">
          <Line Id="L-1" Address="1" Name="Line 1">
            <DeviceInstance Id="D-1" Address="11" Name="Dev 1" ProductRefId="M-0083_H-1_P-a" Hardware2ProgramRefId="M-0083_H-1_HP-a">
              <ParameterInstanceRefs>
                <ParameterInstanceRef RefId="M-0083_A-1_P-1_R-1" Value="7"/>
              </ParameterInstanceRefs>
              <ComObjectInstanceRefs>
                <ComObjectInstanceRef RefId="M-0083_A-1_O-1_R-1" Links="GA-1"/>
              </ComObjectInstanceRefs>
            </DeviceInstance>
          </Line>
          <Line Id="L-2" Address="2" Name="Line 2">
            <DeviceInstance Id="D-2" Address="22" Name="Dev 2" ProductRefId="M-0048_H-1_P-b" Hardware2ProgramRefId="M-0048_H-1_HP-b" SerialNumber="AAECAwQF">
              <ParameterInstanceRefs>
                <ParameterInstanceRef RefId="M-0048_A-1_P-9_R-9" Value="42"/>
              </ParameterInstanceRefs>
              <ComObjectInstanceRefs>
                <ComObjectInstanceRef RefId="M-0048_A-1_O-9_R-9" Links="GA-2"/>
              </ComObjectInstanceRefs>
              <Security ToolKey="dG9vbA==" SequenceNumber="5"/>
            </DeviceInstance>
          </Line>
        </Area>
      </Topology>
      <GroupAddresses>
        <GroupRanges>
          <GroupRange Id="R-1" Name="Range 1" RangeStart="1" RangeEnd="2047">
            <GroupAddress Id="P-1_GA-1" Address="2049" Name="Light" DatapointType="DPST-1-1"/>
          </GroupRange>
          <GroupRange Id="R-2" Name="Range 2" RangeStart="2048" RangeEnd="4095">
            <GroupAddress Id="P-1_GA-2" Address="2050" Name="Blind" DatapointType="DPST-1-8"/>
          </GroupRange>
        </GroupRanges>
      </GroupAddresses>
    </Installation>
  </Project>
</KNX>`;

describe("a document whose path crosses a repeated element (an ARRAY, not an object)", () => {
  const p = parseProject(twoLinesTwoRanges, undefined, "fallback");

  test("both lines' devices are found", () => {
    expect(p.devices.map((d) => d.ia)).toEqual(["1.1.11", "1.2.22"]);
    expect(p.malformedDevices).toBe(0);
  });

  // The three below are what a stalled walker silently zeroes out. Each one is the difference
  // between programming a device with its ETS configuration and programming it with the
  // application's defaults, and neither the import nor the UI would have said a word.
  test("every device keeps its parameters (buildGaIdMap/findDeviceInstance descend into the Line array)", () => {
    expect(p.deviceParams).toEqual([
      { deviceId: "D-1", values: [{ refId: "M-0083_A-1_P-1_R-1", value: "7" }] },
      { deviceId: "D-2", values: [{ refId: "M-0048_A-1_P-9_R-9", value: "42" }] },
    ]);
  });

  test("every device keeps its group-address links, across BOTH group ranges", () => {
    expect(p.deviceLinks).toEqual([
      { deviceId: "D-1", links: [{ comObjRefId: "M-0083_A-1_O-1_R-1", gaRaws: [2049] }] },
      { deviceId: "D-2", links: [{ comObjRefId: "M-0048_A-1_O-9_R-9", gaRaws: [2050] }] },
    ]);
    // A link that resolved to nothing is the OTHER way this fails, and it must stay zero: a
    // stalled buildGaIdMap resolves no GA at all and dumps every link into this counter.
    expect(p.unresolvedLinks).toBe(0);
  });

  test("a secure device in the second line is still seen as secure", () => {
    expect(p.deviceSecurity).toEqual([
      { deviceId: "D-2", toolKey: "dG9vbA==", serialNumber: "AAECAwQF", sequenceNumber: "5" },
    ]);
  });

  test("deviceParamValues (the hardware read-back harnesses' entry point) finds a device behind the array", () => {
    // tools/readback.ts and tools/dump-param-memory.ts call this. A stalled walker makes it THROW,
    // which at least fails loudly, but only for the tools; the import above fails silently.
    expect(deviceParamValues(twoLinesTwoRanges, "D-2").values.get("M-0048_A-1_P-9_R-9")).toBe("42");
  });
});

// The other shape the walkers have to survive: a value that is an ELEMENT where an attribute was
// expected. ETS does not emit this, but a hand-edited or third-party export can, and the old code
// ran String() over it and got the literal "[object Object]" — a device name, a product ref, a
// group-address style, all silently that string. The narrowing helpers exist to make that
// impossible, and nothing pinned it.
describe("an element where an attribute was expected yields nothing, never \"[object Object]\"", () => {
  const elementShaped = `<?xml version="1.0"?>
<KNX>
  <Project>
    <Installation Name="Odd">
      <Topology>
        <Area Id="A-1" Address="1">
          <Line Id="L-1" Address="1">
            <DeviceInstance Id="D-1" Address="11" ProductRefId="M-0083_H-1_P-a">
              <Name><Odd/></Name>
            </DeviceInstance>
          </Line>
        </Area>
      </Topology>
    </Installation>
  </Project>
</KNX>`;

  test("a device whose Name is an element imports with an empty name, not a stringified object", () => {
    const d = parseProject(elementShaped, undefined, "fallback").devices[0];
    expect(d.name).toBe("");            // and specifically NOT "[object Object]"
    expect(d.ia).toBe("1.1.11");        // the rest of the device still parses
  });

  test("an element-shaped GroupAddressStyle falls back to three levels rather than matching nothing by accident", () => {
    // String({}) already fell through to the default here, so this pins the BEHAVIOUR, not a fix:
    // it must keep falling through, and it must do so because the value is not a style name.
    expect(parseProject(elementShaped, undefined, "fallback").groupAddressLevels).toBe(3);
  });
});
