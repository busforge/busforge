import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { KnxDevice } from "../packages/knx/src/index.ts";
import { collectDevice, toDiagnosticPackage, type CollectPackage, type CollectRecord } from "../packages/product/src/index.ts";
import { SimSystemB } from "../packages/product/test/collect-sim.ts";
import { corpusRoot } from "./corpus.ts";
import { corpusTest } from "./corpus-test.ts";
import {
  asReference, checkPackage, contentHoldsRun, distinctiveRuns, hexDigits, holdsRun, IntakeRefused, loadReceived, MAX_PACKAGE_BYTES, receive, removeReceived,
  trackedFiles, type IntakeDetails, type Provenance,
} from "./received.ts";

// Every package here is synthetic: made by Busforge's own cleaning (toDiagnosticPackage) from an
// invented collector package, with documentation addresses and made-up bytes.

const rec = (r: Partial<CollectRecord>): CollectRecord => ({ step: "scan", space: "property", target: {}, source: "device", outcome: "bytes", at: 1, ...r });
const MEMORY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

function collected(over: Partial<CollectPackage> = {}): CollectPackage {
  return {
    format: "busforge-raw-collect/1", ia: "1.2.3", mask: "MV-07B0", family: "system-b", secured: false, authorizeLevel: 0, maxApdu: 55,
    plan: null,
    records: [
      rec({ step: "descriptor", space: "descriptor", target: { type: 0 }, bytes: "07b0" }),
      rec({ step: "identity", target: { object: 0, pid: 11, start: 1, count: 1 }, source: "master-data", bytes: "00fa01020304" }),
      rec({ step: "scan", space: "property-description", target: { object: 0, propertyIndex: 0 }, description: { objectIndex: 0, pid: 1, propertyIndex: 0, writable: false, pdt: 4, maxElements: 1, readLevel: 3, writeLevel: 0 } }),
      rec({ step: "memory", space: "memory", target: { address: 0x4000, length: 32 }, source: "master-data", bytes: MEMORY }),
      rec({ step: "memory", space: "memory", target: { address: 0xb800, length: 1 }, source: "master-data", outcome: "refused", raw: "00", detail: "count 0 from 198.51.100.10:3671" }),
    ],
    limits: [], stop: null,
    counts: { requests: 5, scanRequests: 1, memoryRequests: 2, memoryBytes: 32, reconnects: 0 }, startedAt: 10, finishedAt: 20,
    ...over,
  };
}
const diagnostic = (over: Partial<CollectPackage> = {}) => toDiagnosticPackage(collected(over), {
  busforge: { version: "0.0.1", commit: "abc1234" }, connection: { kind: "ip", ipTransport: "tcp" }, error: null,
  bus: { takenAt: 9, monitorClosedAt: null, releasedAt: 21 }, secrets: ["198.51.100.10"],
});
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

const DETAILS: IntakeDetails = {
  from: "reporter of the synthetic issue, by the private transfer", issue: "busforge/busforge#0",
  consent: { statement: "kept for internal regression tests, deleted on request", givenAt: "2026-10-05" },
  origin: { configuredBy: "ets", priorBusforgeWrites: "none" }, receivedAt: "2026-10-05",
};

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "busforge-received-")); dirs.push(d); return d; };
function file(content: Uint8Array | string): string {
  const p = join(temp(), "package.json");
  writeFileSync(p, content);
  return p;
}

describe("checkPackage", () => {
  test("takes a package Busforge's diagnostic export made", () => {
    const pkg = diagnostic();
    expect(checkPackage(bytes(pkg))).toEqual(pkg);
  });

  test("takes the file the app saves from a whole collection of a simulated device", async () => {
    const dev = new KnxDevice(new SimSystemB(), "1.2.3");
    await dev.connect();
    const collected = await collectDevice(dev, { ia: "1.2.3", signal: new AbortController().signal, reopen: async () => { await dev.disconnect(); await dev.connect(); } });
    await dev.disconnect();
    const pkg = toDiagnosticPackage(collected, {
      busforge: { version: "0.0.1", commit: "abc1234" }, connection: { kind: "usb", usbVendorId: 0x147b, usbProductId: 0x5120 }, error: "",
      bus: { takenAt: 0, monitorClosedAt: 1, releasedAt: 2 }, secrets: [],
    });
    expect(pkg.records.some((r) => r.removed)).toBe(true);
    // apps/web/src/lib/diagnostic.ts, diagnosticFileText
    expect(checkPackage(new TextEncoder().encode(JSON.stringify(pkg, null, 1)))).toEqual(pkg);
  });

  test("takes empty and multi-line texts, every record space, and a plan saved before maxApduAlone existed", () => {
    const plan = {
      mask: "MV-0705", family: "m112", authorize: true, objects: "declared" as const, identity: true, applicationObject: null, properties: [], loadStateObjects: [],
      memory: [], segments: [{ address: 0x4000, length: 16 }], securityModeLast: false, notAttempted: [{ name: "x", reason: "" }],
      tables: [{ kind: "counted" as const, name: "a", at: { address: 0x116 }, entryBytes: 2 }, { kind: "counted" as const, name: "m", at: { memory: { address: 0x11a, bytes: 2 } }, entryBytes: 3 }],
    };
    const pkg = diagnostic({
      plan: plan as unknown as CollectPackage["plan"], limits: [""], stop: { reason: "error", detail: "" },
      records: [
        rec({ space: "function-property", target: { object: 17, pid: 51 }, bytes: "00" }),
        rec({ space: "memory-extended", target: { address: 0x10000, length: 2 }, bytes: "abcd", detail: "line one\nline two" }),
      ],
    });
    expect(() => checkPackage(bytes({ ...pkg, error: "" }))).not.toThrow();
  });

  test("takes a package with a plan and a stop", () => {
    const plan: CollectPackage["plan"] = {
      mask: "MV-07B0", family: "system-b", authorize: true, objects: "declared", identity: true, maxApduAlone: false, applicationObject: 3,
      properties: [{ object: 0, pid: 56, name: "max APDU" }], loadStateObjects: [1, 2, 3], memory: [{ address: 0x4000, length: 32, name: "x", source: "product-xml" }],
      tables: [{ kind: "property-pointer", object: 1, name: "address table" }, { kind: "counted", name: "t", at: { property: { object: 1, pid: 7, bytes: 2 } }, entryBytes: 2 }],
      segments: null, securityModeLast: true, notAttempted: [{ name: "load control", reason: "Read None", space: "memory" }],
    };
    expect(() => checkPackage(bytes(diagnostic({ plan, stop: { reason: "duration", detail: "10 minutes" } })))).not.toThrow();
  });

  const refusals: [string, () => Uint8Array, RegExp][] = [
    ["an empty file", () => new Uint8Array(), /empty/],
    ["an oversized file", () => new Uint8Array(MAX_PACKAGE_BYTES + 1).fill(0x20), /more than/],
    ["a gzip archive", () => gzipSync(bytes(diagnostic())), /gzip archive.*nothing is unpacked or run/],
    ["a zip archive", () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), /zip archive/],
    ["a tar archive", () => { const b = new Uint8Array(1024); b.set(new TextEncoder().encode("ustar"), 257); return b; }, /tar archive/],
    ["an ELF executable", () => new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]), /ELF executable/],
    ["a Windows executable", () => new TextEncoder().encode("MZ\u0090"), /Windows executable/],
    ["a script", () => new TextEncoder().encode("#!/bin/sh\nrm -rf /\n"), /script/],
    ["invalid UTF-8", () => new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), /not UTF-8/],
    ["a JSON array", () => bytes([diagnostic()]), /not a JSON object/],
    ["broken JSON", () => new TextEncoder().encode(JSON.stringify(diagnostic()).slice(0, -5)), /not valid JSON/],
    ["an uncleaned collector package", () => bytes(collected()), /uncleaned collector package/],
    ["another format", () => bytes({ ...diagnostic(), format: "busforge-diagnostic/2" }), /format: expected busforge-diagnostic\/1/],
    ["an unknown top-level field", () => bytes({ ...diagnostic(), projectId: "x" }), /package.projectId: unknown field/],
    ["a missing field", () => { const { counts: _, ...p } = diagnostic(); return bytes(p); }, /package.counts: missing/],
    ["bytes that are not hex", () => { const p = diagnostic(); p.records[3].bytes = "zz"; return bytes(p); }, /records\[3\].bytes: expected lower-case hex/],
    ["an odd number of hex digits", () => { const p = diagnostic(); p.records[3].bytes = "abc"; return bytes(p); }, /records\[3\].bytes/],
    ["an unknown record space", () => bytes({ ...diagnostic(), records: [{ ...diagnostic().records[0], space: "flash" }] }), /records\[0\].space: expected one of/],
    ["a serial left in place", () => { const p = diagnostic(); delete p.records[1].removed; p.records[1].bytes = "00fa01020304"; return bytes(p); }, /still holds the device's serial number/],
    ["a removed note on another record", () => { const p = diagnostic(); p.records[3].removed = "serial number, 6 bytes"; return bytes(p); }, /only a serial number record/],
    ["a control character in a name", () => { const p = diagnostic(); p.records[4].step = "\u001b[31mred"; return bytes(p); }, /step: holds a control character/],
    ["a serial PID written as a string", () => { const p = diagnostic(); p.records[1] = { ...p.records[1], target: { object: 0, pid: "11", start: 1 } }; return bytes(p); }, /target.pid: expected a non-negative integer/],
    ["a hex string of the wrong case", () => { const p = diagnostic(); p.records[3].bytes = "AB"; return bytes(p); }, /expected lower-case hex/],
    ["a bad individual address", () => bytes({ ...diagnostic(), ia: "1.1.256" }), /package.ia/],
    ["a bad mask", () => bytes({ ...diagnostic(), mask: "../../x" }), /package.mask/],
    ["an end before the start", () => bytes({ ...diagnostic(), finishedAt: 1 }), /finishedAt: is before startedAt/],
    ["a table with two locations", () => bytes(diagnostic({ plan: {
      mask: "MV-0705", family: "m112", authorize: true, objects: "declared", identity: true, maxApduAlone: false, applicationObject: null, properties: [], loadStateObjects: [],
      memory: [], tables: [{ kind: "counted", name: "t", at: { address: 1, memory: { address: 2, bytes: 1 } } as never, entryBytes: 2 }], segments: [], securityModeLast: false, notAttempted: [],
    } })), /exactly one of address, property, memory/],
  ];
  test("quotes an unknown field without letting its control characters through", () => {
    const evil = { ...diagnostic(), "\u001b]0;pwned\u0007": 1 };
    let message = "";
    try { checkPackage(bytes(evil)); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("unknown field");
    let marks = "";
    try { checkPackage(bytes({ ...diagnostic(), "a\u202eb\u200fc\ufeff": 1 })); } catch (e) { marks = (e as Error).message; }
    expect(marks).toContain("\\u202e");
    expect(marks).not.toMatch(/[\u202e\u200f\ufeff]/);
    // oxlint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("takes a very long valid hex string", () => {
    const p = diagnostic();
    p.records[3].bytes = "ab".repeat(1_500_000);
    expect(() => checkPackage(bytes(p))).not.toThrow();
  });

  for (const [what, make, reason] of refusals) {
    test(`refuses ${what}`, () => {
      expect(() => checkPackage(make())).toThrow(IntakeRefused);
      expect(() => checkPackage(make())).toThrow(reason);
    });
  }
});

describe("receive, load and remove", () => {
  test("stores the file byte for byte with its provenance, and loads it back", () => {
    const corpus = temp();
    const data = bytes(diagnostic());
    const r = receive(corpus, file(data), DETAILS);
    expect(r.id).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(join(corpus, "received", r.id, "package.json"))).toEqual(Buffer.from(data));
    expect(r.provenance).toMatchObject({ issue: DETAILS.issue, consent: DETAILS.consent, origin: DETAILS.origin, reference: "independently-commissioned-device", bytes: data.length });
    const [loaded] = loadReceived(corpus);
    expect(loaded.id).toBe(r.id);
    expect(loaded.provenance).toEqual(r.provenance);
    expect(loaded.pkg).toEqual(diagnostic());
  });

  test("refuses a file it received before, a directory, a symlink and a corpus inside the repository", () => {
    const corpus = temp();
    const p = file(bytes(diagnostic()));
    receive(corpus, p, DETAILS);
    expect(() => receive(corpus, p, DETAILS)).toThrow(/received before/);
    expect(() => receive(corpus, temp(), DETAILS)).toThrow(/not a regular file/);
    const link = join(temp(), "link.json");
    symlinkSync(p, link);
    expect(() => receive(corpus, link, DETAILS)).toThrow(/cannot be opened as a regular file/);
    const fifo = join(temp(), "fifo");
    Bun.spawnSync(["mkfifo", fifo]);
    expect(() => receive(corpus, fifo, DETAILS)).toThrow(/not a regular file/);
    expect(() => receive(join(import.meta.dir, "fixtures"), p, DETAILS)).toThrow(/inside the repository/);
  });

  test("refuses missing consent, a bad date, an unknown origin and a control character in the provenance", () => {
    const corpus = temp(), p = file(bytes(diagnostic()));
    expect(() => receive(corpus, p, { ...DETAILS, consent: { statement: "", givenAt: "2026-10-05" } })).toThrow(/consent.statement/);
    expect(() => receive(corpus, p, { ...DETAILS, consent: { ...DETAILS.consent, givenAt: "2026-13-01" } })).toThrow(/givenAt/);
    expect(() => receive(corpus, p, { ...DETAILS, origin: { configuredBy: "someone" as never, priorBusforgeWrites: "none" } })).toThrow(/configuredBy/);
    expect(() => receive(corpus, p, { ...DETAILS, issue: "#1\u001b]0;x\u0007" })).toThrow(/issue: holds a control character/);
    expect(() => receive(corpus, p, { ...DETAILS, origin: { configuredBy: "busforge", priorBusforgeWrites: "none" } })).toThrow(/a device Busforge configured has Busforge writes/);
    expect(() => receive(corpus, p, { ...DETAILS, consent: { ...DETAILS.consent, givenAt: "2026-10-06" } })).toThrow(/consent comes first/);
    expect(existsSync(join(corpus, "received"))).toBe(false);
  });

  test("refuses a received/ directory or a package that is a link, and links inside a package", () => {
    const corpus = temp(), elsewhere = temp();
    symlinkSync(elsewhere, join(corpus, "received"));
    expect(() => receive(corpus, file(bytes(diagnostic())), DETAILS)).toThrow(/is not a directory \(a link is not followed\)/);
    expect(() => loadReceived(corpus)).toThrow(/a link is not followed/);
    expect(existsSync(join(elsewhere, "package.json"))).toBe(false);

    const c2 = temp();
    const { id } = receive(c2, file(bytes(diagnostic())), DETAILS);
    const outside = join(temp(), "copy.bin");
    writeFileSync(outside, "x");
    mkdirSync(join(c2, "received", id, "derived"));
    symlinkSync(outside, join(c2, "received", id, "derived", "copy.bin"));
    expect(() => loadReceived(c2)).toThrow(/holds links/);
    expect(() => removeReceived(c2, id, [])).toThrow(/holds links/);
    expect(existsSync(outside)).toBe(true);
  });

  test("loads every package in id order, the same each time", () => {
    const corpus = temp();
    const ids = [1, 2, 3].map((n) => receive(corpus, file(bytes(diagnostic({ finishedAt: 20 + n }))), DETAILS).id);
    expect(loadReceived(corpus).map((r) => r.id)).toEqual([...ids].sort());
    expect(loadReceived(corpus)).toEqual(loadReceived(corpus));
    expect(loadReceived(temp())).toEqual([]);
  });

  test("refuses to load a package whose file changed, a stray file, an interrupted intake and an edited reference", () => {
    const corpus = temp();
    const { id } = receive(corpus, file(bytes(diagnostic())), DETAILS);
    const dir = join(corpus, "received", id);
    const original = readFileSync(join(dir, "package.json"));
    writeFileSync(join(dir, "package.json"), bytes({ ...diagnostic(), ia: "1.2.7" }));
    expect(() => loadReceived(corpus)).toThrow(/not the file that was received/);
    writeFileSync(join(dir, "package.json"), original);

    writeFileSync(join(dir, "extract.bin"), "x");
    expect(() => loadReceived(corpus)).toThrow(/derived\/ directory/);
    rmSync(join(dir, "extract.bin"));

    mkdirSync(join(corpus, "received", `.incoming-${id}`));
    expect(() => loadReceived(corpus)).toThrow(/interrupted intake/);
    rmSync(join(corpus, "received", `.incoming-${id}`), { recursive: true });

    const prov = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
    writeFileSync(join(dir, "provenance.json"), JSON.stringify({ ...prov, origin: { configuredBy: "busforge", priorBusforgeWrites: "some" } }));
    expect(() => loadReceived(corpus)).toThrow(/reference: does not follow from the origin/);
  });

  test("remove takes a file named independent despite its bytes, never despite naming the package, and refuses links in the corpus", () => {
    const corpus = temp();
    const r = receive(corpus, file(bytes(diagnostic())), DETAILS);
    mkdirSync(join(corpus, "captures"));
    const own = join(corpus, "captures", "own-capture.log");
    writeFileSync(own, `ETS write ${MEMORY}\n`);
    expect(() => removeReceived(corpus, r.id, [])).toThrow(/own-capture.log \(holds its bytes\).*--independent/);
    writeFileSync(join(corpus, "captures", "notes.txt"), `from ${r.id}`);
    expect(() => removeReceived(corpus, r.id, [], [own, join(corpus, "captures", "notes.txt")])).toThrow(/notes.txt \(names it\)/);
    rmSync(join(corpus, "captures", "notes.txt"));
    const elsewhere = temp();
    writeFileSync(join(elsewhere, "dump.log"), MEMORY);
    symlinkSync(elsewhere, join(corpus, "linked"));
    expect(() => removeReceived(corpus, r.id, [], [own])).toThrow(/the corpus holds links .*linked/);
    rmSync(join(corpus, "linked"));
    removeReceived(corpus, r.id, [], [own]);
    expect(existsSync(join(corpus, "received", r.id))).toBe(false);
    expect(existsSync(own)).toBe(true);
  });

  test("remove refuses a damaged package with the reason, and leaves it for the operator", () => {
    const corpus = temp();
    const { id } = receive(corpus, file(bytes(diagnostic())), DETAILS);
    writeFileSync(join(corpus, "received", id, "provenance.json"), "{}");
    expect(() => removeReceived(corpus, id, [{ path: "/repo/x.ts", text: "undefined" }])).toThrow(/provenance.json.format: missing; inspect it and delete it by hand/);
    rmSync(join(corpus, "received", id, "provenance.json"));
    expect(() => removeReceived(corpus, id, [])).toThrow(IntakeRefused);
    expect(existsSync(join(corpus, "received", id, "package.json"))).toBe(true);
  });

  test("remove deletes the package with its derived copies, and nothing else", () => {
    const corpus = temp();
    const keep = receive(corpus, file(bytes(diagnostic({ finishedAt: 30 }))), DETAILS);
    const { id } = receive(corpus, file(bytes(diagnostic())), DETAILS);
    mkdirSync(join(corpus, "received", id, "derived"));
    writeFileSync(join(corpus, "received", id, "derived", "memory.bin"), Buffer.from(MEMORY, "hex"));
    removeReceived(corpus, id, []);
    expect(existsSync(join(corpus, "received", id))).toBe(false);
    expect(loadReceived(corpus).map((r) => r.id)).toEqual([keep.id]);
    expect(() => removeReceived(corpus, id, [])).toThrow(/no received package/);
    expect(() => removeReceived(corpus, "../../etc", [])).toThrow(/not a package id/);
  });

  test("remove refuses while a corpus file or a tracked file still names the package", () => {
    const corpus = temp();
    const r = receive(corpus, file(bytes(diagnostic())), DETAILS);
    mkdirSync(join(corpus, "captures"));
    writeFileSync(join(corpus, "captures", "vectors.json"), JSON.stringify({ from: r.id }));
    expect(() => removeReceived(corpus, r.id, [])).toThrow(/still in .*vectors.json \(names it\)/);
    rmSync(join(corpus, "captures", "vectors.json"));
    expect(() => removeReceived(corpus, r.id, [{ path: "/repo/tools/x.test.ts", text: `sha256 ${r.provenance.sha256}` }])).toThrow(/still in \/repo\/tools\/x.test.ts \(names it\)/);
    expect(existsSync(join(corpus, "received", r.id, "package.json"))).toBe(true);
  });

  test("remove refuses while a copy of the package's bytes is left, also in a gzipped file or a C array", () => {
    const corpus = temp();
    const r = receive(corpus, file(bytes(diagnostic())), DETAILS);
    mkdirSync(join(corpus, "captures"));
    writeFileSync(join(corpus, "captures", "dump.log.gz"), gzipSync(`memory 4000: ${MEMORY}\n`));
    expect(() => removeReceived(corpus, r.id, [])).toThrow(/dump.log.gz \(holds its bytes\)/);
    rmSync(join(corpus, "captures", "dump.log.gz"));
    const cArray = `const m = { ${MEMORY.match(/../g)!.map((b) => `0x${b.toUpperCase()}`).join(", ")} };`;
    expect(() => removeReceived(corpus, r.id, [{ path: "/repo/x.c", text: `/* */\n${cArray}` }])).toThrow(/\/repo\/x.c \(holds its bytes\)/);
    writeFileSync(join(corpus, "captures", "memory.bin"), Buffer.from(MEMORY, "hex"));
    expect(() => removeReceived(corpus, r.id, [])).toThrow(/memory.bin \(holds its bytes\)/);
    rmSync(join(corpus, "captures", "memory.bin"));
    removeReceived(corpus, r.id, [{ path: "/repo/y.ts", text: "ff".repeat(64) }]);
    expect(existsSync(join(corpus, "received", r.id))).toBe(false);
  });
});

describe("evidence strength", () => {
  const corpus = () => temp();
  const as = (origin: IntakeDetails["origin"]) => receive(corpus(), file(bytes(diagnostic())), { ...DETAILS, origin });

  test("a device ETS configured and Busforge never wrote is an independent reference", () => {
    const r = as({ configuredBy: "ets", priorBusforgeWrites: "none" });
    expect(r.provenance.reference).toBe("independently-commissioned-device");
    expect(asReference(r)).toEqual(r.pkg);
  });

  const notReferences: [IntakeDetails["origin"], Provenance["reference"]][] = [
    [{ configuredBy: "busforge", priorBusforgeWrites: "some" }, "self-written"],
    [{ configuredBy: "ets", priorBusforgeWrites: "some" }, "none"],
    [{ configuredBy: "ets", priorBusforgeWrites: "unknown" }, "none"],
    [{ configuredBy: "unknown", priorBusforgeWrites: "none" }, "none"],
  ];
  for (const [origin, reference] of notReferences) {
    test(`configured by ${origin.configuredBy}, prior Busforge writes ${origin.priorBusforgeWrites}: "${reference}", never a reference`, () => {
      const r = as(origin);
      expect(r.provenance.reference).toBe(reference);
      expect(() => asReference(r)).toThrow(/not an independent reference/);
    });
  }
});

describe("traces of a package", () => {
  test("finds a 32-byte copy in a hex dump with spaces and capitals, and ignores fill patterns", () => {
    const pkg = diagnostic();
    const runs = distinctiveRuns(pkg);
    expect(runs).toEqual([MEMORY.slice(0, 32), MEMORY.slice(32)]);
    const set = new Set(runs);
    const spaced = MEMORY.toUpperCase().match(/../g)!.join(" ");
    expect(holdsRun(hexDigits(`memory: ${spaced}`), set)).toBe(true);
    const cArray = MEMORY.slice(6, 6 + 40).match(/../g)!.map((b) => `0x${b}`).join(",\n  ");
    expect(holdsRun(hexDigits(`uint8_t m[] = {\n  ${cArray}\n};`), set)).toBe(false);
    expect(holdsRun(hexDigits(`uint8_t m[] = { ${MEMORY.match(/../g)!.map((b) => `0x${b}`).join(", ")} };`), set)).toBe(true);
    const fill = diagnostic({ records: [rec({ space: "memory", bytes: "ff".repeat(64) })] });
    expect(distinctiveRuns(fill)).toEqual([]);
  });
});

// The regression load of the real corpus: every package received so far still passes today's check
// with its file unchanged, keeps its evidence strength, and none of its bytes is in a tracked file.
corpusTest("every received package loads with its provenance, and no tracked file holds its bytes", () => {
  const corpus = corpusRoot() as string;
  const received = loadReceived(corpus);
  console.log(`received packages in the corpus: ${received.length}`);
  for (const r of received) {
    if (r.provenance.reference === "independently-commissioned-device") expect(asReference(r)).toBe(r.pkg);
    else expect(() => asReference(r)).toThrow(IntakeRefused);
  }
  const tracked = trackedFiles().map((f) => ({ path: f.path, data: Buffer.from(f.text, "latin1") }));
  const leaks = received.flatMap((r) => {
    const runs = new Set(distinctiveRuns(r.pkg));
    return tracked.filter((f) => contentHoldsRun(f.data, runs)).map((f) => `${r.id} in ${f.path}`);
  });
  expect(leaks).toEqual([]);
}, 120_000);
