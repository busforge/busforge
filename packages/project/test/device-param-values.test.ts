import { test, expect } from "bun:test";
import { deviceParamValues } from "../src/parse.ts";

// deviceParamValues is the 0.xml stored-value extraction feeding every flash (the
// device's ParameterInstanceRef Values are the instance overrides laid over the
// catalogue defaults). Pin its contract on a hand-written 0.xml fragment shaped like
// a decrypted ETS project file (Project > Installations > Installation > Topology,
// the same nesting the packages/project fixtures use; the function finds
// DeviceInstance nodes recursively, so only the element names matter).
//
// DI-1 carries three ParameterInstanceRefs: a normal top-level ref, a
// module-instance ref (ETS stores module values as plain ParameterInstanceRefs whose
// RefId carries the ..._MD-x_M-y_MI-z_... instance id, there is no separate element),
// and one WITHOUT a Value attribute (an ETS "touched but default" marker) which must
// be absent from the result, not mapped to "" or "undefined".
// DI-2 has a single ParameterInstanceRef (exercises the parser's non-array branch).
// DI-3 has no ParameterInstanceRefs at all (empty map, appRef still extracted).
const xml0 = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23">
  <Project Id="P-01AB">
    <Installations>
      <Installation Name="Test">
        <Topology>
          <Area Id="P-01AB-0_A-1" Address="1">
            <Line Id="P-01AB-0_L-1" Address="1">
              <DeviceInstance Id="P-01AB-0_DI-1" Address="10" Hardware2ProgramRefId="M-TEST_H-1_HP-1">
                <ParameterInstanceRefs>
                  <ParameterInstanceRef RefId="M-TEST_A-1_P-1_R-1" Value="42" />
                  <ParameterInstanceRef RefId="M-TEST_A-1_MD-2_M-3_MI-1_P-5_R-5" Value="7" />
                  <ParameterInstanceRef RefId="M-TEST_A-1_P-9_R-9" />
                </ParameterInstanceRefs>
              </DeviceInstance>
              <DeviceInstance Id="P-01AB-0_DI-2" Address="11" Hardware2ProgramRefId="M-TEST_H-2_HP-2">
                <ParameterInstanceRefs>
                  <ParameterInstanceRef RefId="M-TEST_A-2_P-1_R-1" Value="0" />
                </ParameterInstanceRefs>
              </DeviceInstance>
              <DeviceInstance Id="P-01AB-0_DI-3" Address="12" Hardware2ProgramRefId="M-TEST_H-3_HP-3" />
            </Line>
          </Area>
        </Topology>
      </Installation>
    </Installations>
  </Project>
</KNX>`;

test("extracts top-level and module-instance values, skips Value-less refs", () => {
  const { appRef, values } = deviceParamValues(xml0, "P-01AB-0_DI-1");
  expect(appRef).toBe("M-TEST_H-1_HP-1");
  // Hand-written expectation: exactly the two refs that carry a Value attribute.
  expect(values).toEqual(new Map([
    ["M-TEST_A-1_P-1_R-1", "42"],
    ["M-TEST_A-1_MD-2_M-3_MI-1_P-5_R-5", "7"],
  ]));
});

test("a single ParameterInstanceRef (non-array XML shape) still yields its entry", () => {
  // fast-xml-parser returns a lone child as an object, not a one-element array;
  // "0" must survive as a string value, not be dropped as falsy.
  const { values } = deviceParamValues(xml0, "P-01AB-0_DI-2");
  expect(values).toEqual(new Map([["M-TEST_A-2_P-1_R-1", "0"]]));
});

test("a device without ParameterInstanceRefs yields an empty map, appRef intact", () => {
  const { appRef, values } = deviceParamValues(xml0, "P-01AB-0_DI-3");
  expect(appRef).toBe("M-TEST_H-3_HP-3");
  expect(values.size).toBe(0);
});

test("an unknown device id throws (no silent empty result for a bogus target)", () => {
  expect(() => deviceParamValues(xml0, "P-01AB-0_DI-99")).toThrow("device P-01AB-0_DI-99 not found");
});
