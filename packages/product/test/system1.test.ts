import { test, expect } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, classifyByMask, System1Profile, buildAbsoluteSegmentTargets, system1LoadRefusal, bcu1UnmarkedImageWrites, MV0012_DEFAULT_LOAD, ProductError } from "../src/index.ts";
import { catalogueXml, captureText } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// System 1 (BCU1), on the one application of the corpus with mask MV-0012: the MDT IP Interface Secure
// (M-0083_A-0138). Its one segment AS-0100 is the EEPROM at 0x0100, 256 bytes; its five parameters lie at
// offsets 117 (P-5), 118 (P-1), 119-122 (P-7, an IP address), 123-124 (P-10) and 141 (P-11); its <Mask>
// leaves out 0x0101-0x0103, 0x0117-0x0118, 0x013E-0x0171, 0x0176 and 0x01FF (read off the catalogue).
// The master data's MV-0012 Load procedure writes 0x0100, 0x0104-0x010C, 0x010E-0x0115, 0x0119-0x01FE and
// 0x0116 from the image.

const A = "M-0083_A-0138-21-F18E-O0072";
const ref = (p: string) => `${A}_${p}`;

// The memory readState reads: one 256-byte read of the EEPROM segment.
class MockEeprom {
  reads: [number, number][] = [];
  constructor(private bytes: Buffer, private at = 0x0100) {}
  async memRead(addr: number, len: number) {
    this.reads.push([addr, len]);
    const b = Buffer.alloc(len, 0xff);
    for (let i = 0; i < len; i++) if (addr + i >= this.at && addr + i < this.at + this.bytes.length) b[i] = this.bytes[addr + i - this.at];
    return b;
  }
}
const asDev = (m: MockEeprom) => m as unknown as KnxDevice;
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === "function" ? p() : p); } catch (e) { return (e as ProductError).code; }
  return "no error";
};

test("a System 1 mask without an application is read-only nothing: no segment to read", () => {
  const p = classifyByMask("MV-0010");
  expect(p).toBeInstanceOf(System1Profile);
  expect(p.capabilities()).toEqual({ readParams: false, readLinks: false, flashParams: false, flashLinks: false, fullDownload: false, structuralFlash: false });
});

corpusDescribe("System 1 (MV-0012): the MDT IP Interface Secure", () => {
  const cfg = parseAppConfig(catalogueXml(`${A}.xml.gz`));
  // The template as a unit holding this application has it: the application id M-0083 / 312 / 33
  // (83 01 38 21) at 0x0104 and PEI type 0 at 0x0109, where the template carries another application's.
  const segment = () => {
    const b = Buffer.from(cfg.absoluteSegments[0].data);
    Buffer.from([0x83, 0x01, 0x38, 0x21]).copy(b, 0x04);
    b[0x09] = 0;
    return b;
  };

  test("resolves to the System 1 profile: it reads, and refuses every write with its own code", () => {
    const p = classify(cfg);
    expect(p).toBeInstanceOf(System1Profile);
    expect(p.capabilities()).toEqual({ readParams: true, readLinks: true, flashParams: false, flashLinks: false, fullDownload: false, structuralFlash: false });
    const r = p.operationRefusals();
    expect(r.flashParams?.code).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(r.fullDownload?.code).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(r.flashLinks?.code).toBe("SYSTEM1_GROUP_TABLES_UNCAPTURED");
  });

  test("the refusal names the bytes the mask's procedure writes from the image and the <Mask> leaves out", () => {
    expect(bcu1UnmarkedImageWrites(cfg, MV0012_DEFAULT_LOAD)).toEqual([{ from: 0x013e, to: 0x0171 }, { from: 0x0176, to: 0x0176 }]);
    expect(system1LoadRefusal(cfg).message).toContain("0x013E-0x0171, 0x0176");
    // A mask whose procedure Busforge does not carry is refused as well, saying so.
    expect(system1LoadRefusal({ ...cfg, mask: "MV-0010" })).toEqual({ code: "SYSTEM1_LOAD_UNCAPTURED", message: expect.stringContaining("MV-0010 is not in Busforge") });
  });

  test("every write path throws the refusal before touching the device", async () => {
    const p = classify(cfg);
    const dev = asDev(new MockEeprom(segment()));
    expect(await code(p.flashParameters(dev, "MV-0012", {} as never))).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(await code(p.downloadFull(dev, "MV-0012", {} as never))).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(await code(() => p.planFullDownload("MV-0012", {} as never))).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(await code(p.flashGroupTables(dev, "MV-0012", {} as never))).toBe("SYSTEM1_GROUP_TABLES_UNCAPTURED");
  });

  test("readState reads the segment once and takes the device's values as the baseline", async () => {
    const bytes = segment();
    bytes.writeUInt16BE(80, 123); // P-10 HTTP port 80 (the template holds 8080)
    bytes[141] = 2; // P-11 "only status"
    const dev = new MockEeprom(bytes);
    const live = new Map([[ref("P-1_R-1"), "64"], [ref("P-11_R-11"), "0"]]);
    const rb = await classify(cfg).readState(asDev(dev), "MV-0012", { liveParams: live });
    expect(dev.reads).toEqual([[0x0100, 256]]);
    expect(rb.paramsRead).toBe(true);
    expect(rb.paramBase.get(ref("P-10_R-10"))).toBe("80");
    expect(rb.paramBase.get(ref("P-11_R-11"))).toBe("2");
    expect(rb.paramBase.get(ref("P-1_R-1"))).toBe("64");
    // The template's tables: the address table holds only the device's own address (0x0116 = 1), the
    // association table (pointer 0x0111 = 0xFE) none.
    expect(rb.linksRead).toBe(true);
    expect(rb.links).toEqual([]);
  });

  test("a unit that does not hold this application loaded is refused, not decoded", async () => {
    const read = (b: Buffer) => classify(cfg).readState(asDev(new MockEeprom(b)), "MV-0012", { liveParams: new Map() });
    expect(await code(read(Buffer.from(cfg.absoluteSegments[0].data)))).toBe("SYSTEM1_APPLICATION_MISMATCH"); // the template's own id
    const otherVersion = segment(); otherVersion[0x07] = 0x20;
    expect(await code(read(otherVersion))).toBe("SYSTEM1_APPLICATION_MISMATCH");
    const loading = segment(); loading[0x0d] = 0x00; // run error 00: the load procedure's state while it loads
    expect(await code(read(loading))).toBe("SYSTEM1_APPLICATION_MISMATCH");
    expect(await code(read(Buffer.alloc(256, 0xff)))).toBe("SYSTEM1_APPLICATION_MISMATCH"); // a blank unit
  });

  test("the MV-0012 load procedure carried in Busforge is the master data's, step for step", () => {
    const xml = captureText("knx-master-mv0012.xml");
    const load = /<Procedure ProcedureType="Load" ProcedureSubType="all"[^>]*>([\s\S]*?)<\/Procedure>/.exec(xml)![1];
    const steps = [...load.matchAll(/<(LdCtrl\w+)([^>]*)\/>/g)].map((m) => ({ verb: m[1], attrs: Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])) }));
    expect(steps).toEqual([...MV0012_DEFAULT_LOAD]);
  });

  test("group tables with entries are not decoded: the links are reported as not read", async () => {
    const withGa = segment();
    withGa[0x16] = 2; // the address table holds a group address
    const rb = await classify(cfg).readState(asDev(new MockEeprom(withGa)), "MV-0012", { liveParams: new Map() });
    expect(rb.paramsRead).toBe(true);
    expect(rb.linksRead).toBe(false);
    const withAssoc = segment();
    withAssoc[0xfe] = 1; // one association
    expect((await classify(cfg).readState(asDev(new MockEeprom(withAssoc)), "MV-0012", { liveParams: new Map() })).linksRead).toBe(false);
  });

  // A unit ETS downloaded, read under its secure session (captures/mdt-ip-secure-unit-memory.json): the
  // reference for the memory model. Every parameter byte equals Busforge's image of the project.
  test("a unit ETS programmed holds Busforge's image of the project in every parameter byte, and reads back as the project", async () => {
    const fx = JSON.parse(captureText("mdt-ip-secure-unit-memory.json")) as { params: [string, string][]; memory: { address: number; hex: string }[] };
    const eeprom = Buffer.from(fx.memory.find((m) => m.address === 0x0100)!.hex, "hex");
    const params = new Map(fx.params);
    const [target] = buildAbsoluteSegmentTargets(cfg, params);
    const owned = [...target.owned.keys()].filter((i) => target.owned[i]);
    expect(owned).toEqual([117, 118, 119, 120, 121, 122, 123, 124, 141]);
    for (const i of owned) expect(eeprom[i] & target.owned[i]).toBe(target.bytes[i] & target.owned[i]);
    const rb = await classify(cfg).readState(asDev(new MockEeprom(eeprom)), "MV-0012", { liveParams: params });
    // The baseline is sparse like the project's values: no parameter of the unit differs from the project.
    expect(Object.fromEntries(rb.paramBase)).toEqual(Object.fromEntries(params));
    expect(rb.links).toEqual([]);
    expect(rb.linksRead).toBe(true);
  });
});
