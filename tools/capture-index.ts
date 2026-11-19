#!/usr/bin/env bun
// An index of the private corpus's captures: per file, which tool talked (ETS or Busforge), to which units,
// what each unit's device descriptor 0 said (its mask version), which addresses were assigned, which
// services went each way and which interface-object/PID pairs were touched. It answers "does a capture show
// X" by a lookup instead of a hex search through memory dumps.
//
//   BUSFORGE_CORPUS=<corpus> bun run tools/capture-index.ts
//
// writes internal/captures/INDEX.md (for reading and grep) and internal/captures/index.json (every field,
// for scripts) into the corpus. It walks captures/, internal/captures/ and collections/ and reads three
// telegram formats, each with the decoder of its kind:
//
//   knxproxy      the log of tools/knxproxy.ts (also tools/pcap.ts's output): each frame's hex decoded here
//   ets6log       ETS 6's own log (Falcon.KnxStack lines): ETS's decode, read as ETS wrote it
//   groupmonitor  the group-telegram listener logs of the bench and house runs (GROUP <src> -> <ga> ...)
//
// A file in none of them, or in more than one, is listed with the reason it was not read; a line of a read
// file whose frame does not decode is counted in that file's row, never skipped silently.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extname, join } from "node:path";
import { APCI, CEMI, CEMI_CON_ERROR, SVC, decodeGroupApdu, numToGa, numToIa } from "../packages/knx/src/frame.ts";
import { parseTunnelFrame } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";
import { corpusRoot, CORPUS_ENV } from "./corpus.ts";

export const INDEX_DIRS = ["captures", "internal/captures", "collections"] as const;
export const INDEX_MD = "internal/captures/INDEX.md";
export const INDEX_JSON = "internal/captures/index.json";

export type Format = "knxproxy" | "pcap" | "ets6log" | "groupmonitor";
// The client's name in a pcap capture: a sniffer's file does not say which tool sent its frames.
export const PCAP_CLIENT = "client";

export interface ServiceCount { sent: number; received: number }
export interface Device { address: string; descriptor0: string[] }
export interface IndexedFile {
  file: string;
  format: Format;
  // The tool on the client side of a proxy log as the proxy names it (PROXY_TOOL, whose default is ETS), ETS for
  // its own log, PCAP_CLIENT for a pcap capture; none for a group monitor.
  tools: string[];
  // Whose frame builder the tool's point-to-point and broadcast frames in a proxy log come from, by their first
  // cEMI control field (FRAME_BUILDERS); "other" for a control field neither sets, "mixed" for more than one
  // kind, null where none was sent or the format shows no frame.
  framesBuiltAs: "ETS" | "Busforge" | "other" | "mixed" | null;
  telegrams: number;
  devices: Device[];
  // Addresses written by A_IndividualAddress_Write or A_IndividualAddressSerialNumber_Write.
  assigned: string[];
  // Sent = from the tool, received = from the bus. A group monitor receives, apart from the reads its listener
  // names ("read <ga> con OK", "SEND READ <ga>").
  services: Record<string, ServiceCount>;
  // Requests the interface confirmed negatively (an L_Data.con with its error bit, a listener's "con" other than
  // OK): counted as sent above, they never reached the bus.
  notOnBus: number;
  // "<object index>/<PID>", "t<object type>.<instance>/<PID>" (extended services), "if t<type>.<instance>/<PID>"
  // (cEMI local management of the interface itself).
  properties: string[];
  groupAddresses: number;
  // A_SecureService telegrams, and how many of them show the service inside (ETS's log does, a proxy log
  // carries it encrypted).
  secure: { telegrams: number; innerShown: number };
  // ETS's download actions on its log, e.g. "StartLoadDevice(Partial) 1.1.18".
  etsActions: string[];
  // Lines of this format whose telegram did not decode, with the first line numbers.
  undecoded: { count: number; lines: number[] };
}
export interface NotIndexed { file: string; reason: string }
export interface CaptureIndex { format: "busforge-capture-index/1"; dirs: readonly string[]; files: IndexedFile[]; notIndexed: NotIndexed[] }

// ── service names ─────────────────────────────────────────────────────────────

// Application-layer services by their 10-bit APCI (KNX 3/3/7). The table names only what the standard
// fixes, an A_Restart's restart type in brackets; any other APCI is shown as its number.
const EXACT_APCI: Record<number, string> = {
  [APCI.MEMORY_EXT_WRITE]: "A_MemoryExtended_Write", [APCI.MEMORY_EXT_WRITE_RESP]: "A_MemoryExtended_WriteResponse",
  [APCI.MEMORY_EXT_READ]: "A_MemoryExtended_Read", [APCI.MEMORY_EXT_READ_RESP]: "A_MemoryExtended_ReadResponse",
  0x1c8: "A_SystemNetworkParameter_Read", 0x1c9: "A_SystemNetworkParameter_Response", 0x1ca: "A_SystemNetworkParameter_Write",
  [APCI.PROPERTY_EXT_READ]: "A_PropertyExtValue_Read", [APCI.PROPERTY_EXT_RESPONSE]: "A_PropertyExtValue_Response",
  [APCI.PROPERTY_EXT_WRITE_CON]: "A_PropertyExtValue_WriteCon", [APCI.PROPERTY_EXT_WRITE_CON_RESP]: "A_PropertyExtValue_WriteConRes",
  0x1d0: "A_PropertyExtValue_WriteUnCon", 0x1d2: "A_PropertyExtDescription_Read", 0x1d3: "A_PropertyExtDescription_Response",
  [APCI.FUNCTION_PROPERTY_EXT_COMMAND]: "A_FunctionPropertyExtCommand",
  [APCI.FUNCTION_PROPERTY_EXT_STATE_READ]: "A_FunctionPropertyExtState_Read",
  [APCI.FUNCTION_PROPERTY_EXT_STATE_RESPONSE]: "A_FunctionPropertyExtState_Response",
  0x2c0: "A_UserMemory_Read", 0x2c1: "A_UserMemory_Response", 0x2c2: "A_UserMemory_Write", 0x2c4: "A_UserMemoryBit_Write",
  0x2c5: "A_UserManufacturerInfo_Read", 0x2c6: "A_UserManufacturerInfo_Response",
  0x2c7: "A_FunctionPropertyCommand", 0x2c8: "A_FunctionPropertyState_Read", 0x2c9: "A_FunctionPropertyState_Response",
  [APCI.RESTART]: "A_Restart", 0x381: "A_Restart (master reset)", 0x3a1: "A_Restart_Response",
  0x3d0: "A_MemoryBit_Write", [APCI.AUTHORIZE_REQUEST]: "A_Authorize_Request", [APCI.AUTHORIZE_RESPONSE]: "A_Authorize_Response",
  0x3d3: "A_Key_Write", 0x3d4: "A_Key_Response",
  [APCI.PROPERTY_READ]: "A_PropertyValue_Read", [APCI.PROPERTY_RESPONSE]: "A_PropertyValue_Response", [APCI.PROPERTY_WRITE]: "A_PropertyValue_Write",
  [APCI.PROPERTY_DESCRIPTION_READ]: "A_PropertyDescription_Read", [APCI.PROPERTY_DESCRIPTION_RESPONSE]: "A_PropertyDescription_Response",
  0x3da: "A_NetworkParameter_Read", 0x3db: "A_NetworkParameter_Response", 0x3e4: "A_NetworkParameter_Write",
  [APCI.IA_SERIAL_READ]: "A_IndividualAddressSerialNumber_Read", [APCI.IA_SERIAL_RESPONSE]: "A_IndividualAddressSerialNumber_Response",
  [APCI.IA_SERIAL_WRITE]: "A_IndividualAddressSerialNumber_Write",
  0x3e0: "A_DomainAddress_Write", 0x3e1: "A_DomainAddress_Read", 0x3e2: "A_DomainAddress_Response", 0x3e3: "A_DomainAddressSelective_Read",
  0x3e5: "A_Link_Read", 0x3e6: "A_Link_Response", 0x3e7: "A_Link_Write",
  0x3ec: "A_DomainAddressSerialNumber_Read", 0x3ed: "A_DomainAddressSerialNumber_Response", 0x3ee: "A_DomainAddressSerialNumber_Write",
  0x3f0: "A_FileStream_InfoReport", 0x3f1: "A_SecureService",
};
// Services whose low six APCI bits carry data (a value, a count, a descriptor type, a channel): named by
// their top four bits. The exact table is asked first, since the extended services share 0x1c0's range.
const GROUPED_APCI: Record<number, string> = {
  0x000: "A_GroupValue_Read", 0x040: "A_GroupValue_Response", 0x080: "A_GroupValue_Write",
  [APCI.INDIVIDUAL_ADDRESS_WRITE]: "A_IndividualAddress_Write", [APCI.INDIVIDUAL_ADDRESS_READ]: "A_IndividualAddress_Read",
  [APCI.INDIVIDUAL_ADDRESS_RESPONSE]: "A_IndividualAddress_Response",
  0x180: "A_ADC_Read", 0x1c0: "A_ADC_Response",
  [APCI.MEMORY_READ]: "A_Memory_Read", [APCI.MEMORY_RESPONSE]: "A_Memory_Response", [APCI.MEMORY_WRITE]: "A_Memory_Write",
  [APCI.DEVICE_DESCRIPTOR_READ]: "A_DeviceDescriptor_Read", [APCI.DEVICE_DESCRIPTOR_RESPONSE]: "A_DeviceDescriptor_Response",
};

export function apciName(apci: number): string {
  // A_ADC_Response's channel stops where the extended services start, so an unlisted code from 0x1c8 is no ADC.
  const grouped = (apci & 0x3c0) === 0x1c0 && apci >= 0x1c8 ? undefined : GROUPED_APCI[apci & 0x3c0];
  return EXACT_APCI[apci] ?? grouped ?? `apci 0x${apci.toString(16).padStart(3, "0")}`;
}
// The extended property and function-property services: a 16-bit object type, a 12-bit instance, a 12-bit PID.
const EXT_PROPERTY_APCIS = new Set([
  APCI.PROPERTY_EXT_READ, APCI.PROPERTY_EXT_RESPONSE, APCI.PROPERTY_EXT_WRITE_CON, APCI.PROPERTY_EXT_WRITE_CON_RESP, 0x1d0, 0x1d2, 0x1d3,
  APCI.FUNCTION_PROPERTY_EXT_COMMAND, APCI.FUNCTION_PROPERTY_EXT_STATE_READ, APCI.FUNCTION_PROPERTY_EXT_STATE_RESPONSE,
]);
// The services addressing a property by object index and PID, in their first two data octets.
const PROPERTY_APCIS = new Set([
  APCI.PROPERTY_READ, APCI.PROPERTY_RESPONSE, APCI.PROPERTY_WRITE, APCI.PROPERTY_DESCRIPTION_READ, APCI.PROPERTY_DESCRIPTION_RESPONSE,
  0x2c7, 0x2c8, 0x2c9,
]);

// cEMI local device management (KNXnet/IP DEVICE_CONFIGURATION_REQUEST), by message code.
const CEMI_MGMT: Record<number, string> = {
  0xfc: "M_PropRead.req", 0xfb: "M_PropRead.con", 0xf6: "M_PropWrite.req", 0xf5: "M_PropWrite.con",
  0xf7: "M_PropInfo.ind", 0xf8: "M_FuncPropCommand.req", 0xf9: "M_FuncPropStateRead.req",
  0xfa: "M_FuncPropCommand/StateRead.con", 0xf1: "M_Reset.req", 0xf0: "M_Reset.ind",
};
// The messages that name an interface object type (2 octets), its instance and a PID after the message code.
const CEMI_PROP_CODES = new Set([0xfc, 0xfb, 0xf6, 0xf5, 0xf7, 0xf8, 0xf9, 0xfa]);
// KNXnet/IP services that carry no telegram: search, description, connection management, the tunnelling
// acknowledgement and feature exchange (0x0422 to 0x0424). Any other service is counted as undecoded.
const CONTROL_SERVICES = new Set<number>([
  SVC.SEARCH_REQ, SVC.SEARCH_RES, SVC.DESCRIPTION_REQ, SVC.DESCRIPTION_RES, SVC.SEARCH_REQ_EXT, SVC.SEARCH_RES_EXT,
  SVC.CONNECT_REQ, SVC.CONNECT_RES, SVC.CONNECTIONSTATE_REQ, SVC.CONNECTIONSTATE_RES, SVC.DISCONNECT_REQ, SVC.DISCONNECT_RES,
  SVC.DEVICE_CONFIG_ACK, SVC.TUNNEL_ACK, 0x0422, 0x0423, 0x0424,
]);

// The first cEMI control field of an L_Data.req the tool sends to a unit or as a broadcast. Busforge's
// cemiLData (packages/knx/src/frame.ts) sets 0xBC, or 0x3C for an extended frame; ETS 6 sets 0xB0 or 0x30
// in every capture of the corpus that ETS's own log names. A proxy names its client by PROXY_TOOL with the
// default ETS, so a Busforge run through a proxy started without it reads ETS; the frames tell them apart.
// Group telegrams are left out: ETS sends some of those with 0xBC.
const FRAME_BUILDERS: Record<number, "ETS" | "Busforge"> = { 0xb0: "ETS", 0x30: "ETS", 0xbc: "Busforge", 0x3c: "Busforge" };

// ── per-file accumulation ─────────────────────────────────────────────────────

class FileStats {
  readonly tools = new Set<string>();
  readonly builders = new Set<string>();
  telegrams = 0;
  readonly devices = new Map<string, Set<string>>();
  readonly assigned = new Set<string>();
  readonly services = new Map<string, ServiceCount>();
  readonly properties = new Set<string>();
  readonly groups = new Set<string>();
  secure = 0;
  innerShown = 0;
  notOnBus = 0;
  readonly etsActions = new Set<string>();
  readonly undecoded: number[] = [];

  service(name: string, sent: boolean): void {
    const c = this.services.get(name) ?? { sent: 0, received: 0 };
    if (sent) c.sent++; else c.received++;
    this.services.set(name, c);
  }
  device(address: string, descriptor0?: string): void {
    const d = this.devices.get(address) ?? new Set<string>();
    if (descriptor0 !== undefined) d.add(descriptor0);
    this.devices.set(address, d);
  }
  result(file: string, format: Format): IndexedFile {
    return {
      file, format,
      tools: [...this.tools].sort(),
      framesBuiltAs: this.builders.size === 0 ? null : this.builders.size > 1 ? "mixed" : ([...this.builders][0] as IndexedFile["framesBuiltAs"]),
      telegrams: this.telegrams,
      devices: [...this.devices.keys()].sort(byAddress).map((address) => ({ address, descriptor0: [...this.devices.get(address)!].sort() })),
      assigned: [...this.assigned].sort(byAddress),
      services: Object.fromEntries([...this.services.entries()].sort(([a], [b]) => byText(a, b))),
      notOnBus: this.notOnBus,
      properties: [...this.properties].sort(propertyOrder),
      groupAddresses: this.groups.size,
      secure: { telegrams: this.secure, innerShown: this.innerShown },
      etsActions: [...this.etsActions].sort(),
      undecoded: { count: this.undecoded.length, lines: this.undecoded.slice(0, 5) },
    };
  }
}

// Plain code-unit order, so the output does not depend on the runtime's locale.
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Individual addresses by their number, by their leading address where a note follows; anything else by text.
function byAddress(a: string, b: string): number {
  const n = (s: string) => s.match(/^(\d+)\.(\d+)\.(\d+)\b/)?.slice(1).map(Number).reduce((x, y) => x * 256 + y, 0);
  const na = n(a), nb = n(b);
  return na !== undefined && nb !== undefined && na !== nb ? na - nb : byText(a, b);
}

function propertyOrder(a: string, b: string): number {
  const key = (s: string) => [s.startsWith("if ") ? 2 : s.startsWith("t") ? 1 : 0, ...(s.match(/\d+/g) ?? []).map(Number)];
  const ka = key(a), kb = key(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? -1) !== (kb[i] ?? -1)) return (ka[i] ?? -1) - (kb[i] ?? -1);
  return 0;
}

const hex = (b: Buffer) => b.toString("hex").toUpperCase();
const canonicalTool = (label: string) => (/^busforge$/i.test(label) ? "Busforge" : /^ets$/i.test(label) ? "ETS" : label);

// ── knxproxy ─────────────────────────────────────────────────────────────────

const PROXY_LINE = /^\S+ ([A-Za-z0-9_]+)->([A-Za-z0-9_]+) \S+.*\| ([0-9a-fA-F]*)\s*$/;
// The proxy's own connection notes ("<time> --- ETS connected ..."), and the "=== <label>" lines put between
// the runs of one session by hand.
const PROXY_MARKER = /^\S+ --- |^=== /;

// One application-layer telegram: its service, and what the index takes from its payload.
function applicationTelegram(st: FileStats, apci: number, data: Buffer, sent: boolean, src: string): boolean {
  const name = apciName(apci);
  st.service(name, sent);
  if (PROPERTY_APCIS.has(apci)) {
    if (data.length < 2) return false;
    st.properties.add(`${data[0]}/${data[1]}`);
  } else if (EXT_PROPERTY_APCIS.has(apci)) {
    if (data.length < 5) return false;
    st.properties.add(`t${data.readUInt16BE(0)}.${(data[2] << 4) | (data[3] >> 4)}/${((data[3] & 0x0f) << 8) | data[4]}`);
  } else if (apci === APCI.DEVICE_DESCRIPTOR_RESPONSE) {
    // Descriptor type 0 (the low six APCI bits) is the mask version, two octets.
    if (data.length !== 2) return false;
    st.device(src, hex(data));
  } else if ((apci & 0x3c0) === APCI.INDIVIDUAL_ADDRESS_WRITE) {
    if (data.length < 2) return false;
    st.assigned.add(numToIa(data.readUInt16BE(0)));
  } else if (apci === APCI.IA_SERIAL_WRITE) {
    if (data.length < 8) return false;
    st.assigned.add(`${numToIa(data.readUInt16BE(6))} (serial ${hex(data.subarray(0, 6))})`);
  } else if ((apci & 0x3c0) === APCI.INDIVIDUAL_ADDRESS_RESPONSE || apci === APCI.IA_SERIAL_RESPONSE) {
    st.device(src);
  } else if (apci === 0x3f1) {
    st.secure++;
  }
  return true;
}

// The cEMI message behind a KNXnet/IP header and its connection header, each led by its own length.
const cemiOf = (f: Buffer) => f.subarray(f[0] + f[f[0]]);

// The cEMI L_Data frame of a TUNNELLING_REQUEST. A confirmation repeats the tool's request: it is not counted
// again, only a negative one is.
function tunnelTelegram(st: FileStats, f: Buffer, hexFrame: string, sent: boolean): boolean {
  const fr = parseTunnelFrame(hexFrame);
  if (!fr) return false;
  if (fr.code !== CEMI.LDATA_REQ && fr.code !== CEMI.LDATA_IND && fr.code !== CEMI.LDATA_CON) return false;
  const t = fr.tpdu;
  if (t.length < 1) return false;
  // parseTunnelFrame has checked the cEMI's length, so its first control field is there.
  const cemi = cemiOf(f), ctrl1 = cemi[2 + cemi[1]];
  if (fr.code === CEMI.LDATA_CON) {
    if (ctrl1 & CEMI_CON_ERROR) st.notOnBus++;
    return true;
  }
  st.telegrams++;
  const src = numToIa(fr.src), dst = fr.dst;
  if (sent && fr.code === CEMI.LDATA_REQ && (!fr.group || dst === 0)) st.builders.add(FRAME_BUILDERS[ctrl1] ?? "other");
  if (fr.group) {
    if (dst !== 0) st.groups.add(numToGa(dst));
  } else if (sent) st.device(numToIa(dst));
  else st.device(src);
  if (t[0] & 0x80) { // transport control: T_Connect, T_Disconnect, T_Ack, T_Nak, one octet
    if (t.length !== 1) return false;
    const name = t[0] === 0x80 ? "T_Connect" : t[0] === 0x81 ? "T_Disconnect" : (t[0] & 0xc3) === 0xc2 ? "T_Ack" : (t[0] & 0xc3) === 0xc3 ? "T_Nak" : null;
    if (!name) return false;
    st.service(name, sent);
    return true;
  }
  if (t.length < 2) return false;
  return applicationTelegram(st, ((t[0] & 0x03) << 8) | t[1], t.subarray(2), sent, src);
}

// cEMI local management on the interface: its own interface objects, not a unit's.
function deviceConfigTelegram(st: FileStats, f: Buffer, sent: boolean): boolean {
  if (f.length < 7 || f.length < f[0] + f[f[0]] + 1) return false;
  const cemi = cemiOf(f);
  const name = CEMI_MGMT[cemi[0]];
  if (!name) return false;
  st.service(name, sent);
  if (CEMI_PROP_CODES.has(cemi[0])) {
    if (cemi.length < 7) return false;
    st.properties.add(`if t${cemi.readUInt16BE(1)}.${cemi[3]}/${cemi[4]}`);
  }
  return true;
}

function proxyLine(st: FileStats, m: RegExpMatchArray): boolean {
  const [, from, to, hexFrame] = m;
  const sent = to.toUpperCase() === "BRIDGE";
  const tool = sent ? from : to;
  if ((sent ? to : from).toUpperCase() !== "BRIDGE" || tool.toUpperCase() === "BRIDGE") return false;
  st.tools.add(canonicalTool(tool));
  if (hexFrame.length % 2) return false;
  const f = Buffer.from(hexFrame, "hex");
  if (f.length < 6 || f[0] !== 0x06 || f[1] !== 0x10 || f.readUInt16BE(4) !== f.length) return false;
  const svc = f.readUInt16BE(2);
  if (svc === SVC.TUNNEL_REQ) return tunnelTelegram(st, f, hexFrame, sent);
  if (svc === SVC.DEVICE_CONFIG_REQ) return deviceConfigTelegram(st, f, sent);
  return CONTROL_SERVICES.has(svc);
}

// ── ETS 6 log ─────────────────────────────────────────────────────────────────

// One telegram as ETS's link layer logs it:
//   Send PropertyValue_Read_req -> 1.1.55 (hc=6, S=1) ObjectIndex=0 PID=56 ...
//   Received GroupValue_Write_ind <- 1.1.24 -> 3/4/1 (hc=6) Value=02D0
//   Send Sec_req -> 1.1.204 (hc=6) SAI=A+C SeqNr=... InnerTelegram=DeviceDescriptor_Read_req -> 1.1.204 (hc=6) Type=0
const ETS_TELEGRAM = /([A-Za-z]+(?:_[A-Za-z]+)*)_(req|ind) (->|<-) (\S+)(?: -> (\S+))? \(([^)]*)\)(.*)$/;
// "Send next message from queue ..." names a telegram already logged; a telegram line starts with its service.
const ETS_SEND_RECEIVE = /Falcon\.KnxStack\.LL - \[[^\]]*\] (Send|Received) (?=[A-Za-z_]+_(?:req|ind) )/;
const ETS_LINE = new RegExp(`${ETS_SEND_RECEIVE.source}${ETS_TELEGRAM.source}`);
const ETS_INNER = new RegExp(`InnerTelegram=${ETS_TELEGRAM.source}`);
const ETS_ACTION = /DownloadManager - (Start[A-Za-z]+(?:\([A-Za-z]*\))?) (\d+\.\d+\.\d+)|Hawk\.LoadDeviceTask - Begin ([A-Za-z]+) (\d+\.\d+\.\d+)(?: \(([A-Za-z]+)\))?/;
// ETS's service names where they differ from the standard's (the rest are the standard's without "A_"):
// ETS's ConfirmedRestart is the A_Restart of restart type 1 with the erase code "confirmed restart".
const ETS_NAMES: Record<string, string> = {
  Ack: "T_Ack", Nak: "T_Nak", Connect: "T_Connect", Disconnect: "T_Disconnect", Sec: "A_SecureService",
  ConfirmedRestart: "A_Restart (master reset)", ConfirmedRestart_Response: "A_Restart_Response",
};
const IA = /^\d+\.\d+\.\d+$/, GA = /^\d+\/\d+\/\d+$/;

// False where a property service names no property in a form read here.
function etsTelegram(st: FileStats, sent: boolean, service: string, addr: string, to: string | undefined, rest: string): boolean {
  st.service(ETS_NAMES[service] ?? `A_${service}`, sent);
  // A received group telegram's first address is its sender, not a unit the tool addressed; 0/0/0 is the
  // broadcast an address response goes to. A sent one names only the group address.
  if (to !== undefined && to !== "0/0/0") st.groups.add(to);
  else if (GA.test(addr)) st.groups.add(addr);
  else if (IA.test(addr)) st.device(addr);
  const dd = rest.match(/DeviceDescriptor#0=([0-9A-Fa-f]{4})\b/);
  if (dd && IA.test(addr)) st.device(addr, dd[1].toUpperCase());
  const ia = rest.match(/\bIA=(\d+\.\d+\.\d+)/);
  if (ia && /Write$/.test(service)) st.assigned.add(ia[1]);
  const prop = rest.match(/ObjectIndex=(\d+) PID=(\d+)/);
  if (prop) st.properties.add(`${prop[1]}/${prop[2]}`);
  const ext = rest.match(/ObjectType=(\d+) Instance=(\d+) PID=(\d+)/);
  if (ext) st.properties.add(`t${ext[1]}.${ext[2]}/${ext[3]}`);
  return !(/Property/.test(service) && !prop && !ext);
}

// True for a telegram line read, false for a telegram line that did not parse, null for any other line.
function etsLine(st: FileStats, line: string): boolean | null {
  const a = line.match(ETS_ACTION);
  if (a) { st.etsActions.add(a[1] ? `${a[1]} ${a[2]}` : a[5] ? `${a[3]}(${a[5]}) ${a[4]}` : `${a[3]} ${a[4]}`); return null; }
  if (!ETS_SEND_RECEIVE.test(line)) return null;
  const m = line.match(ETS_LINE);
  if (!m) { st.tools.add("ETS"); st.telegrams++; return false; }
  const [, dir, service, , , addr, to, , rest] = m;
  const sent = dir === "Send";
  st.tools.add("ETS");
  st.telegrams++;
  let ok = etsTelegram(st, sent, service, addr, to, rest);
  if (service === "Sec") {
    st.secure++;
    const inner = rest.match(ETS_INNER);
    if (inner) {
      st.innerShown++;
      ok = etsTelegram(st, sent, inner[1], inner[4], inner[5], inner[7]) && ok;
    }
  }
  return ok;
}

// ── group monitor ────────────────────────────────────────────────────────────

// ── pcap ─────────────────────────────────────────────────────────────────────

// A pcap capture of KNXnet/IP over UDP, as the proxy log tools/pcap.ts turns it into; its refusal is the reason.
export function indexPcap(file: string, bytes: Buffer): IndexedFile | NotIndexed {
  let log: string;
  try { log = pcapToLog(bytes, PCAP_CLIENT); }
  catch (e) { return { file, reason: `pcap capture tools/pcap.ts refuses: ${e instanceof Error ? e.message : String(e)}` }; }
  const r = indexText(file, log);
  return "reason" in r ? r : { ...r, format: "pcap" };
}

// The listeners of the bench and house runs. A telegram from the bus: "<time> [GROUP |ANSWER ]<src> -> <ga>
// <tpdu hex> [<note>]", or "<time> GROUP <src> -> <ga> WRITE <tpdu hex>" whose word must agree with the TPDU. The
// listener's own sends: "<time> read <ga> con OK", "<time> SEND READ <ga>", and "<time> pulse <ga> con OK", which
// does not name its service and is counted as undecoded. Its other lines are notes, and its "RESULT ..." lines
// sum up the answers already logged as telegrams.
const GROUP_LINE = /^\S+ (?:GROUP |ANSWER )?(\d+\.\d+\.\d+) -> (\d+\/\d+\/\d+) (?:(READ|WRITE|RESPONSE) ([0-9a-fA-F]+)|([0-9a-fA-F]+))(?:\s.*)?$/;
const GROUP_SEND = /^\S+ (?:(read|pulse) (\d+\/\d+\/\d+) con (\S+)|SEND READ (\d+\/\d+\/\d+))\s*$/;
const GROUP_WORD = { GroupValueRead: "READ", GroupValueResponse: "RESPONSE", GroupValueWrite: "WRITE" } as const;

function groupLine(st: FileStats, m: RegExpMatchArray): boolean {
  const [, , ga, word, wordHex, bareHex] = m;
  const h = word ? wordHex : bareHex;
  st.telegrams++;
  st.groups.add(ga);
  if (h.length % 2 || h.length < 4) return false;
  const g = decodeGroupApdu(Buffer.from(h, "hex"));
  if (g.apci === "Unknown") return false;
  if (word && GROUP_WORD[g.apci] !== word) return false;
  st.service(`A_${g.apci.replace(/^GroupValue/, "GroupValue_")}`, false);
  return true;
}

function groupSend(st: FileStats, m: RegExpMatchArray): boolean {
  const [, kind, ga, con, readGa] = m;
  st.telegrams++;
  st.groups.add(ga ?? readGa);
  if (kind === "pulse") return false;
  st.service("A_GroupValue_Read", true);
  if (con !== undefined && con !== "OK") st.notOnBus++;
  return true;
}

// ── a file ───────────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([".log", ".txt", ".out", ".err", ".lines"]);
// Telegram-shaped lines a reader here does not take: an arrow from a unit to a unit or a group address, an
// APCI field, a decrypted view, a service sequence ("<time> -> T_CONNECT", "<time> <- GROUP ...").
const TELEGRAM_LIKE = /\d+\.\d+\.\d+ ?->\s?\d+[./]\d+[./]\d+|apci=0x|\bS-A_Data\b|N_Data#|^\S+ (?:->|<-) [A-Z][A-Z_]+\b/m;

export function indexText(file: string, text: string): IndexedFile | NotIndexed {
  const lines = text.split(/\r?\n/);
  const formats = new Set<Format>();
  const st = new FileStats();
  let firstOther = 0;
  lines.forEach((line, i) => {
    let ok: boolean | null = null;
    const p = line.match(PROXY_LINE);
    if (p) { formats.add("knxproxy"); ok = proxyLine(st, p); }
    else if (line.includes("Falcon.KnxStack.LL") || ETS_ACTION.test(line)) {
      ok = etsLine(st, line);
      if (ok !== null) formats.add("ets6log");
    } else {
      const g = line.match(GROUP_LINE), s = g ? null : line.match(GROUP_SEND);
      if (g) { formats.add("groupmonitor"); ok = groupLine(st, g); }
      else if (s) { formats.add("groupmonitor"); ok = groupSend(st, s); }
      else if (line.trim() !== "" && !PROXY_MARKER.test(line) && !firstOther) firstOther = i + 1;
    }
    if (ok === false) st.undecoded.push(i + 1);
  });
  if (formats.size > 1) return { file, reason: `mixed formats (${[...formats].sort().join(", ")}): no single reader applies` };
  const [format] = [...formats];
  if (!format) {
    if (/Falcon\.|Knx\.Ets\./.test(text)) return { file, reason: "ETS 6 log without a telegram line" };
    if (TELEGRAM_LIKE.test(text)) return { file, reason: "telegram-like lines in a format no reader here takes" };
    return { file, reason: "text without telegram lines" };
  }
  // Lines of a proxy log that are neither frames nor the proxy's markers mean the file is not what it looks like.
  if (format === "knxproxy" && firstOther) return { file, reason: `proxy log lines mixed with lines that are neither frames nor markers (first at line ${firstOther})` };
  return st.result(file, format);
}

export function indexFile(root: string, file: string): IndexedFile | NotIndexed {
  // A gzipped log is read as the log it holds.
  const gz = file.toLowerCase().endsWith(".gz");
  const ext = extname(gz ? file.slice(0, -3) : file).toLowerCase();
  const pcap = ext === ".pcapng" || ext === ".pcap";
  if (!pcap && !TEXT_EXTENSIONS.has(ext)) return { file, reason: `not a telegram log (${ext || "no extension"}${gz ? ", gzipped" : ""})` };
  const raw = readFileSync(join(root, file)), bytes = gz ? gunzipSync(raw) : raw;
  // A file named .pcapng may hold the classic format; tools/pcap.ts tells them apart by the magic number.
  return pcap ? indexPcap(file, bytes) : indexText(file, bytes.toString("latin1"));
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = join(dir, name);
    if (rel === INDEX_MD || rel === INDEX_JSON) continue;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out); else out.push(rel);
  }
}

export function buildIndex(root: string): CaptureIndex {
  const files: string[] = [];
  for (const d of INDEX_DIRS) walk(root, d, files);
  const index: CaptureIndex = { format: "busforge-capture-index/1", dirs: INDEX_DIRS, files: [], notIndexed: [] };
  for (const f of files.sort()) {
    const r = indexFile(root, f);
    if ("reason" in r) index.notIndexed.push(r); else index.files.push(r);
  }
  return index;
}

// ── output ───────────────────────────────────────────────────────────────────

const cell = (s: string) => s.replaceAll("|", "\\|");
// A proxy log whose label names one tool while its frames come from the other's builder.
const TOOLS = new Set(["ETS", "Busforge"]);
export const labelDisagrees = (f: IndexedFile) =>
  TOOLS.has(f.framesBuiltAs ?? "") && f.tools.length === 1 && TOOLS.has(f.tools[0]) && f.tools[0] !== f.framesBuiltAs;
const toolCell = (f: IndexedFile) => {
  const label = f.tools.join(", ");
  return f.framesBuiltAs && f.framesBuiltAs !== label ? `${label} (frames: ${f.framesBuiltAs})` : label;
};
const services = (f: IndexedFile, dir: keyof ServiceCount) =>
  Object.entries(f.services).filter(([, c]) => c[dir] > 0).map(([n, c]) => `${n} ${c[dir]}`).join(", ");

export function renderMarkdown(index: CaptureIndex): string {
  const out: string[] = [];
  out.push("# Capture index", "");
  out.push(`Written by the repository's \`tools/capture-index.ts\` from ${index.dirs.map((d) => `\`${d}/\``).join(", ")}; do not edit, run it again after`);
  out.push("adding a capture (`docs/testing.md`, \"The capture index\"). Every field is in `index.json` beside this file.", "");
  out.push(`${index.files.length} files read, ${index.notIndexed.length} not read (listed at the end).`, "");
  out.push("Columns: **devices** are the units the tool addressed or that answered, with their device descriptor 0");
  out.push("(the mask version) in brackets where the capture shows it; **assigned** are addresses written by an address");
  out.push("assignment; **sent** is from the tool, **received** from the bus; **not on bus** counts the sent requests the");
  out.push("interface confirmed negatively; **properties** are object index/PID,");
  out.push("`t<type>.<instance>/<PID>` for the extended services, `if ...` for the interface's own objects; **secure**");
  out.push("counts A_SecureService telegrams and how many show the service inside (a proxy log carries it encrypted:");
  out.push("the ETS 6 log of the same minutes shows it). **Tool** is the name the proxy wrote; the proxy names its");
  out.push("client ETS unless told otherwise, so where the tool's frames come from the other tool's frame builder the");
  out.push("cell says so (`ETS (frames: Busforge)`): Busforge sends control field BC/3C, ETS 6 B0/30. A pcap capture");
  out.push(`names its client \`${PCAP_CLIENT}\`, and only its frames say which tool it was.`, "");

  const disagree = index.files.filter(labelDisagrees);
  out.push("## Tool label and frames disagree", "");
  if (disagree.length === 0) out.push("None.");
  for (const f of disagree) out.push(`- \`${f.file}\`: labelled ${f.tools.join(", ")}, frames built as ${f.framesBuiltAs}'s`);
  out.push("");

  const bySvc = new Map<string, string[]>();
  for (const f of index.files) for (const s of Object.keys(f.services)) bySvc.set(s, [...(bySvc.get(s) ?? []), f.file]);
  out.push("## By service", "");
  out.push("Services in at most 25 files name them; the others are in the table below.", "");
  for (const [s, fs] of [...bySvc.entries()].sort(([a], [b]) => byText(a, b))) {
    out.push(fs.length <= 25 ? `- **${s}** (${fs.length}): ${fs.map((f) => `\`${f}\``).join(", ")}` : `- **${s}**: ${fs.length} files`);
  }
  out.push("");

  const byDd = new Map<string, Set<string>>();
  for (const f of index.files) for (const d of f.devices) for (const v of d.descriptor0) byDd.set(v, (byDd.get(v) ?? new Set()).add(f.file));
  out.push("## By device descriptor 0", "");
  for (const [v, fs] of [...byDd.entries()].sort(([a], [b]) => byText(a, b))) {
    out.push(`- **${v}** (${fs.size}): ${[...fs].map((f) => `\`${f}\``).join(", ")}`);
  }
  out.push("");

  out.push("## Files", "");
  out.push("| File | Format | Tool | Telegrams | Devices | Assigned | Sent | Not on bus | Received | Properties | Groups | Secure | ETS actions | Undecoded lines |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const f of index.files) {
    const devices = f.devices.map((d) => (d.descriptor0.length ? `${d.address} [${d.descriptor0.join(", ")}]` : d.address)).join(", ");
    const secure = f.secure.telegrams ? `${f.secure.telegrams} (${f.secure.innerShown} shown)` : "";
    const undecoded = f.undecoded.count ? `${f.undecoded.count} (from line ${f.undecoded.lines.join(", ")})` : "";
    out.push(`| \`${f.file}\` | ${f.format} | ${toolCell(f)} | ${f.telegrams} | ${cell(devices)} | ${cell(f.assigned.join(", "))} | ${cell(services(f, "sent"))} | ${f.notOnBus || ""} | ${cell(services(f, "received"))} | ${cell(f.properties.join(", "))} | ${f.groupAddresses || ""} | ${secure} | ${cell(f.etsActions.join(", "))} | ${undecoded} |`);
  }
  out.push("");

  out.push("## Not read", "");
  const byReason = new Map<string, string[]>();
  for (const n of index.notIndexed) byReason.set(n.reason, [...(byReason.get(n.reason) ?? []), n.file]);
  const notLog = [...byReason.entries()].filter(([r]) => r.startsWith("not a telegram log"));
  const rest = [...byReason.entries()].filter(([r]) => !r.startsWith("not a telegram log")).sort(([a], [b]) => byText(a, b));
  out.push("Files that may hold telegrams but no reader here takes, by reason:", "");
  for (const [r, fs] of rest) {
    out.push(`### ${r} (${fs.length})`, "");
    for (const f of fs) out.push(`- \`${f}\``);
    out.push("");
  }
  out.push("Files of a kind that holds no telegram log (each one is listed in `index.json`):", "");
  for (const [r, fs] of notLog.sort(([a], [b]) => byText(a, b))) out.push(`- ${r}: ${fs.length}`);
  out.push("");
  return out.join("\n");
}

if (import.meta.main) {
  try {
    const root = corpusRoot();
    if (root === null) throw new Error(`${CORPUS_ENV} is unset; the index is built from the private corpus (docs/testing.md, "The private corpus")`);
    const index = buildIndex(root);
    writeFileSync(join(root, INDEX_JSON), JSON.stringify(index, null, 1) + "\n");
    writeFileSync(join(root, INDEX_MD), renderMarkdown(index));
    console.log(`capture-index: ${index.files.length} files read, ${index.notIndexed.length} not read -> ${INDEX_MD}, ${INDEX_JSON}`);
  } catch (e) {
    console.error(`capture-index: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
