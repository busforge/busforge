import { test, expect, describe } from "bun:test";
import { isFiltering, withoutFilters } from "./deviceFilters.ts";

describe("the device list's filters", () => {
  test("are on for a search term or the to-program toggle, not for spaces or the building shown", () => {
    expect(isFiltering({ q: "Bad" })).toBe(true);
    expect(isFiltering({ changed: true })).toBe(true);
    expect(isFiltering({ q: "  " })).toBe(false);
    expect(isFiltering({ b: "2" })).toBe(false);
  });

  test("reset clears search and toggle and keeps the building shown", () => {
    expect(withoutFilters({ q: "Bad", changed: true, b: "2" })).toEqual({ q: undefined, changed: undefined, b: "2" });
  });
});
