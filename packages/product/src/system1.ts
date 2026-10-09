import type { AppConfig, CfgAbsSegment } from "./appconfig.ts";
import type { LdStep } from "./loadproc.ts";
import type { ComObjectLink } from "./grouptables.ts";
import { LSM, OBJECT_TYPE_KNXNETIP, RETURN_CODE_ADDRESS_VOID, SECURITY_PID, type LoadPlan, type LoadStep } from "@busforge/knx";
import { buildAbsoluteSegmentTargets } from "./deviceimage.ts";
import { ProductError } from "./errors.ts";

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

// Resources of the master data inside the EEPROM segment, as offsets into it: the application id
// (manufacturer, application number, version) at 0x0104, whose first byte is the device's manufacturer
// id, the PEI type at 0x0109, the manufacturer-written hardware configuration at 0x010C, and the run
// error at 0x010D, which the load procedure sets to 00 while it loads and to FF when the application may run.
const BCU1_APPLICATION_ID = 0x04, BCU1_PEI_TYPE = 0x09, BCU1_HARDWARE_CONFIG = 0x0c;
export const BCU1_RUN_ERROR = 0x0d;

const applicationId = (cfg: AppConfig): Buffer => {
  const manufacturer = Number.parseInt(String(cfg.id).split("_")[0].replace("M-", ""), 16);
  return Buffer.from([manufacturer & 0xff, (cfg.appNumber >> 8) & 0xff, cfg.appNumber & 0xff, cfg.appVersion & 0xff]);
};

// The System 1 download an ETS capture shows: the MDT IP Interface Secure (MV-0012, IsSecureEnabled, a
// KNXnet/IP interface with additional addresses). ETS ran the master data's procedure with the security
// object's bracket and the KNXnet/IP parameter object's properties in place of its closing restart
// (planSystem1Download). Any other System 1 application would run a procedure no capture shows.
// Null where Busforge writes this application.
export function system1LoadRefusal(cfg: AppConfig): { code: string; message: string } | null {
  if (!DEFAULT_LOAD[cfg.mask]) {
    return { code: "SYSTEM1_LOAD_UNCAPTURED", message: `no ETS capture shows a System 1 download on ${cfg.mask}, and the master data's load procedure of ${cfg.mask} is not in Busforge; refusing to write this device` };
  }
  if (!cfg.loadProcedures.secureEnabled || !(cfg.additionalAddressesCount > 0) || cfg.loadProcedures.style !== "DefaultProcedure") {
    return { code: "SYSTEM1_LOAD_UNCAPTURED", message: `the only System 1 download an ETS capture shows is that of a Data Secure KNXnet/IP interface running the master data's procedure of ${cfg.mask}; what ETS writes besides that procedure for this application is not shown, so refusing to write it` };
  }
  // The procedure writes the group tables from the image, empty: an application with group objects, or
  // room for table entries, would lose its links, and no capture shows a System 1 table with entries.
  if (cfg.comObjects.size > 0 || (cfg.groupTables.addressMaxEntries ?? 0) > 0 || (cfg.groupTables.associationMaxEntries ?? 0) > 0) {
    return { code: "SYSTEM1_LOAD_UNCAPTURED", message: "this System 1 application has group objects or room for group-table entries, and the download that the ETS capture shows writes the group tables empty; refusing to write it" };
  }
  return null;
}

// What the System 1 download writes beyond the application's parameters: the device's KNXnet/IP
// settings, as the project holds them on its DeviceInstance (@busforge/project DeviceKnxIp).
// productName: the product's catalogue text, in the catalogue's default language; productNameTranslations:
// the same text in its other languages.
export interface KnxIpDevice {
  ia: string;
  instanceName: string;
  productName: string;
  productNameTranslations: string[];
  ipConfig: Record<string, string> | null;
  additionalAddresses: (number | null)[];
  securityAttributes: string[];
  toolKeyLoaded: boolean;
  busInterfaces: number;
  installation: Record<string, string>;
}

// The KNXnet/IP parameter object's properties (KNX 03_08_03) the download writes, in ETS's order.
export const KNXIP_PID = {
  PROJECT_INSTALLATION_ID: 51, ADDITIONAL_INDIVIDUAL_ADDRESSES: 53, IP_ASSIGNMENT_METHOD: 55,
  IP_ADDRESS: 60, SUBNET_MASK: 61, DEFAULT_GATEWAY: 62, MAC_ADDRESS: 64, ROUTING_MULTICAST_ADDRESS: 66, TTL: 67,
  FRIENDLY_NAME: 76, SECURED_SERVICE_FAMILIES: 94,
} as const;
const FRIENDLY_NAME_LENGTH = 30;

const refuseKnxIp = (why: string): never => {
  throw new ProductError("SYSTEM1_KNXIP_UNCAPTURED", `${why}; the ETS capture of this download does not show what ETS writes then, so refusing to write the device`);
};
const quad = (s: string | undefined, what: string): Buffer => {
  const m = s?.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const b = m ? m.slice(1).map(Number) : [];
  if (b.length !== 4 || b.some((x) => x > 255)) refuseKnxIp(`the project's ${what} reads ${JSON.stringify(s)}, not an IPv4 address`);
  return Buffer.from(b);
};

// The settings ETS's capture shows, and what it writes for them (ETS 6.4.1):
// - Installation without routing settings of its own (no InstallationId, no IPRoutingMulticastAddress, the
//   BCU key unset, the latency tolerance 2000): PID 51 = 0000, PID 66 = 224.0.23.12 and PID 67 = 32,
//   values the project does not hold (ETS's defaults; PID 67 overrides the TTL parameter's byte).
// - A device without its own name: PID 76 = the product's text, its first 30 characters. ETS takes the text
//   in its own language. Busforge keeps the language the device holds where its name is the product's text
//   in one of the catalogue's languages (`heldName`, read before the download), else the default language.
// - IPConfig Assign="Fixed": PID 55 = 01 (manual), PID 60-62 = the address, mask and gateway.
// - All of the application's additional addresses, on the device's line: PID 53, in the project's order.
// - The tool key loaded, nothing else pending in <Security>, no tunnelling users (<BusInterface>): no key,
//   password or authentication code written, IP Secure left off (PID 94 for the families 5, 3 and 4).
// Anything else is refused.
export function knxIpWrites(cfg: AppConfig, dev: KnxIpDevice, heldName?: Buffer | null): { pid: number; count: number; data: Buffer }[] {
  const inst = dev.installation;
  for (const k of Object.keys(inst)) if (!["Name", "BCUKey", "IPRoutingLatencyTolerance"].includes(k)) refuseKnxIp(`the project's installation sets ${k}`);
  if (inst.BCUKey !== undefined && inst.BCUKey !== "4294967295") refuseKnxIp("the project's installation sets a BCU key");
  if (inst.IPRoutingLatencyTolerance !== undefined && inst.IPRoutingLatencyTolerance !== "2000") refuseKnxIp(`the project's IP routing latency tolerance is ${inst.IPRoutingLatencyTolerance}, not 2000`);
  if (dev.instanceName !== "") refuseKnxIp("the device has a name of its own in the project");
  const names = [dev.productName, ...dev.productNameTranslations].map((n) => n.slice(0, FRIENDLY_NAME_LENGTH));
  const name = names.find((n) => heldName && Buffer.from(n, "latin1").equals(heldName)) ?? names[0];
  if (!/^[\x20-\x7e]*$/.test(name) || name.length < FRIENDLY_NAME_LENGTH) refuseKnxIp(`the device's product name ${JSON.stringify(name)} is not ${FRIENDLY_NAME_LENGTH} or more printable ASCII characters`);
  const ip = dev.ipConfig;
  if (!ip) refuseKnxIp("the project holds no IP configuration for the device");
  for (const k of Object.keys(ip!)) if (!["Assign", "IPAddress", "SubnetMask", "DefaultGateway", "MACAddress"].includes(k)) refuseKnxIp(`the device's IP configuration sets ${k}`);
  if (ip!.Assign !== "Fixed") refuseKnxIp(`the device's IP address is assigned "${ip!.Assign}", not "Fixed"`);
  if (dev.additionalAddresses.length !== cfg.additionalAddressesCount) refuseKnxIp(`the project gives the device ${dev.additionalAddresses.length} additional addresses where its application takes ${cfg.additionalAddressesCount}`);
  const [area, line] = dev.ia.split(".").map(Number);
  const extra = Buffer.alloc(2 * dev.additionalAddresses.length);
  dev.additionalAddresses.forEach((a, i) => {
    if (a === null || !Number.isInteger(a) || a < 0 || a > 255) refuseKnxIp(`the device's additional address ${a} is not a device address`);
    extra.writeUInt16BE((area << 12) | (line << 8) | a!, 2 * i);
  });
  for (const k of dev.securityAttributes) if (!["ToolKey", "LoadedToolKey", "SequenceNumber", "SequenceNumberTimestamp", "LoadedDeviceAuthenticationCodeHash"].includes(k)) refuseKnxIp(`the device's security settings hold ${k}`);
  if (!dev.toolKeyLoaded) refuseKnxIp("the project holds a tool key for the device that it has not loaded");
  if (dev.busInterfaces > 0) refuseKnxIp("the project configures tunnelling users on the device");
  return [
    { pid: KNXIP_PID.PROJECT_INSTALLATION_ID, count: 1, data: Buffer.from([0x00, 0x00]) },
    { pid: KNXIP_PID.ROUTING_MULTICAST_ADDRESS, count: 1, data: Buffer.from([224, 0, 23, 12]) },
    { pid: KNXIP_PID.TTL, count: 1, data: Buffer.from([32]) },
    { pid: KNXIP_PID.FRIENDLY_NAME, count: FRIENDLY_NAME_LENGTH, data: Buffer.from(name, "latin1") },
    { pid: KNXIP_PID.IP_ASSIGNMENT_METHOD, count: 1, data: Buffer.from([0x01]) },
    { pid: KNXIP_PID.IP_ADDRESS, count: 1, data: quad(ip!.IPAddress, "IP address") },
    { pid: KNXIP_PID.SUBNET_MASK, count: 1, data: quad(ip!.SubnetMask, "subnet mask") },
    { pid: KNXIP_PID.DEFAULT_GATEWAY, count: 1, data: quad(ip!.DefaultGateway, "default gateway") },
    { pid: KNXIP_PID.ADDITIONAL_INDIVIDUAL_ADDRESSES, count: dev.additionalAddresses.length, data: extra },
  ];
}

// The service families ETS switches to unsecured with PID 94 (command 00, family, 00): routing (5),
// device management (3), tunnelling (4), in this order. ETS maps one error of these commands to success
// (LdCtrlMapError 3221498661); which return code of the device that is, no capture shows (the unit answered
// 0 each time), so Busforge stops on any other than 0, after the properties and before the restart.
const UNSECURED_FAMILIES = [0x05, 0x03, 0x04];

export interface System1Download {
  plan: LoadPlan;
  image: Buffer;            // the EEPROM segment as ETS images it
  written: boolean[];       // the segment's bytes the plan writes from the image
  verify: boolean[];        // those of them that read back as written (an Access="None" parameter's byte the device restamps is not)
  knxIp: { pid: number; count: number; data: Buffer }[];
}

// The download of a Data Secure KNXnet/IP interface on a System 1 mask, as ETS 6.4.1 ran it on the MDT IP
// Interface Secure (captures/mdt-ip-secure-ets6log-fulldownload.txt):
// - the image: the segment's <Data>, the parameters' values over it, the application id and PEI type
//   at their resources (the template's <Data> carries the original manufacturer's);
// - the master data's procedure, each LdCtrlWriteMem without InlineData written from the image where the
//   <Mask> marks a byte or a parameter covers it, in one write per run of such bytes (ETS's image shows the
//   others as "--": the unit's IP settings and name, which it takes as properties);
// - in place of its closing LdCtrlRestart: the security object unloaded, loaded, its individual address
//   table cleared (the unit has none and answers E_ADDRESS_VOID, which ETS ignores), loaded completed; the
//   KNXnet/IP object's MAC address read, its properties written (knxIpWrites); IP Secure switched off for
//   the families ETS names; the confirmed restart.
// LdCtrlLoadImageMem writes nothing (ETS takes the image's byte there, written by the later WriteMem).
export function planSystem1Download(cfg: AppConfig, params: Map<string, string>, dev: KnxIpDevice, heldName?: Buffer | null): System1Download {
  const refusal = system1LoadRefusal(cfg);
  if (refusal) throw new ProductError(refusal.code, refusal.message);
  const seg = bcu1Segment(cfg);
  if (!seg) throw new ProductError("SYSTEM1_LOAD_UNCAPTURED", "the application declares no EEPROM segment at 0x0100 of 256 bytes; refusing to write it");
  const target = buildAbsoluteSegmentTargets(cfg, params).find((t) => t.id === seg.id);
  const image = Buffer.from(target?.bytes ?? seg.data);
  if (image.length !== seg.size) throw new ProductError("SYSTEM1_LOAD_UNCAPTURED", `the application's segment image holds ${image.length} of ${seg.size} bytes; refusing to write a partial image`);
  applicationId(cfg).copy(image, BCU1_APPLICATION_ID);
  image[BCU1_PEI_TYPE] = cfg.appPeiType & 0xff;
  // A byte the procedure writes from the image (an LdCtrlWriteMem without InlineData covers it) where the
  // <Mask> marks it or a parameter covers it.
  const fromImage = new Array<boolean>(seg.size).fill(false);
  for (const st of DEFAULT_LOAD[cfg.mask]) {
    if (st.verb !== "LdCtrlWriteMem" || st.attrs.InlineData !== undefined) continue;
    for (let a = Number(st.attrs.Address); a < Number(st.attrs.Address) + Number(st.attrs.Size); a++) if (a >= seg.address && a < seg.address + seg.size) fromImage[a - seg.address] = true;
  }
  const written = fromImage.map((f, i) => f && ((seg.mask ? seg.mask[i] !== 0 : true) || (target?.owned[i] ?? 0) !== 0));
  const verify = written.map((w, i) => w && ((target?.owned[i] ?? 0) === 0 || target!.verify[i] !== 0));
  const knxIp = knxIpWrites(cfg, dev, heldName);

  const plan: LoadPlan = [];
  for (const st of DEFAULT_LOAD[cfg.mask]) {
    const a = st.attrs;
    switch (st.verb) {
      case "LdCtrlConnect": case "LdCtrlSetControlVariable": case "LdCtrlLoadImageMem": break;
      case "LdCtrlWriteMem": {
        const at = Number(a.Address), size = Number(a.Size);
        if (a.InlineData !== undefined) {
          const bytes = Buffer.from(a.InlineData, "hex");
          const runError = at === seg.address + BCU1_RUN_ERROR && bytes.length === 1;
          plan.push({ op: "writeMem", address: at, bytes, ...(runError && bytes[0] === 0x00 ? { opens: "run error" } : runError && bytes[0] === 0xff ? { closes: "run error" } : {}) });
          break;
        }
        if (at < seg.address || at + size > seg.address + seg.size) throw new ProductError("SYSTEM1_LOAD_UNCAPTURED", `the procedure writes ${hex(at)}+${size} from the image, outside the segment; refusing to write it`);
        for (let i = at - seg.address; i < at - seg.address + size;) {
          if (!written[i]) { i++; continue; }
          const from = i;
          while (i < at - seg.address + size && written[i]) i++;
          plan.push({ op: "writeMem", address: seg.address + from, bytes: Buffer.from(image.subarray(from, i)) });
        }
        break;
      }
      case "LdCtrlRestart":
        plan.push(
          { op: "securityLsm", event: LSM.UNLOAD },
          { op: "securityLsm", event: LSM.LOAD },
          { op: "writeSecurityProp", pid: SECURITY_PID.SECURITY_IA_TABLE, start: 0, elementSize: 2, data: Buffer.alloc(2), tolerate: RETURN_CODE_ADDRESS_VOID },
          { op: "securityLsm", event: LSM.LOAD_COMPLETED },
          { op: "readPropExt", objectType: OBJECT_TYPE_KNXNETIP, instance: 1, pid: KNXIP_PID.MAC_ADDRESS, start: 1, count: 1 },
          ...knxIp.map((w): LoadStep => ({ op: "writePropExt", objectType: OBJECT_TYPE_KNXNETIP, instance: 1, pid: w.pid, start: 1, count: w.count, data: w.data })),
          ...UNSECURED_FAMILIES.map((f): LoadStep => ({ op: "funcPropExt", objectType: OBJECT_TYPE_KNXNETIP, instance: 1, pid: KNXIP_PID.SECURED_SERVICE_FAMILIES, data: Buffer.from([0x00, 0x00, f, 0x00]) })),
          { op: "restart", confirmed: true, requireReboot: false },
        );
        break;
      default:
        throw new ProductError("SYSTEM1_LOAD_UNCAPTURED", `the load procedure of ${cfg.mask} holds ${st.verb}, which no capture shows; refusing to write the device`);
    }
  }
  return { plan, image, written, verify, knxIp };
}

// Why a device's EEPROM segment, read before the download, is not one this download may be run on, or
// null where it may: ETS reads the manufacturer id (0x0104) and the hardware configuration (0x010C) first
// and writes the image's byte at 0x010C; a unit of another manufacturer, or one whose hardware
// configuration is not the image's, is a case the capture does not show.
export function system1PreconditionRefusal(cfg: AppConfig, image: Buffer, eeprom: Buffer): { code: string; message: string } | null {
  const manufacturer = applicationId(cfg)[0];
  if (eeprom[BCU1_APPLICATION_ID] !== manufacturer) {
    return { code: "SYSTEM1_UNIT_UNCAPTURED", message: `the device's manufacturer id reads ${eeprom[BCU1_APPLICATION_ID].toString(16).padStart(2, "0")}, the application's is ${manufacturer.toString(16).padStart(2, "0")}; refusing to write it` };
  }
  if (eeprom[BCU1_HARDWARE_CONFIG] !== image[BCU1_HARDWARE_CONFIG]) {
    return { code: "SYSTEM1_UNIT_UNCAPTURED", message: `the device's hardware configuration at 0x010C reads ${eeprom[BCU1_HARDWARE_CONFIG].toString(16).padStart(2, "0")} where the image holds ${image[BCU1_HARDWARE_CONFIG].toString(16).padStart(2, "0")}; the manufacturer writes that byte, so refusing to overwrite it` };
  }
  return null;
}

export const SYSTEM1_GROUP_TABLES_REFUSAL = {
  code: "SYSTEM1_GROUP_TABLES_UNCAPTURED",
  message: "no ETS capture shows a System 1 group-address download; refusing to write the device's group tables",
} as const;

// Why a read of the EEPROM segment is not this application's state, or null where it is: the unit holds
// another application id or PEI type than the application, or its run error says a load did not complete
// (a factory unit, another application, an interrupted download). Decoding such bytes as this
// application's parameters would make a baseline of bytes that are not its.
export function bcu1ApplicationRefusal(cfg: AppConfig, eeprom: Buffer): { code: string; message: string } | null {
  const want = applicationId(cfg);
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
