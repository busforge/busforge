import { test, expect, describe } from "bun:test";
import { addLink, addedLinks, makeSender, removeLink, replaceOnly } from "./links.ts";

// A com-object's group addresses, in order: the first is the address it sends on.
describe("editing a com-object's group addresses", () => {
  test("replacing the only address, or clearing it, is one step", () => {
    expect(replaceOnly(7)).toEqual([7]);
    expect(replaceOnly(null)).toEqual([]);
  });
  test("an added address goes behind the others; one already there changes nothing", () => {
    expect(addLink([3, 5], 9)).toEqual([3, 5, 9]);
    expect(addLink([3, 5], 5)).toEqual([3, 5]);
  });
  test("removing an address drops only that one; removing the sending address makes the next one send", () => {
    expect(removeLink([3, 5, 9], 5)).toEqual([3, 9]);
    expect(removeLink([3, 5, 9], 3)).toEqual([5, 9]);
  });
  test("choosing the sending address moves it first and keeps the others in their order", () => {
    expect(makeSender([3, 5, 9], 9)).toEqual([9, 3, 5]);
    expect(makeSender([3, 5, 9], 3)).toEqual([3, 5, 9]);
  });
  test("the addresses an edit adds", () => {
    expect(addedLinks([3, 5], [9, 3, 5, 11])).toEqual([9, 11]);
    expect(addedLinks([3, 5], [5])).toEqual([]);
  });
});
