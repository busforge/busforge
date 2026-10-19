import { test, expect } from "bun:test";
import { parseAppConfig, buildDeviceConfig, buildComObjectTable, buildComObjectTableMv0705, withInstanceOverrides, withLinkedCommFlags, linkedBitObjects, placeComObjOverrides } from "../packages/product/src/index.ts";
import { catalogueXml, captureText } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { parseCapture, memoryImage, captureDevice } from "./etsdiff.ts";

// ETS 6 partial downloads after a com-object flag change alone, on the bench: the read flag of one
// object off, then back on. ETS writes them with its group-address download
// ("PartialLoadGroupCommunication" in its log); the object's flag bit is the only byte of the
// com-object table that changes.

const span = (mem: Map<number, number>, at: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => {
  const b = mem.get(at + i);
  if (b === undefined) throw new Error(`byte ${at + i} is not in the capture`);
  return b;
}));

// MDT BE-02001.02 (System 7, MV-0705), input A's object 0, linked to no group address in the project.
// The read-on run is the clean one: the unit held the table the read-off run wrote.
corpusDescribe("System 7 flag change against ETS's group-address download", () => {
  const app = "M-0083_A-00B6-32-9642.xml.gz";
  const cfg = parseAppConfig(catalogueXml(app));
  const l3 = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.comObjectSegment)!;
  const written = (file: string) => memoryImage(parseCapture(captureText(file), captureDevice(captureText(file))).writes);
  const view = buildDeviceConfig(cfg, new Map());
  const ref0 = [...view.imageComObjects.values()].find((o) => o.number === 0)!.refId.replace(`${cfg.id}_`, "");
  const tableOf = (file: string) => { const m = written(file); return span(m, l3.address, m.get(l3.address)! * 4 + 3); };

  test("ETS writes the whole table; only object 0's config byte changes, by the read bit", () => {
    const off = tableOf("mdt-be02001-ets-partial-flag-read-off.log"), on = tableOf("mdt-be02001-ets-partial-flag-read-on.log");
    expect([...off.keys()].filter((i) => off[i] !== on[i])).toEqual([3 + 2]);
    expect([off[5], on[5]]).toEqual([0x43, 0x4b]);
  });

  test("the group-address flash lays the project's changed flags over the table the unit holds, as ETS writes them", () => {
    const held = tableOf("mdt-be02001-ets-partial-flag-read-off.log");
    // The project's flags for object 0 back to the application's: the change since the last write.
    const authored = withInstanceOverrides(view.imageComObjects, placeComObjOverrides(cfg, view, []));
    const ours = withLinkedCommFlags(held, new Set(), new Map([[0, authored.get(0)!]]));
    expect(ours.toString("hex")).toBe(tableOf("mdt-be02001-ets-partial-flag-read-on.log").toString("hex"));
    // and the read flag off again, as the project's own override
    const off = withInstanceOverrides(view.imageComObjects, placeComObjOverrides(cfg, view, [{ comObjRefId: ref0, attrs: { ReadFlag: "Disabled" } }]));
    expect(withLinkedCommFlags(ours, new Set(), new Map([[0, off.get(0)!]])).toString("hex")).toBe(held.toString("hex"));
  });
});

// The same unit and object, now linked to one group address in the project: its communication flag off
// and back on, then its update flag on and back off, each written alone by ETS's group-address download.
// Communication off keeps the object's address and association and clears the object's linked bit
// (config 0x04): the bit is set where the object is linked and its communication flag is on. Update is
// config 0x80.
corpusDescribe("System 7 communication and update flags against ETS's group-address download", () => {
  const app = "M-0083_A-00B6-32-9642.xml.gz";
  const cfg = parseAppConfig(catalogueXml(app));
  const segAt = (id: string | undefined) => cfg.absoluteSegments.find((s) => s.id === id)!;
  const l3 = segAt(cfg.groupTables.comObjectSegment);
  const written = (file: string) => memoryImage(parseCapture(captureText(file), captureDevice(captureText(file))).writes);
  const tableOf = (file: string) => { const m = written(file); return span(m, l3.address, m.get(l3.address)! * 4 + 3); };
  const assocOf = (file: string) => { const at = segAt(cfg.groupTables.associationSegment).address; const m = written(file); return span(m, at, m.get(at)! * 2 + 1); };
  const view = buildDeviceConfig(cfg, new Map());
  const ref0 = view.imageComObjects.get(0)!.refId.replace(`${cfg.id}_`, "");
  const withProject = (attrs?: Record<string, string>) => withInstanceOverrides(view.imageComObjects, placeComObjOverrides(cfg, view, attrs ? [{ comObjRefId: ref0, attrs }] : []));
  // The group-address flash's table: the one the unit holds, object 0 linked, its flags as the project
  // gives them where they changed since the last write.
  const gaFlash = (held: Buffer, attrs: Record<string, string> | undefined, changed: boolean) => {
    const objs = withProject(attrs);
    return withLinkedCommFlags(held, linkedBitObjects(new Set([0]), objs), changed ? new Map([[0, objs.get(0)!]]) : undefined).toString("hex");
  };
  const COMM_OFF = { CommunicationFlag: "Disabled" }, UPDATE_ON = { UpdateFlag: "Enabled" };
  const f = (s: string) => `mdt-be02001-ets-partial-flag-${s}.log`;

  test("ETS writes the whole table; only object 0's config byte changes, by the linked bit and the update bit", () => {
    const [commOff, commOn, updOn, updOff] = ["comm-off", "comm-on", "update-on", "update-off"].map((s) => tableOf(f(s)));
    expect([...commOff.keys()].filter((i) => commOff[i] !== commOn[i])).toEqual([3 + 2]);
    expect([commOff[5], commOn[5]]).toEqual([0x4b, 0x4f]);
    expect([...updOn.keys()].filter((i) => updOn[i] !== updOff[i])).toEqual([3 + 2]);
    expect([updOn[5], updOff[5]]).toEqual([0xcf, 0x4f]);
  });

  test("communication off keeps the object's association", () => {
    for (const s of ["comm-off", "comm-on", "update-on", "update-off"]) expect(assocOf(f(s)).toString("hex")).toBe("010100");
  });

  test("the group-address flash writes the communication flag into the linked bit and the update flag into 0x80, as ETS does", () => {
    expect(gaFlash(tableOf(f("comm-on")), COMM_OFF, true)).toBe(tableOf(f("comm-off")).toString("hex"));
    expect(gaFlash(tableOf(f("comm-off")), undefined, true)).toBe(tableOf(f("comm-on")).toString("hex"));
    expect(gaFlash(tableOf(f("comm-on")), UPDATE_ON, true)).toBe(tableOf(f("update-on")).toString("hex"));
    expect(gaFlash(tableOf(f("update-on")), undefined, true)).toBe(tableOf(f("update-off")).toString("hex"));
  });

  test("a communication flag the unit already holds off stays off on a linked object, though not changed since the last write", () => {
    expect(gaFlash(tableOf(f("comm-off")), COMM_OFF, false)).toBe(tableOf(f("comm-off")).toString("hex"));
  });

  test("the full download's table carries both flags as ETS's group-address download wrote them", () => {
    for (const [s, attrs] of [["comm-off", COMM_OFF], ["comm-on", undefined], ["update-on", UPDATE_ON], ["update-off", undefined]] as const) {
      const ets = tableOf(f(s));
      expect(buildComObjectTableMv0705(l3.data, withProject(attrs), new Set([0])).subarray(0, ets.length).toString("hex")).toBe(ets.toString("hex"));
    }
  });
});

// Jung 400021SE (System B, Data Secure), K1's switching object 253 on K1's group address. The unit is
// secured, so the plaintext of every memory write comes from ETS's own log.
corpusDescribe("System B flag change against ETS's group-address download", () => {
  const app = "M-0004_A-7072-21-99A7-O000A.xml.gz";
  const cfg = parseAppConfig(catalogueXml(app));
  const K = (s: string) => `${cfg.id}_${s}`;
  const params = new Map([[K("MD-1_M-100_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-100_MI-1_P-150_R-243"), "Taster"], [K("MD-1_M-200_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-200_MI-1_P-150_R-243"), "Taster"]]);
  const view = buildDeviceConfig(cfg, params);
  const ref253 = [...view.imageComObjects.values()].find((o) => o.number === 253)!.refId.replace(`${cfg.id}_`, "");
  const etsWrites = (file: string) => {
    const m = new Map<number, number>();
    for (const l of captureText(file).split(/\r?\n/)) {
      const w = !l.includes("Sending") && l.match(/ Send Sec_req -> .*InnerTelegram=MemoryExtended_Write_req -> \S+ \([^)]*\) Address=\$([0-9A-F]+) Count=\d+ Data=([0-9A-F]+)/);
      if (w) Buffer.from(w[2], "hex").forEach((b, i) => m.set(Number.parseInt(w[1], 16) + i, b));
    }
    return m;
  };
  const L3_AT = 0x15000;
  const tableOf = (file: string) => { const m = etsWrites(file); return span(m, L3_AT, ((m.get(L3_AT)! << 8) | m.get(L3_AT + 1)!) * 2 + 2); };
  const ours = (rows: { comObjRefId: string; attrs: Record<string, string> }[]) =>
    buildComObjectTable(withInstanceOverrides(view.imageComObjects, placeComObjOverrides(cfg, view, rows)), view.maxComObjectNumber, new Set([253]));

  test("ETS writes the whole table; only object 253's flags byte changes, by the read bit", () => {
    const off = tableOf("jung-400021se-ets6log-partial-flag-read-off.txt"), on = tableOf("jung-400021se-ets6log-partial-flag-read-on.txt");
    const at = 2 + (253 - 1) * 2;
    expect([...off.keys()].filter((i) => off[i] !== on[i])).toEqual([at]);
    expect([off[at], on[at]]).toEqual([0xc7, 0xcf]);
  });

  test("the group-address flash's com-object table, with and without the project's read flag, is every byte ETS wrote", () => {
    expect(ours([]).toString("hex")).toBe(tableOf("jung-400021se-ets6log-partial-flag-read-on.txt").toString("hex"));
    expect(ours([{ comObjRefId: ref253, attrs: { ReadFlag: "Disabled" } }]).toString("hex")).toBe(tableOf("jung-400021se-ets6log-partial-flag-read-off.txt").toString("hex"));
  });
});
