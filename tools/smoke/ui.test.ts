import { test, expect } from "bun:test";
import { namesAddress } from "./ui.ts";

test("names a group address in a remove button's label, in either language", () => {
  expect(namesAddress("1/3/2 entfernen", "1/3/2")).toBe(true);
  expect(namesAddress("Remove 1/3/2", "1/3/2")).toBe(true);
});

test("does not take a longer address for the one asked", () => {
  expect(namesAddress("1/3/21 entfernen", "1/3/2")).toBe(false);
  expect(namesAddress("Remove 11/3/2", "1/3/2")).toBe(false);
});

test("cannot read an address from a list row's text, which runs the address's name and the address together", () => {
  // The device page's row for "1/3/2" named "smoke 1/3/2": its text as the browser gives it.
  expect(namesAddress("smoke 1/3/21/3/2", "1/3/2")).toBe(false);
});
