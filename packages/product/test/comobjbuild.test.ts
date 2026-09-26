import { test, expect, describe } from "bun:test";
import {
  buildComObjectTable, buildComObjectTableMv0705, comObjectEntry, objectSizeInBits, programIdStamp,
  parseAppConfig, buildDeviceConfig, ProductError,
  type CfgComObjImage,
} from "@busforge/product";

// The com-object table (L3) is the table a device consults for EVERY group telegram. The firmware
// validates NOTHING it is handed (thelsing/knx TableObject::loadEvent accepts any bytes), so a
// wrong bit here does not fail: it produces a device that quietly mis-communicates. These tests
// pin the layout against the two independent implementations it was read off:
//
//   thelsing/knx  group_object.cpp:29-34   responseUpdateEnable() = bit 15 of ntohs(_tableData[_asap])
//                                          transmitEnable()       = bit 14   ... etc
//   thelsing/knx  group_object_table_object.cpp:100  uint16_t goCount = ntohs(_tableData[0])
//   Kaenx         ProgApplication.cs GenerateComObjectTable()     flags |= (1 << 7) for Update ...
//
// Bit 15 of the big-endian u16 is bit 7 of the FIRST byte, so the entry is [flags][sizeCode].

const obj = (o: Partial<CfgComObjImage> & { number: number }): CfgComObjImage => ({
  objectSize: "1 Bit", refId: `R-${o.number}`, priority: "Low",
  flags: { read: false, write: false, comm: false, transmit: false, update: false, readOnInit: false },
  ...o,
});

describe("one com-object table entry", () => {
  test("every flag sits where the firmware reads it", () => {
    const bit = (flag: keyof CfgComObjImage["flags"]) =>
      comObjectEntry(obj({ number: 1, priority: "High", flags: { read: false, write: false, comm: false, transmit: false, update: false, readOnInit: false, [flag]: true } as any }))[0] & ~0b11;
    expect(bit("update")).toBe(1 << 7);
    expect(bit("transmit")).toBe(1 << 6);
    expect(bit("readOnInit")).toBe(1 << 5);
    expect(bit("write")).toBe(1 << 4);
    expect(bit("read")).toBe(1 << 3);
    expect(bit("comm")).toBe(1 << 2);
  });

  test("priority occupies the low two bits, in the KNX telegram classes ETS names Low/High/Alert", () => {
    // The device writes these straight into its com-object table, so a wrong mapping silently
    // demotes an alarm object. ETS's three values map onto the KNX priority classes by rank.
    const prio = (p: CfgComObjImage["priority"]) => comObjectEntry(obj({ number: 1, priority: p }))[0] & 0b11;
    expect(prio("Low")).toBe(0b11);   // the lowest class, and the schema default
    expect(prio("High")).toBe(0b01);  // "normal" in KNX terms
    expect(prio("Alert")).toBe(0b10); // "urgent"
  });

  test("a priority the ETS schema does not define is REFUSED, never turned into Low", () => {
    const xml = (priority: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0002"><ApplicationPrograms>
<ApplicationProgram Id="M-0002_A-1-1-0000" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="x"><Static>
<ComObjectTable><ComObject Id="M-0002_A-1-1-0000_O-1" Number="1" Name="n" Text="t" ObjectSize="1 Bit" CommunicationFlag="Enabled" Priority="${priority}"/></ComObjectTable>
</Static><Dynamic/></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
    expect(parseAppConfig(xml("Alert")).comObjects.values().next().value!.priority).toBe("Alert");
    expect(() => parseAppConfig(xml("Panic"))).toThrow(/priority/i);
  });

  test("the size code follows the KNX value-field-type table, which is NOT a formula", () => {
    const code = (objectSize: string) => comObjectEntry(obj({ number: 1, objectSize }))[1];
    expect(code("1 Bit")).toBe(0);
    expect(code("4 Bit")).toBe(3);
    expect(code("1 Byte")).toBe(7);
    expect(code("2 Bytes")).toBe(8);
    expect(code("4 Bytes")).toBe(10);
    // The irregular ones, which is why this is a table and not arithmetic:
    expect(code("5 Bytes")).toBe(15); // NOT 11
    expect(code("6 Bytes")).toBe(11);
    expect(code("8 Bytes")).toBe(12);
    expect(code("14 Bytes")).toBe(14);
    expect(code("20 Bytes")).toBe(26); // the contiguous run from 15 bytes = code 21
  });

  test("a com-object numbered 0 is REFUSED (entry 0 of the table is its count)", () => {
    expect(() => buildComObjectTable(new Map([[0, obj({ number: 0 })]]), 1, new Set([0]))).toThrow(/1-based|number 0/i);
  });

  test("a flags+size combination round-trips as the firmware would decode it", () => {
    // The OpenKNX "In Betrieb" heartbeat: 1 Byte, C+R+T, Low priority.
    const e = comObjectEntry(obj({ number: 1, objectSize: "1 Byte", priority: "Low",
      flags: { read: true, write: false, comm: true, transmit: true, update: false, readOnInit: false } }));
    const word = e.readUInt16BE(0); // what the firmware ntohs()es
    expect((word >> 15) & 1).toBe(0); // update
    expect((word >> 14) & 1).toBe(1); // transmit
    expect((word >> 13) & 1).toBe(0); // read on init
    expect((word >> 12) & 1).toBe(0); // write
    expect((word >> 11) & 1).toBe(1); // read
    expect((word >> 10) & 1).toBe(1); // communication
    expect(word & 0xff).toBe(7);      // 1 byte
  });

  test("a size Busforge cannot express is REFUSED, never guessed", () => {
    expect(() => comObjectEntry(obj({ number: 1, objectSize: "" }))).toThrow(ProductError);
    expect(() => comObjectEntry(obj({ number: 1, objectSize: "3 Cubits" }))).toThrow(/cannot express|not a KNX/i);
    expect(objectSizeInBits("2 Bytes")).toBe(16);
    expect(objectSizeInBits("nonsense")).toBeUndefined();
  });
});

describe("the whole table", () => {
  test("entry i is com-object i, and the gaps are silent objects", () => {
    // Objects 1 and 4 active: the table must be 4 entries long, with 2 and 3 zeroed, because the
    // firmware indexes it positionally (get(asap) -> _groupObjects[asap-1]).
    const table = buildComObjectTable(new Map([
      [1, obj({ number: 1, objectSize: "1 Bit", flags: { read: false, write: true, comm: true, transmit: false, update: true, readOnInit: false } })],
      [4, obj({ number: 4, objectSize: "2 Bytes", flags: { read: false, write: false, comm: true, transmit: true, update: false, readOnInit: false } })],
    ]), 4, new Set([1, 4])); // both linked: their Communication flag is kept
    expect(table.readUInt16BE(0)).toBe(4);      // count = the highest NUMBER, not the object count
    expect(table.length).toBe(2 + 4 * 2);
    expect(table.subarray(2, 4)).toEqual(comObjectEntry(obj({ number: 1, objectSize: "1 Bit", flags: { read: false, write: true, comm: true, transmit: false, update: true, readOnInit: false } })));
    expect(table.subarray(4, 6)).toEqual(Buffer.from([0, 0])); // object 2: does not communicate
    expect(table.subarray(6, 8)).toEqual(Buffer.from([0, 0])); // object 3
    expect(table.subarray(8, 10)).toEqual(comObjectEntry(obj({ number: 4, objectSize: "2 Bytes", flags: { read: false, write: false, comm: true, transmit: true, update: false, readOnInit: false } })));
  });

  test("the table is sized to the DECLARED count, not the highest active object", () => {
    // A near-default config activates only object 1, but the application declares objects up to 1359
    // (an inactive channel's objects). The firmware's group-object array is sized to the declaration
    // and getGroupObject(n) is unbounded, so the table must be 1359 long with object 1's entry and the
    // rest silent. Sizing it to the active maximum (1) is what death-looped the OpenKNX RaumController.
    const table = buildComObjectTable(new Map([
      [1, obj({ number: 1, objectSize: "1 Bit", flags: { read: false, write: false, comm: true, transmit: true, update: false, readOnInit: false } })],
    ]), 1359, new Set([1]));
    expect(table.readUInt16BE(0)).toBe(1359);
    expect(table.length).toBe(2 + 1359 * 2);
    expect(table.subarray(2, 4)).not.toEqual(Buffer.from([0, 0])); // object 1 present
    expect(table.subarray(4)).toEqual(Buffer.alloc((1359 - 1) * 2)); // 2..1359 all silent
  });

  test("the Communication flag is cleared on an object with no group-address link, as ETS does", () => {
    // Two identical objects, one linked (in the association table) and one not. ETS keeps Communication
    // on the linked object and clears it on the unlinked one (it has no association, so it cannot
    // communicate). Hardware-verified against the ETS-programmed RaumController.
    const flags = { read: true, write: false, comm: true, transmit: true, update: false, readOnInit: false };
    const table = buildComObjectTable(new Map([
      [1, obj({ number: 1, objectSize: "1 Byte", flags })],
      [2, obj({ number: 2, objectSize: "1 Byte", flags })],
    ]), 2, new Set([1])); // only object 1 is linked
    const COMM = 1 << 10; // bit 2 of the flags byte
    expect(table.readUInt16BE(2) & COMM).toBe(COMM); // object 1 (linked): Communication kept
    expect(table.readUInt16BE(4) & COMM).toBe(0);    // object 2 (unlinked): Communication cleared
    expect(table.readUInt16BE(4) & ~COMM).toBe(table.readUInt16BE(2) & ~COMM); // every OTHER bit identical
  });

  test("a configuration that activates no object is written as a table of silent entries, as ETS does", () => {
    // GVS AMMA at application defaults (every output disabled): ETS 6 wrote the count 532 and 532
    // zero entries (ETS capture of 1.1.203, 2026-09-25).
    expect(buildComObjectTable(new Map(), 532, new Set())).toEqual(Buffer.concat([Buffer.from("0214", "hex"), Buffer.alloc(1064)]));
  });

  test("an application that declares no com-object at all is refused, not written as an empty table", () => {
    expect(() => buildComObjectTable(new Map(), 0, new Set())).toThrow(/declares no communication objects/i);
  });
});

// The property-mapped System 7 (MV-0705) table is NOT rebuilt from scratch like System B: the app
// ships the manufacturer's complete static L3 as the <ComObjectTable> segment's <Data>, and the
// full download overlays only the dynamic config byte (and, for configured objects, the type). The
// entry is 4 bytes: [dataPtr: u16 BE][config: u8][type: u8], one per object 0-based, after a 3-byte
// [count: u8][ramEnd: u16 BE] header. config = prio(bits0-1) | 0x04 linked | 0x08 read | 0x10 write
// | 0x40 transmit | 0x80 unconfigured. Byte-verified on the MDT BE-02001.02 (docs/commissioning.md).
describe("the property-mapped (MV-0705) com-object table", () => {
  // count=2 -> entries for objects 0 and 1. obj0 carries a stale "linked" bit the author must clear;
  // obj1 is the one the configuration reaches.
  const template = Buffer.from([
    0x02, 0x12, 0x34,       // count=2, ramEnd=0x1234
    0xaa, 0xbb, 0x80, 0x00, // obj0: dataPtr 0xAABB, config 0x80 (unconfigured), type 0
    0xcc, 0xdd, 0x84, 0x00, // obj1: dataPtr 0xCCDD, config 0x84 (unconfigured + STALE linked), type 0
  ]);

  test("a configured object gets its dynamic config + type; the data pointer is left untouched", () => {
    const active = new Map([[1, obj({ number: 1, objectSize: "1 Byte", priority: "Low",
      flags: { read: true, write: false, comm: true, transmit: true, update: false, readOnInit: false } })]]);
    const out = buildComObjectTableMv0705(template, active, new Set([1]));
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0x02, 0x12, 0x34])); // header preserved
    expect(out.subarray(7, 9)).toEqual(Buffer.from([0xcc, 0xdd]));        // data pointer untouched
    // config = Low(0b11) | linked(0x04) | read(0x08) | transmit(0x40) = 0x4F; 0x80 dropped; type = 1 Byte = 7.
    expect(out[9]).toBe(0x4f);
    expect(out[10]).toBe(0x07);
  });

  test("an unconfigured object keeps its template entry verbatim, minus any stale linked bit", () => {
    // obj0 is not in `active`: its data pointer, type and the 0x80 bit stay, but the 0x04 it must
    // never keep (the template's stale link) is cleared. obj1 here is unconfigured too (config 0x84 -> 0x80).
    const out = buildComObjectTableMv0705(template, new Map(), new Set());
    expect(out.subarray(3, 7)).toEqual(Buffer.from([0xaa, 0xbb, 0x80, 0x00]));  // obj0: already unlinked
    expect(out.subarray(7, 11)).toEqual(Buffer.from([0xcc, 0xdd, 0x80, 0x00])); // obj1: stale 0x04 cleared
  });

  test("a template too short even for the header is REFUSED, never authored blind", () => {
    expect(() => buildComObjectTableMv0705(Buffer.from([0x01, 0x00]), new Map(), new Set()))
      .toThrow(/template.*too short|COM_OBJECT_TABLE_TEMPLATE_INVALID/i);
  });

  test("a template whose declared count overruns the buffer is REFUSED, not truncated", () => {
    // count=5 but only the 3-byte header is present: the first entry already runs off the end.
    expect(() => buildComObjectTableMv0705(Buffer.from([0x05, 0x00, 0x00]), new Map(), new Set()))
      .toThrow(ProductError);
  });

  test("a configured object whose size Busforge cannot express is REFUSED, never guessed", () => {
    const active = new Map([[0, obj({ number: 0, objectSize: "3 Cubits" })]]);
    expect(() => buildComObjectTableMv0705(template, active, new Set()))
      .toThrow(/cannot express|COM_OBJECT_SIZE_UNKNOWN/i);
  });

  test("an object numbered beyond the template's entry count is REFUSED, not silently dropped", () => {
    // The template declares 2 entries (objects 0 and 1); a config that activates object 2 (or links it)
    // has no slot in this L3, yet the association table would still reference it -> the device reads past
    // its L3 array. Refuse, like System B's declared-count guard, instead of dropping it silently.
    const active = new Map([[2, obj({ number: 2, objectSize: "1 Bit" })]]);
    expect(() => buildComObjectTableMv0705(template, active, new Set()))
      .toThrow(/beyond the 2-entry|COM_OBJECT_TABLE_TEMPLATE_INVALID/i);
    // and the same for a link (linked set) that points past the template
    expect(() => buildComObjectTableMv0705(template, new Map(), new Set([2])))
      .toThrow(/beyond the 2-entry|COM_OBJECT_TABLE_TEMPLATE_INVALID/i);
  });
});

// The real OpenKNX RaumController application is NOT committed as a fixture: it is 75 MB (4.5 MB
// gzipped, four times the whole existing corpus) and parsing it would cost every test run seconds
// and gigabytes. It is exercised where it counts instead, against the real device on the bus, and
// the layout above is what those runs depend on. See docs/commissioning.md.
describe("a System B application, end to end", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-00FA"><ApplicationPrograms>
<ApplicationProgram Id="M-00FA_A-A012-55-0000" ApplicationNumber="40978" ApplicationVersion="85" MaskVersion="MV-07B0" DefaultLanguage="de-DE" Name="RaumController">
<Static>
<ParameterTypes><ParameterType Id="M-00FA_A-A012-55-0000_PT-1"><TypeRestriction Base="Value" SizeInBit="1"><Enumeration Text="nein" Value="0"/><Enumeration Text="ja" Value="1"/></TypeRestriction></ParameterType></ParameterTypes>
<Parameters><Parameter Id="M-00FA_A-A012-55-0000_P-1" ParameterType="M-00FA_A-A012-55-0000_PT-1" Text="Kanal aktiv" Value="0"><Memory CodeSegment="M-00FA_A-A012-55-0000_RS-04-00000" Offset="0" BitOffset="0"/></Parameter></Parameters>
<ParameterRefs><ParameterRef Id="M-00FA_A-A012-55-0000_P-1_R-1" RefId="M-00FA_A-A012-55-0000_P-1"/></ParameterRefs>
<ComObjectTable>
<ComObject Id="M-00FA_A-A012-55-0000_O-1" Number="1" Name="Heartbeat" Text="In Betrieb" FunctionText="Zyklisch" ObjectSize="1 Byte" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/>
<ComObject Id="M-00FA_A-A012-55-0000_O-5" Number="5" Name="Presence" Text="Präsenz" FunctionText="Ausgang" ObjectSize="1 Bit" ReadFlag="Disabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" Priority="Alert"/>
</ComObjectTable>
<ComObjectRefs>
<ComObjectRef Id="M-00FA_A-A012-55-0000_O-1_R-1" RefId="M-00FA_A-A012-55-0000_O-1"/>
<ComObjectRef Id="M-00FA_A-A012-55-0000_O-5_R-5" RefId="M-00FA_A-A012-55-0000_O-5"/>
</ComObjectRefs>
<Code><RelativeSegment Id="M-00FA_A-A012-55-0000_RS-04-00000" Offset="0" Size="8" LoadStateMachine="4"/></Code>
</Static>
<Dynamic><ParameterBlock Id="M-00FA_A-A012-55-0000_PB-1" Name="Basis" Text="Basis">
<ParameterRefRef RefId="M-00FA_A-A012-55-0000_P-1_R-1"/>
<ComObjectRefRef RefId="M-00FA_A-A012-55-0000_O-1_R-1"/>
<choose ParamRefId="M-00FA_A-A012-55-0000_P-1_R-1">
  <when test="1"><ComObjectRefRef RefId="M-00FA_A-A012-55-0000_O-5_R-5"/></when>
</choose>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const cfg = parseAppConfig(xml);

  test("the program-id stamp is manufacturer + application number + version", () => {
    // PID 13, what a later parameter-only download compares itself against.
    expect(programIdStamp(cfg).toString("hex")).toBe("00faa01255");
  });

  test("the table is sized to the DECLARED objects; the ENTRIES follow the active config", () => {
    // O-5 is declared in a choose branch and only ACTIVATED when P-1=1. Either way the table must be
    // sized to object 5 (the firmware indexes by fixed number); only whether O-5 carries flags depends
    // on the configuration. Sizing to the active maximum shrank the table when the channel was off,
    // which is the L3 bug that reverted the OpenKNX RaumController.
    // Treat every active object as linked here so the entry flags reflect the declaration; the
    // Communication-flag-clearing for unlinked objects is covered by its own test above.
    const build = (params: Map<string, string>) => {
      const v = buildDeviceConfig(cfg, params);
      return buildComObjectTable(v.imageComObjects, v.maxComObjectNumber, new Set(v.imageComObjects.keys()));
    };

    const off = build(new Map());
    expect(off.readUInt16BE(0)).toBe(5); // O-5 is declared even though its channel is off
    expect(off.length).toBe(2 + 5 * 2);
    expect(off.subarray(2, 4)).toEqual(Buffer.from([0b0100_1111, 7])); // O-1: T+R+C, Low, 1 byte
    expect(off.subarray(10, 12)).toEqual(Buffer.from([0, 0])); // O-5 not activated: silent

    const on = build(new Map([["M-00FA_A-A012-55-0000_P-1_R-1", "1"]]));
    expect(on.readUInt16BE(0)).toBe(5);
    expect(on.subarray(4, 10)).toEqual(Buffer.alloc(6)); // 2..4 are gaps
    expect(on.subarray(10, 12)).toEqual(Buffer.from([0b0100_0110, 0])); // O-5 active: T+C, Alert, 1 bit
  });
});

