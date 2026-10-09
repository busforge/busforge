import type { AppConfig, CfgAbsSegment } from "./appconfig.ts";
import type { LdStep } from "./loadproc.ts";
import type { ComObjectLink } from "./grouptables.ts";

// System 1 (BCU1) as the KNX master data describes it (knx_master.xml, MaskVersion MV-0010 to MV-0013,
// MV-1011 to MV-1013): one EEPROM segment of 256 bytes at 0x0100 that holds the application's
// parameters and every table, and a load procedure fixed by the mask (an application declaring
// LoadProcedureStyle="DefaultProcedure" carries none of its own).

export const BCU1_EEPROM = { address: 0x0100, size: 256 } as const;

// The group-table resources every BCU1 mask of the master data places at the same addresses: the address
// table (count byte, the device's own individual address, then the group addresses) at 0x0116, and the
// association table behind a one-byte pointer at 0x0111 that is added to 0x0100 (Ptr_StandardMemory100).
const BCU1_ADDRESS_TABLE = 0x0116;
const BCU1_ASSOCIATION_POINTER = 0x0111;

// The Load procedure of MV-0012 in the master data, step for step. ETS runs it for a DefaultProcedure
// application on this mask. LdCtrlWriteMem without InlineData writes the image's bytes there.
export const MV0012_DEFAULT_LOAD: readonly LdStep[] = [
  { verb: "LdCtrlConnect", attrs: {} },
  { verb: "LdCtrlSetControlVariable", attrs: { Name: "EnableVerifyOnWriteDirect", Value: "true" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "269", Size: "1", Verify: "true", InlineData: "00" } },
  { verb: "LdCtrlLoadImageMem", attrs: { Address: "278", Size: "1" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "278", Size: "1", Verify: "true", InlineData: "01" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "256", Size: "1", Verify: "true" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "260", Size: "9", Verify: "true" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "270", Size: "8", Verify: "true" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "281", Size: "230", Verify: "true" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "206", Size: "9", Verify: "true", InlineData: "000000000000000000" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "215", Size: "9", Verify: "true", InlineData: "000000000000000000" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "278", Size: "1", Verify: "true" } },
  { verb: "LdCtrlWriteMem", attrs: { Address: "269", Size: "1", Verify: "true", InlineData: "FF" } },
  { verb: "LdCtrlRestart", attrs: {} },
];

const DEFAULT_LOAD: Readonly<Record<string, readonly LdStep[]>> = { "MV-0012": MV0012_DEFAULT_LOAD };

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;

// The bytes a run of the default procedure writes from the image that the <Mask> of the application's
// segment leaves out, as address ranges. On the MDT IP Interface Secure these are where the unit keeps
// its IP configuration and its name, which the project sets as device properties, not parameters.
export function bcu1UnmarkedImageWrites(cfg: AppConfig, steps: readonly LdStep[]): { from: number; to: number }[] {
  const unmarked: number[] = [];
  for (const st of steps) {
    if (st.verb !== "LdCtrlWriteMem" || st.attrs.InlineData !== undefined) continue;
    const at = Number(st.attrs.Address), size = Number(st.attrs.Size);
    for (let a = at; a < at + size; a++) {
      const seg = cfg.absoluteSegments.find((s) => a >= s.address && a < s.address + s.size);
      if (!seg || (seg.mask && seg.mask[a - seg.address] === 0)) unmarked.push(a);
    }
  }
  const ranges: { from: number; to: number }[] = [];
  for (const a of [...new Set(unmarked)].sort((x, y) => x - y)) {
    const last = ranges[ranges.length - 1];
    if (last && last.to === a - 1) last.to = a;
    else ranges.push({ from: a, to: a });
  }
  return ranges;
}

// Why Busforge does not write a System 1 device: no ETS capture of a System 1 download exists, so neither
// the bytes ETS takes for the ranges the <Mask> leaves out nor the interface-object properties it writes
// besides the mask's procedure are known. The parameter download is the same procedure (the mask declares
// only "all"), so it is refused with the full download.
export function system1LoadRefusal(cfg: AppConfig): { code: string; message: string } {
  const steps = DEFAULT_LOAD[cfg.mask];
  if (!steps) {
    return { code: "SYSTEM1_LOAD_UNCAPTURED", message: `no ETS capture of a System 1 download exists, and the master data's load procedure of ${cfg.mask} is not in Busforge; refusing to write this device` };
  }
  const unmarked = bcu1UnmarkedImageWrites(cfg, steps);
  const where = unmarked.length
    ? `; the procedure writes ${unmarked.map((r) => (r.from === r.to ? hex(r.from) : `${hex(r.from)}-${hex(r.to)}`)).join(", ")} from the image, which the application's <Mask> leaves out`
    : "";
  return { code: "SYSTEM1_LOAD_UNCAPTURED", message: `no ETS capture of a System 1 download shows what ETS writes besides the load procedure of ${cfg.mask}${where}, nor where its image differs from <Data> (a unit ETS programmed holds the application's own id and PEI type at 0x0104-0x0107 and 0x0109, not the template's); refusing to write this device rather than overwrite what it holds there` };
}

export const SYSTEM1_GROUP_TABLES_REFUSAL = {
  code: "SYSTEM1_GROUP_TABLES_UNCAPTURED",
  message: "no ETS capture shows a System 1 group-address download; refusing to write the device's group tables",
} as const;

// Resources of the master data inside the EEPROM segment, as offsets into it: the application id
// (manufacturer, application number, version) at 0x0104, the PEI type at 0x0109, the run error at 0x010D,
// which the load procedure sets to 00 while it loads and to FF when the application may run.
const BCU1_APPLICATION_ID = 0x04, BCU1_PEI_TYPE = 0x09, BCU1_RUN_ERROR = 0x0d;

// Why a read of the EEPROM segment is not this application's state, or null where it is: the unit holds
// another application id or PEI type than the application, or its run error says a load did not complete
// (a factory unit, another application, an interrupted download). Decoding such bytes as this
// application's parameters would make a baseline of bytes that are not its.
export function bcu1ApplicationRefusal(cfg: AppConfig, eeprom: Buffer): { code: string; message: string } | null {
  const manufacturer = Number.parseInt(String(cfg.id).split("_")[0].replace("M-", ""), 16);
  const want = Buffer.from([manufacturer & 0xff, (cfg.appNumber >> 8) & 0xff, cfg.appNumber & 0xff, cfg.appVersion & 0xff]);
  const have = eeprom.subarray(BCU1_APPLICATION_ID, BCU1_APPLICATION_ID + 4);
  if (!have.equals(want) || eeprom[BCU1_PEI_TYPE] !== (cfg.appPeiType & 0xff)) {
    return { code: "SYSTEM1_APPLICATION_MISMATCH", message: `the device holds application id ${have.toString("hex")} with PEI type ${eeprom[BCU1_PEI_TYPE]}, the application is ${want.toString("hex")} with PEI type ${cfg.appPeiType}; refusing to read its memory as this application's` };
  }
  if (eeprom[BCU1_RUN_ERROR] !== 0xff) {
    return { code: "SYSTEM1_APPLICATION_MISMATCH", message: `the device's run error reads ${eeprom[BCU1_RUN_ERROR].toString(16).padStart(2, "0")}, not FF: its last load did not complete; refusing to read its memory as this application's` };
  }
  return null;
}

// The EEPROM segment among the application's absolute segments, or undefined where it declares none.
export function bcu1Segment(cfg: AppConfig): CfgAbsSegment | undefined {
  return cfg.absoluteSegments.find((s) => s.address === BCU1_EEPROM.address && s.size === BCU1_EEPROM.size);
}

// The links the group tables in a read of the EEPROM segment hold, or null where they cannot be told: an
// address table that holds group addresses or an association table with entries (no device has shown
// Busforge the BCU1 entry layout), or a table that does not fit the segment. The empty tables are the
// form an application without group objects leaves: the address table holds only the device's own address.
export function decodeEmptyBcu1Tables(eeprom: Buffer): ComObjectLink[] | null {
  if (eeprom.length !== BCU1_EEPROM.size) return null;
  const addrCount = eeprom[BCU1_ADDRESS_TABLE - BCU1_EEPROM.address];
  const assocAt = eeprom[BCU1_ASSOCIATION_POINTER - BCU1_EEPROM.address];
  const assocCount = eeprom[assocAt];
  return addrCount === 1 && assocCount === 0 ? [] : null;
}
