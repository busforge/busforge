import { test, expect } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, classifyByMask, System1Profile, buildAbsoluteSegmentTargets, system1LoadRefusal, knxIpWrites, planSystem1Download, system1PreconditionRefusal, MV0012_DEFAULT_LOAD, ProductError, type KnxIpDevice } from "../src/index.ts";
import { catalogueXml, captureText } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// System 1 (BCU1), on the one application of the corpus with mask MV-0012: the MDT IP Interface Secure
// (M-0083_A-0138). Its one segment AS-0100 is the EEPROM at 0x0100, 256 bytes; its five parameters lie at
// offsets 117 (P-5), 118 (P-1), 119-122 (P-7, an IP address), 123-124 (P-10) and 141 (P-11); its <Mask>
// leaves out 0x0101-0x0103, 0x0117-0x0118, 0x013E-0x0171, 0x0176 and 0x01FF (read off the catalogue).
// The master data's MV-0012 Load procedure writes 0x0100, 0x0104-0x010C, 0x010E-0x0115, 0x0119-0x01FE and
// 0x0116 from the image. The download's telegrams against ETS's: tools/etsdiff.test.ts.

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

  const fx = JSON.parse(captureText("mdt-ip-secure-unit-knxip.json")) as { knxIp: KnxIpDevice };
  const knxIp = (over: Partial<KnxIpDevice> = {}): KnxIpDevice => ({ ...fx.knxIp, ...over });
  const params = new Map((JSON.parse(captureText("mdt-ip-secure-unit-memory.json")) as { params: [string, string][] }).params);

  test("resolves to the System 1 profile: it reads, writes parameters and full downloads, and refuses group tables", () => {
    const p = classify(cfg);
    expect(p).toBeInstanceOf(System1Profile);
    expect(p.capabilities()).toEqual({ readParams: true, readLinks: true, flashParams: true, flashLinks: false, fullDownload: true, structuralFlash: false });
    expect(p.operationRefusals()).toEqual({ flashLinks: expect.objectContaining({ code: "SYSTEM1_GROUP_TABLES_UNCAPTURED" }) });
    expect(system1LoadRefusal(cfg)).toBeNull();
  });

  // Only what the capture shows is written: a Data Secure KNXnet/IP interface running the master data's MV-0012 procedure.
  test("a System 1 application the capture does not show is refused: another mask, not secure, no additional addresses", () => {
    expect(system1LoadRefusal({ ...cfg, mask: "MV-0010" })).toEqual({ code: "SYSTEM1_LOAD_UNCAPTURED", message: expect.stringContaining("MV-0010 is not in Busforge") });
    expect(system1LoadRefusal({ ...cfg, loadProcedures: { ...cfg.loadProcedures, secureEnabled: false } })?.code).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(system1LoadRefusal({ ...cfg, additionalAddressesCount: 0 })?.code).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(classify({ ...cfg, additionalAddressesCount: 0 }).capabilities()).toMatchObject({ flashParams: false, fullDownload: false });
  });

  test("the KNXnet/IP properties written are the project's settings and ETS's defaults, in ETS's order", () => {
    expect(knxIpWrites(cfg, knxIp()).map((w) => `${w.pid}*${w.count}=${w.data.toString("hex")}`)).toEqual([
      "51*1=0000", "66*1=e000170c", "67*1=20", `76*30=${Buffer.from("SCN-IP000.03 IP Interface with").toString("hex")}`,
      "55*1=01", "60*1=cb007129", "61*1=ffffff00", "62*1=cb007101", "53*4=11ff11fe11fd11fc",
    ]);
  });

  test("every KNXnet/IP setting the capture does not show is refused, not guessed", async () => {
    const refused = (over: Partial<KnxIpDevice>) => code(() => knxIpWrites(cfg, knxIp(over)));
    const cases: Partial<KnxIpDevice>[] = [
      { instanceName: "Gateway" },
      { productName: "SCN-IP000.03" },                                   // shorter than the 30-character field
      { productName: "SCN-IP000.03 IP Interface für Secure" },           // not ASCII
      { ipConfig: null },
      { ipConfig: { ...fx.knxIp.ipConfig, Assign: "Auto" } },
      { ipConfig: { ...fx.knxIp.ipConfig, IPAddress: "192.0.2.300" } },
      { ipConfig: { ...fx.knxIp.ipConfig, DnsServer: "1.1.1.1" } },
      { additionalAddresses: [255, 254, 253] },
      { additionalAddresses: [255, 254, 253, 256] },
      { securityAttributes: [...fx.knxIp.securityAttributes, "DeviceAuthenticationCode"] },
      { toolKeyLoaded: false },
      { busInterfaces: 1 },
      { installation: { ...fx.knxIp.installation, IPRoutingMulticastAddress: "239.0.0.1" } },
      { installation: { ...fx.knxIp.installation, BCUKey: "305419896" } },
      { installation: { ...fx.knxIp.installation, IPRoutingLatencyTolerance: "1000" } },
    ];
    for (const c of cases) expect([c, await refused(c)]).toEqual([c, "SYSTEM1_KNXIP_UNCAPTURED"]);
  });

  test("the precondition ETS reads: this manufacturer's unit, its hardware configuration the image's", () => {
    const { image } = planSystem1Download(cfg, params, knxIp());
    expect(system1PreconditionRefusal(cfg, image, segment())).toBeNull();
    const other = segment(); other[0x04] = 0x72;
    expect(system1PreconditionRefusal(cfg, image, other)?.code).toBe("SYSTEM1_UNIT_UNCAPTURED");
    const hw = segment(); hw[0x0c] = 0xac;
    expect(system1PreconditionRefusal(cfg, image, hw)?.code).toBe("SYSTEM1_UNIT_UNCAPTURED");
  });

  test("a write without the project's KNXnet/IP settings is refused before touching the device; group tables are refused", async () => {
    const p = classify(cfg);
    const m = new MockEeprom(segment());
    expect(await code(p.flashParameters(asDev(m), "MV-0012", { params, deviceId: "d" } as never))).toBe("SYSTEM1_KNXIP_MISSING");
    expect(await code(p.downloadFull(asDev(m), "MV-0012", { params, deviceId: "d" } as never))).toBe("SYSTEM1_KNXIP_MISSING");
    expect(await code(() => p.planFullDownload("MV-0012", { params } as never))).toBe("SYSTEM1_KNXIP_MISSING");
    expect(await code(p.flashGroupTables(asDev(m), "MV-0012", {} as never))).toBe("SYSTEM1_GROUP_TABLES_UNCAPTURED");
    expect(m.reads).toEqual([]);
  });

  // A unit as the house unit was after ETS's download: the image, and the KNXnet/IP properties the plan writes,
  // the friendly name in German.
  const unit = (over: { name?: string; props?: Record<number, Buffer>; secured?: boolean; overUsb?: boolean; eeprom?: (b: Buffer) => void } = {}) => {
    const name = Buffer.from(over.name ?? "SCN-IP000.03 IP Interface mit ");
    const { image, knxIp: writes } = planSystem1Download(cfg, params, knxIp(), name);
    const held = new Map<number, Buffer>(writes.map((w) => [w.pid, Buffer.from(w.data)]));
    held.set(76, name);
    held.set(64, Buffer.from("020000000001", "hex"));
    for (const [pid, b] of Object.entries(over.props ?? {})) held.set(Number(pid), b);
    const bytes = Buffer.from(image); bytes[0x76] = 32; // the TTL byte the unit keeps PID 67 in
    over.eeprom?.(bytes);
    return Object.assign(new MockEeprom(bytes), {
      secured: over.secured ?? true, overUsb: over.overUsb ?? false,
      propExtRead: async (_t: number, _i: number, pid: number) => held.get(pid)!,
    });
  };
  const files: string[] = [];
  const dry = (dev: object, extra: object = {}) => classify(cfg).flashParameters(asDev(dev as MockEeprom), "MV-0012", { deviceId: "d", appXml: "", params, baseParams: params, knxIp: knxIp(), dryRun: true, persistBackups: (f) => { files.push(...f.map((x) => x.file)); return "b"; }, ...extra });

  // Nothing compared differs, and the download still runs: it writes state it does not read.
  test("a dry run on a unit holding the project counts no change, keeps the German name, and is not reported unchanged", async () => {
    files.length = 0;
    expect(await dry(unit())).toMatchObject({ kind: "dryRun", diffBytes: 0 });
    expect(files.map((b) => b.replace(/-\d+\./, "."))).toEqual(["d-AS-0100.bin", "d-knxip.json"]);
  });

  test("a dry run counts the verified bytes and property bytes that differ", async () => {
    // P-10 (verified) differs; a name that is no product text is replaced by the default language's (two characters differ).
    expect(await dry(unit({ name: "SCN-IP000.03 IP Interface wXth", eeprom: (b) => { b[0x7b] ^= 0xff; } }))).toMatchObject({ kind: "dryRun", diffBytes: 2 });
  });

  test("refused before anything is written: an unsecured session, a link other than KNXnet/IP, links, an IP or tunnelling address change", async () => {
    expect(await code(dry(unit({ secured: false })))).toBe("SYSTEM1_SECURE_SESSION_REQUIRED");
    expect(await code(dry(unit({ overUsb: true })))).toBe("SYSTEM1_TRANSPORT_UNCAPTURED");
    expect(await code(classify(cfg).downloadFull(asDev(unit() as unknown as MockEeprom), "MV-0012", { deviceId: "d", ia: "1.1.250", appXml: "", params, links: [{ comObjNum: 1, gaRaws: [1] }], knxIp: knxIp(), dryRun: true, persistBackups: () => "b" }))).toBe("SYSTEM1_LOAD_UNCAPTURED");
    for (const [pid, b] of [[60, "cb00712a"], [55, "04"], [53, "11ff11fe11fd11fb"], [62, "cb0071fe"]] as const) {
      expect([pid, await code(dry(unit({ props: { [pid]: Buffer.from(b, "hex") } })))]).toEqual([pid, "SYSTEM1_IP_CHANGE_UNCAPTURED"]);
    }
    expect(await code(dry(unit({ eeprom: (b) => { b[0x04] = 0x72; } })))).toBe("SYSTEM1_UNIT_UNCAPTURED");
  });

  test("an application with group objects or room for table entries is not written: the download writes the tables empty", () => {
    expect(system1LoadRefusal({ ...cfg, groupTables: { ...cfg.groupTables, addressMaxEntries: 4 } })?.code).toBe("SYSTEM1_LOAD_UNCAPTURED");
    expect(system1LoadRefusal({ ...cfg, comObjects: new Map([["O-1", {} as never]]) })?.code).toBe("SYSTEM1_LOAD_UNCAPTURED");
  });

  test("the friendly name keeps a language the unit holds, else the catalogue's default; an unparseable address is refused", async () => {
    const name = (held?: string) => knxIpWrites(cfg, knxIp(), held === undefined ? undefined : Buffer.from(held)).find((w) => w.pid === 76)!.data.toString("latin1");
    expect(name("SCN-IP000.03 IP Interface mit ")).toBe("SCN-IP000.03 IP Interface mit ");
    expect(name("Gateway")).toBe("SCN-IP000.03 IP Interface with");
    expect(name()).toBe("SCN-IP000.03 IP Interface with");
    expect(await code(() => knxIpWrites(cfg, knxIp({ additionalAddresses: [255, 254, null, 252] })))).toBe("SYSTEM1_KNXIP_UNCAPTURED");
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
