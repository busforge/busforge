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
  test("an absolute application declaring LoadImageProp without an ETS capture refuses with LOAD_STEP_UNSUPPORTED before any bus call", async () => {
    // The M-0008 procedure under another application id: the captured stamp read is not carried over.
    const xml = fixture("M-0008_A-10D7-11-2783-O000A.xml.gz").replaceAll("M-0008_A-10D7-11-2783-O000A", "M-0008_A-10D7-11-2783-O000B");
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

// The Auro presence detector's full download runs as ETS ran it (loadproc.ts
// ETS_DECLARED_ORDER_SYSTEM7_APPS), and only on a unit like the one ETS was captured on: the free key
// granted level 0, object 3 holding this application, and load-state machines 1, 2 and 3 loaded.
// Anything else refuses before a single write; the stub fails on any bus call the refusal does not expect.
corpusDescribe("the M-0081_A-FE01-11-75D9 full download's pre-flight", () => {
  const xml = fixture("M-0081_A-FE01-11-75D9.xml.gz");
  const ctx = { ...ctxFor(xml), ia: "1.2.18", links: [] };
  const PROGRAM_ID = Buffer.from("0081fe0111", "hex");
  // `state`: the load state of object 3; `others`: those of objects 1 and 2.
  const unit = (level: number, programId: Buffer, state: number, others: [number, number] = [1, 1]) => dev({
    authorizeFreeKey: async () => level,
    propRead: async (obj: number, pid: number) => {
      if (obj === 3 && pid === 13) return programId;
      if (obj === 3 && pid === 5) return Buffer.from([state]);
      if ((obj === 1 || obj === 2) && pid === 5) return Buffer.from([others[obj - 1]]);
      throw new Error(`unexpected property read ${obj}/${pid}`);
    },
  });
  const run = (d: KnxDevice) => classify(parseAppConfig(xml)).downloadFull(d, "MV-0705", ctx).then(() => null, (e) => e);

  test("a unit that grants the free key another level than 0 is refused with FULL_DOWNLOAD_ACCESS_LEVEL", async () => {
    expect(await run(unit(3, PROGRAM_ID, 1))).toMatchObject({ code: "FULL_DOWNLOAD_ACCESS_LEVEL" });
  });
  test("a unit whose application is not loaded is refused with FULL_DOWNLOAD_APPLICATION_NOT_LOADED", async () => {
    expect(await run(unit(0, PROGRAM_ID, 0))).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
    expect(await run(unit(0, PROGRAM_ID, 2))).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
  });
  test("a unit whose address or association table is not loaded is refused with FULL_DOWNLOAD_APPLICATION_NOT_LOADED, naming the machine", async () => {
    expect(await run(unit(0, PROGRAM_ID, 1, [0, 1]))).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED", message: expect.stringContaining("load-state machine 1 ") });
    expect(await run(unit(0, PROGRAM_ID, 1, [1, 2]))).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED", message: expect.stringContaining("load-state machine 2 ") });
  });
  test("a unit that holds another application is refused with FULL_DOWNLOAD_APPLICATION_NOT_LOADED", async () => {
    expect(await run(unit(0, Buffer.from("0081ff3131", "hex"), 1))).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
  });
});
