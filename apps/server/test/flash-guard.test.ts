import { test, expect } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, ProductError } from "@busforge/product";
import { classify } from "../src/deviceprofile.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The LoadProcedure coverage guard on the real flash entrypoints: a par download whose
// procedure declares steps outside the explicit disposition policy must refuse with a
// coded error BEFORE touching the bus, and declared CompareProp pre-flights must run
// (and abort) before any write. Uses the real catalogue app programs.

const fixture = catalogueXml;

const ctxFor = (appXml: string) => ({
  deviceId: "d", appXml, params: new Map<string, string>(), baseParams: new Map<string, string>(), dryRun: false,
  persistBackups: () => "backup", // guard tests abort before any backup is taken
});

// A device stub that fails loudly on any unexpected bus operation. Individual tests
// override exactly the calls they expect.
const dev = (overrides: Partial<Record<keyof KnxDevice, unknown>> = {}) =>
  new Proxy({}, {
    get: (_t, prop) => (prop in overrides ? (overrides as any)[prop] : () => { throw new Error(`unexpected bus call: ${String(prop)}`); }),
  }) as unknown as KnxDevice;

corpusDescribe("LoadProcedure par coverage guard", () => {
  test("an absolute application closing with a LoadImageProp of another property than 27 refuses with LOAD_STEP_UNSUPPORTED before any bus call", async () => {
    const xml = fixture("M-0008_A-10D7-11-2783-O000A.xml.gz").replace('<LdCtrlLoadImageProp ObjIdx="1" PropId="27"', '<LdCtrlLoadImageProp ObjIdx="1" PropId="13"');
    expect(xml).toContain('PropId="13"');
    const profile = classify(parseAppConfig(xml));
    const err = await profile.flashParameters(dev(), "0705", ctxFor(xml)).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as ProductError).code).toBe("LOAD_STEP_UNSUPPORTED");
    expect((err as ProductError).message).toContain("LdCtrlLoadImageProp");
  });

  test("M-0083 A-00B4 (absolute, declares CompareProp): mismatching device aborts with LOAD_PROC_CHECK_FAILED", async () => {
    const xml = fixture("M-0083_A-00B4-32-3919.xml.gz");
    const profile = classify(parseAppConfig(xml));
    const err = await profile
      .flashParameters(dev({ propRead: async () => Buffer.from("baadf00d", "hex") }), "0705", ctxFor(xml))
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as ProductError).code).toBe("LOAD_PROC_CHECK_FAILED");
  });

  test("M-0083 A-00B4: matching device (real property width, zero-padded declaration) passes the check and proceeds to the backup read", async () => {
    const xml = fixture("M-0083_A-00B4-32-3919.xml.gz");
    const profile = classify(parseAppConfig(xml));
    // device returns the property's real 6-byte width; the procedure declares 10 padded bytes
    const stub = dev({
      propRead: async () => Buffer.from("0000000002AA", "hex"),
      memRead: async () => { throw new Error("BACKUP-READ-REACHED"); },
    });
    const err = await profile.flashParameters(stub, "0705", ctxFor(xml)).then(() => null, (e) => e);
    expect((err as Error).message).toBe("BACKUP-READ-REACHED"); // check passed, flow moved on
  });

  test("System B (relative): A-9071's declared CompareProp runs as a pre-flight and aborts on mismatch", async () => {
    const xml = fixture("M-0048_A-9071-20-F258-O00EF.xml.gz");
    const profile = classify(parseAppConfig(xml));
    const err = await profile
      .flashParameters(dev({ propRead: async () => Buffer.from("ffff", "hex") }), "07B0", ctxFor(xml))
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as ProductError).code).toBe("LOAD_PROC_CHECK_FAILED");
  });

  test("hardware-proven procedures stay flashable: M-0081 passes the guard (no blocked steps)", async () => {
    const xml = fixture("M-0081_A-FE01-11-75D9.xml.gz");
    const profile = classify(parseAppConfig(xml));
    // no CompareProp declared -> first bus op is the backup read
    const stub = dev({ memRead: async () => { throw new Error("BACKUP-READ-REACHED"); } });
    const err = await profile.flashParameters(stub, "0705", ctxFor(xml)).then(() => null, (e) => e);
    expect((err as Error).message).toBe("BACKUP-READ-REACHED");
  });
});

// The Auro presence detector's full download runs its declared procedure (deviceflash.ts absoluteFullForm):
// ETS reads no load state before it, so neither does the pre-flight; a unit holding another application is
// refused before a single write. The stub fails on any bus call the pre-flight does not expect.
corpusDescribe("the M-0081_A-FE01-11-75D9 full download's pre-flight", () => {
  const xml = fixture("M-0081_A-FE01-11-75D9.xml.gz");
  const ctx = { ...ctxFor(xml), ia: "1.2.7", links: [] };
  const PROGRAM_ID = Buffer.from("0081fe0111", "hex");
  const reads: string[] = [];
  const unit = (programId: Buffer) => dev({
    propRead: async (obj: number, pid: number) => {
      reads.push(`${obj}/${pid}`);
      if (obj === 3 && pid === 13) return programId;
      throw new Error(`unexpected property read ${obj}/${pid}`);
    },
  });
  const run = (d: KnxDevice) => classify(parseAppConfig(xml)).downloadFull(d, "MV-0705", ctx).then(() => null, (e) => e);
  const pastPreflight = (e: unknown) => e instanceof Error && /unexpected bus call/.test(e.message);

  test("a unit that holds this application, or none, passes the pre-flight, which reads only its program id", async () => {
    reads.length = 0;
    expect(pastPreflight(await run(unit(PROGRAM_ID)))).toBe(true);
    expect(pastPreflight(await run(unit(Buffer.alloc(5))))).toBe(true);
    expect(pastPreflight(await run(unit(Buffer.alloc(0))))).toBe(true);
    expect(new Set(reads)).toEqual(new Set(["3/13"]));
  });
  test("a unit that holds another application is refused with LOAD_PROC_CHECK_FAILED", async () => {
    expect(await run(unit(Buffer.from("0081ff3131", "hex")))).toMatchObject({ code: "LOAD_PROC_CHECK_FAILED" });
    expect(await run(unit(Buffer.from("0081fe0110", "hex")))).toMatchObject({ code: "LOAD_PROC_CHECK_FAILED" });
  });
});
