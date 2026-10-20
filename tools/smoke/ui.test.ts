import { test, expect } from "bun:test";
import { namesAddress, displayNameShown, pageLanguage } from "./ui.ts";

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

test("a display parameter's row shows its name, line breaks rendered as the browser gives them", () => {
  const name = "Light independent feedback objects\n(independent of blocking object)";
  expect(displayNameShown("Light independent feedback objects\n(independent of blocking object)\n", null, name)).toBe("text");
});

test("a grid cell that carries the name only as its tooltip is told apart, as is a parameter without a name", () => {
  expect(displayNameShown("", "Light independent feedback objects (independent of blocking object)", "Light independent feedback objects\n(independent of blocking object)")).toBe("tooltip");
  expect(displayNameShown("", null, "   ")).toBe("blank");
});

test("a display parameter's row that shows something else, or nothing, does not pass", () => {
  expect(displayNameShown("Light dependent feedback objects", null, "Light independent feedback objects")).toBeNull();
  expect(displayNameShown("", null, "Auro KNX app v1.1")).toBeNull();
  expect(displayNameShown("", "", "Auro KNX app v1.1")).toBeNull();
});

test("the click-through takes the page's own language, and refuses a page that names none it knows", () => {
  expect(pageLanguage("en")).toBe("en");
  expect(pageLanguage("de")).toBe("de");
  for (const l of ["", "fr", "en-US"]) expect(() => pageLanguage(l)).toThrow("names no language");
});
