import { test, expect, describe } from "bun:test";
import { judgeWeather, parseWeatherGuard, type WeatherGuard } from "./guard.ts";

const ARG = "wind:31/7/230:12,rain:31/7/231,wind alarm:31/7/232,awning lock:31/7/233";
const guard = parseWeatherGuard(ARG) as WeatherGuard;
// DPT 9 raw values: 0x00c8 = 2 m/s, 0x0347 = 8.39 m/s, 0x0348 = 8.4 m/s (70 % of 12).
const calm = (over: Record<string, string | null> = {}) => new Map<string, string | null>(Object.entries({ "31/7/230": "00c8", "31/7/231": "00", "31/7/232": "00", "31/7/233": "00", ...over }));

describe("the weather guard's addresses", () => {
  test("the operator names the wind address with its alarm threshold and any number of 1-bit addresses", () => {
    expect(guard).toEqual({ wind: { ga: "31/7/230", thresholdMs: 12 }, bits: [{ name: "rain", ga: "31/7/231" }, { name: "wind alarm", ga: "31/7/232" }, { name: "awning lock", ga: "31/7/233" }] });
  });

  test("a guard without the wind, a usable threshold, or with an address that is not one is refused", () => {
    for (const [arg, why] of [
      ["rain:31/7/231", "no wind address"],
      ["wind:31/7/230", "gives no threshold"],
      ["wind:31/7/230:0", "gives no threshold"],
      ["wind:31/7/230:nine", "gives no threshold"],
      ["wind:31/7/230:Infinity", "gives no threshold"],
      ["wind:31/7/230:61", "above 60 m/s"],
      ["wind:31/7/230:12,rain:31/7", "is not <name>:<main/middle/sub>"],
      ["wind:31/7/230:12,rain:31/7/231:1", "is not <name>:<main/middle/sub>"],
      ["wind:31/7/230:12,rain:31/7/230", "31/7/230 is named twice"],
      ["wind:31/7/230:12,wind:31/7/234:12", "wind is named twice"],
      ["wind:32/0/1:12", "is not <name>:<main/middle/sub>"],
      ["wind:31/8/1:12", "is not <name>:<main/middle/sub>"],
      ["wind:31/7/256:12", "is not <name>:<main/middle/sub>"],
    ] as const) expect((parseWeatherGuard(arg) as { refused: string }).refused).toContain(why);
  });
});

describe("what the weather guard's reads allow", () => {
  test("calm wind and every bit 0 pass, each value named", () => {
    expect(judgeWeather(guard, calm())).toEqual({ pass: true, detail: "wind 2 m/s (limit 8.4), rain 0, wind alarm 0, awning lock 0" });
    expect(judgeWeather(guard, calm({ "31/7/230": "0347" })).pass).toBe(true);
  });

  test("wind at 70 % of the alarm threshold stops the run", () => {
    const v = judgeWeather(guard, calm({ "31/7/230": "0348" }));
    expect(v.pass).toBe(false);
    expect(v.detail).toContain("wind 8.4 m/s is at or above 70 % of the alarm threshold 12 m/s");
  });

  test("any bit set stops the run, rain included", () => {
    for (const ga of ["31/7/231", "31/7/232", "31/7/233"]) {
      const v = judgeWeather(guard, calm({ [ga]: "01" }));
      expect(v.pass).toBe(false);
      expect(v.detail).toContain(`(${ga}) is set`);
    }
  });

  test("an address the station does not answer, or answers with what its type cannot carry, stops the run", () => {
    expect(judgeWeather(guard, calm({ "31/7/230": null })).detail).toContain("wind (31/7/230) did not answer from the station");
    expect(judgeWeather(guard, calm({ "31/7/233": null })).detail).toContain("awning lock (31/7/233) did not answer from the station");
    expect(judgeWeather(guard, calm({ "31/7/230": "7fff" })).detail).toContain("not a 2-byte float");
    expect(judgeWeather(guard, calm({ "31/7/230": "01" })).detail).toContain("not a 2-byte float");
    expect(judgeWeather(guard, calm({ "31/7/231": "02" })).detail).toContain("not a 1-bit value");
    expect(judgeWeather(guard, new Map()).pass).toBe(false);
  });
});
