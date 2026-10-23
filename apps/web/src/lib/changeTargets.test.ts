import { test, expect, describe } from "bun:test";
import { changeRemedies } from "./changeTargets.ts";

describe("what each state mark of the device header opens", () => {
  test("pending edits open the flash of every target the device offers", () => {
    expect(changeRemedies(["params", "ga"], true).changes).toEqual({ open: "flash", targets: ["params", "ga"] });
    expect(changeRemedies(["params"], false).changes).toEqual({ open: "flash", targets: ["params"] });
  });

  test("a never-programmed device opens the flash, which offers the full download, also where commissioning exists", () => {
    expect(changeRemedies(["params", "ga"], true).never).toEqual({ open: "flash", targets: ["params", "ga"] });
    expect(changeRemedies(["ga"], false).never).toEqual({ open: "flash", targets: ["ga"] });
  });

  test("commissioning only where nothing can be flashed but a full download can be run", () => {
    expect(changeRemedies([], true).never).toEqual({ open: "commission" });
  });

  test("a security object opens the group-address flash only", () => {
    expect(changeRemedies(["params", "ga"], true).security).toEqual({ open: "flash", targets: ["ga"] });
    expect(changeRemedies(["params"], true).security).toBeUndefined();
  });

  test("a device that offers no remedy leaves every mark plain", () => {
    expect(changeRemedies([], false)).toEqual({ never: undefined, changes: undefined, security: undefined });
  });
});
