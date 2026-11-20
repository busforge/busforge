import { expect, test } from "bun:test";
import { countedMismatches, countMismatches, projectsToRecord, tally } from "./ets-records.ts";

// What tools/ets-records.ts records in one call, and how a moved count names the projects behind it. No
// corpus is read: the paths are invented.

const onDisk = [
  "captures/a.knxproj",
  "captures/ets-sweep/one/export.knxproj",
  "captures/ets-sweep/two/export.knxproj",
  "internal/captures/b.knxproj",
];

test("--missing records the projects the file lacks and no recorded one", () => {
  const recorded = new Set(["captures/a.knxproj", "captures/ets-sweep/one/export.knxproj"]);
  expect(projectsToRecord(onDisk, recorded, [], true)).toEqual(["captures/ets-sweep/two/export.knxproj", "internal/captures/b.knxproj"]);
});

test("--missing with a directory takes only the projects under it", () => {
  expect(projectsToRecord(onDisk, new Set(), ["captures/ets-sweep"], true)).toEqual(["captures/ets-sweep/one/export.knxproj", "captures/ets-sweep/two/export.knxproj"]);
  expect(projectsToRecord(onDisk, new Set(), ["captures/ets-sweep/"], true)).toEqual(["captures/ets-sweep/one/export.knxproj", "captures/ets-sweep/two/export.knxproj"]);
  // A directory name is a whole path component: "captures/ets" is not "captures/ets-sweep".
  expect(() => projectsToRecord(onDisk, new Set(), ["captures/ets"], true)).toThrow("holds no project under captures/ets");
});

test("--missing with everything recorded records nothing", () => {
  expect(projectsToRecord(onDisk, new Set(onDisk), [], true)).toEqual([]);
});

test("--missing refuses a project and a directory without projects", () => {
  expect(() => projectsToRecord(onDisk, new Set(), ["captures/a.knxproj"], true)).toThrow("--missing takes corpus directories");
  expect(() => projectsToRecord(onDisk, new Set(), ["nowhere"], true)).toThrow("holds no project under nowhere");
});

test("named projects are recorded again, recorded or not, and one the corpus lacks is refused", () => {
  expect(projectsToRecord(onDisk, new Set(onDisk), ["captures/a.knxproj"], false)).toEqual(["captures/a.knxproj"]);
  expect(() => projectsToRecord(onDisk, new Set(), ["captures/typo.knxproj"], false)).toThrow("not a project of the corpus: captures/typo.knxproj");
});

test("a moved count names the projects behind it with their share, and an equal one nothing", () => {
  const byProject = tally(["p/x.knxproj", "p/x.knxproj", "p/y.knxproj", "p/z.knxproj"]);
  expect(countMismatches([{ what: "records", found: 4, pinned: 4, byProject }])).toEqual([]);
  const [message] = countMismatches([{ what: "records", found: 4, pinned: 3, byProject }]);
  expect(message).toBe("records: found 4, pinned 3 (+1). The corpus projects behind the found count, with their share:\n  p/x.knxproj: 2\n  p/y.knxproj: 1\n  p/z.knxproj: 1");
  expect(countMismatches([{ what: "bytes", found: 0, pinned: 5, byProject: new Map() }])[0]).toContain("(-5)");
});

test("a moved named entry names the projects that show it, a gone one says so, an equal one nothing", () => {
  const found = [
    { what: "app not loaded: links", project: "p/x.knxproj" },
    { what: "app not loaded: links", project: "p/y.knxproj" },
    { what: "app not loaded: links", project: "p/y.knxproj" },
    { what: "app refused: CODE", project: "p/z.knxproj" },
  ];
  expect(countedMismatches(found, ["app not loaded: links (3 projects)", "app refused: CODE (1 project)"])).toEqual([]);
  expect(countedMismatches(found, ["app not loaded: links (2 projects)", "app refused: CODE (1 project)", "app gone: links (1 project)"])).toEqual([
    "app gone: links: found 0, pinned 1. No project shows it any more.",
    "app not loaded: links: found 3, pinned 2. The corpus projects behind the found entries, with their number:\n  p/x.knxproj: 1\n  p/y.knxproj: 2",
  ]);
  expect(countedMismatches(found, ["app not loaded: links (3 projects)"])).toEqual([
    "app refused: CODE: found 1, pinned no such entry. The corpus projects behind the found entries, with their number:\n  p/z.knxproj: 1",
  ]);
});
