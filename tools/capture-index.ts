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
//
// The Data Secure telegrams of a proxy log or pcap capture are opened with the keys the corpus holds: the tool
// keys and group keys of its ETS projects and the keys of its ETS keyrings (tried with each password of
// KNXPROJ_PASSWORDS, and the public password the bussard set documents for its synthetic keyrings), plus device
// keys the corpus cannot hold, such as a bench device's FDSK from its certificate, given as
//   CAPTURE_KEYS="<name>=<32 hex>,..."
// Keys stay in memory; the index names only the key that opened a file's telegrams, never its value or a plaintext.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extname, join } from "node:path";
import { APCI, CEMI, CEMI_CON_ERROR, SVC, decodeGroupApdu, numToGa, numToIa } from "../packages/knx/src/frame.ts";
import {
  decodeAuthorizeResponse, decodeFunctionPropertyExtState, decodeMemoryRead, decodeMemoryResponse, decodePropertyDescription,
  decodePropertyValueResponse,
} from "../packages/knx/src/rawcodec.ts";
import { parseTunnelFrame } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";
import { BUSSARD_SYNTHETIC_DIR, corpusRoot, CORPUS_ENV, refuseDotenv } from "./corpus.ts";
import { passwords } from "./corpus-archives.ts";
import {
  SecureCaptureDecoder, addKeys, corpusKeys, emptyKeys, parseKeyList, type KeyLoad, type NamedKey, type SecureFrame, type SecureKeys,
} from "./secure-capture.ts";

export const INDEX_DIRS = ["captures", "internal/captures", "collections"] as const;
export const INDEX_MD = "internal/captures/INDEX.md";
export const INDEX_JSON = "internal/captures/index.json";
export const KEYS_ENV = "CAPTURE_KEYS";
// The bussard set's oracle rows name the public password of its synthetic keyrings in their header.
export const BUSSARD_ROWS = `${BUSSARD_SYNTHETIC_DIR}/captures/rows.txt`;

export type Format = "knxproxy" | "pcap" | "ets6log" | "groupmonitor";
// The client's name in a pcap capture: a sniffer's file does not say which tool sent its frames.
export const PCAP_CLIENT = "client";

export interface ServiceCount { sent: number; received: number }
export interface Device { address: string; descriptor0: string[] }
export interface IndexedFile {
  file: string;
  format: Format;
  // The tool on the client side of a proxy log as the proxy names it (PROXY_TOOL), ETS for
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
  // A_SecureService telegrams; how many of them the index shows the service of (ETS's log names it, a proxy log
  // or pcap capture where a key opened it); the services inside, each way (named by secureInside); and the keys that
  // opened them, by name. The service of an opened S-A_Data counts in `services` too, like any other telegram.
  secure: { telegrams: number; shown: number; inside: Record<string, ServiceCount>; openedWith: string[] };
  // ETS's download actions on its log, e.g. "StartLoadDevice(Partial) 1.1.18".
  etsActions: string[];
  // Lines of this format whose telegram did not decode, with the first line numbers.
  undecoded: { count: number; lines: number[] };
}
export interface NotIndexed { file: string; reason: string }
// Where the keys came from: the corpus files read with how many keys each added, the ones not read with the
// reason, and the names of the keys from the environment.
export interface KeySources { read: KeyLoad["read"]; notRead: KeyLoad["notRead"]; environment: string[]; deviceKeys: number; groupKeys: number }
export interface CaptureIndex {
  format: "busforge-capture-index/2"; dirs: readonly string[]; keys: KeySources; files: IndexedFile[]; notIndexed: NotIndexed[];
}

// The name of a service inside a secured telegram: an opened S-A_Data by the service it carries, a Sync by its
// own, one no key opened as "<SCF service> (not opened)", with what the frame shows in clear in brackets:
// "tool access" for SCF bit 7, "broadcast" for the destination 0/0/0, "group" for another group address. ETS's
// log shows neither the SCF nor a Sync's access, so its rows name only the destination; a telegram ETS logs
// encrypted is "S-A_Data (not shown)".
export function secureInside(service: string, q: { toolAccess?: boolean; group?: boolean; dst?: number }): string {
  const tags = [...(q.toolAccess ? ["tool access"] : []), ...(q.group ? [q.dst === 0 ? "broadcast" : "group"] : [])];
  return tags.length ? `${service} [${tags.join(", ")}]` : service;
}

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
// in every capture of the corpus that ETS's own log names. A proxy names its client by PROXY_TOOL, and
// proxy logs in the corpus name Busforge runs ETS; the frames tell them apart.
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
  secureShown = 0;
  readonly secureInside = new Map<string, ServiceCount>();
  readonly openedWith = new Set<string>();
  notOnBus = 0;
  readonly etsActions = new Set<string>();
  readonly undecoded: number[] = [];
  // The individual address of the tunnel, which a tool's request leaves as 0.0.0 and the interface's
  // confirmation carries: the source a secured request was authenticated with.
  tunnelIa = 0;

  constructor(readonly decoder: SecureCaptureDecoder) {}

  service(name: string, sent: boolean, into: Map<string, ServiceCount> = this.services): void {
    const c = into.get(name) ?? { sent: 0, received: 0 };
    if (sent) c.sent++; else c.received++;
    into.set(name, c);
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
      secure: {
        telegrams: this.secure, shown: this.secureShown,
        inside: Object.fromEntries([...this.secureInside.entries()].sort(([a], [b]) => byText(a, b))),
        openedWith: [...this.openedWith].sort(),
      },
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

// Whether a telegram's data (the octets behind the two APCI octets) has the layout its service fixes; a service
// without an entry is taken as it is. The strict decoders of rawcodec.ts are used where they exist.
function payloadFits(apci: number, tpdu: Buffer, data: Buffer): boolean {
  const decodes = (decode: () => unknown) => { try { decode(); return true; } catch { return false; } };
  const n = data.length, top = apci & 0x3c0;
  switch (apci) {
    case APCI.PROPERTY_READ: return n === 4;
    case APCI.PROPERTY_RESPONSE: case APCI.PROPERTY_WRITE: return decodes(() => decodePropertyValueResponse(data));
    case APCI.PROPERTY_DESCRIPTION_READ: return n === 3;
    case APCI.PROPERTY_DESCRIPTION_RESPONSE: return decodes(() => decodePropertyDescription(data));
    case 0x2c7: case 0x2c8: case 0x2c9: return n >= 2;
    // object type, instance and PID (5 octets), element count (1) and start index (2)
    case APCI.PROPERTY_EXT_READ: return n === 8;
    case APCI.PROPERTY_EXT_RESPONSE: case APCI.PROPERTY_EXT_WRITE_CON: case APCI.PROPERTY_EXT_WRITE_CON_RESP: case 0x1d0: return n >= 8;
    case 0x1d2: case 0x1d3: case APCI.FUNCTION_PROPERTY_EXT_COMMAND: case APCI.FUNCTION_PROPERTY_EXT_STATE_READ: return n >= 5;
    case APCI.FUNCTION_PROPERTY_EXT_STATE_RESPONSE: return decodes(() => decodeFunctionPropertyExtState(data));
    // count (1), 24-bit address (3), then the data of a write or a read's answer
    case APCI.MEMORY_EXT_WRITE: return n >= 4 && n === 4 + data[0];
    case APCI.MEMORY_EXT_READ: return n === 4;
    case APCI.MEMORY_EXT_WRITE_RESP: case APCI.MEMORY_EXT_READ_RESP: return n >= 4;
    case APCI.DEVICE_DESCRIPTOR_RESPONSE: return n === 2; // type 0: the mask version
    case APCI.IA_SERIAL_READ: return n === 6;
    case APCI.IA_SERIAL_RESPONSE: return n >= 6;
    case APCI.IA_SERIAL_WRITE: return n === 12; // serial (6), address (2), four reserved octets
    case APCI.RESTART: return n === 0;
    case 0x381: return n === 2; // erase code, channel
    case 0x3a1: return n === 3; // error code, process time
    case APCI.AUTHORIZE_REQUEST: return n === 5; // reserved octet, key
    case APCI.AUTHORIZE_RESPONSE: return decodes(() => decodeAuthorizeResponse(data));
    case 0x3f1: return n >= 1; // the security control field at least
  }
  switch (top) {
    case APCI.MEMORY_READ: return decodes(() => decodeMemoryRead(tpdu, data));
    case APCI.MEMORY_RESPONSE: return decodes(() => decodeMemoryResponse(tpdu, data));
    case APCI.MEMORY_WRITE: return (apci & 0x3f) > 0 && n === 2 + (apci & 0x3f);
    case APCI.DEVICE_DESCRIPTOR_READ: return n === 0;
    case APCI.INDIVIDUAL_ADDRESS_WRITE: return apci === top && n === 2;
    case APCI.INDIVIDUAL_ADDRESS_READ: case APCI.INDIVIDUAL_ADDRESS_RESPONSE: return apci === top && n === 0;
    case 0x000: return apci === top && n === 0; // A_GroupValue_Read
  }
  return true;
}

// One application-layer telegram: its service, and what the index takes from its payload.
function applicationTelegram(st: FileStats, apci: number, tpdu: Buffer, sent: boolean, src: string): boolean {
  const data = tpdu.subarray(2);
  st.service(apciName(apci), sent);
  if (!payloadFits(apci, tpdu, data)) return false;
  if (PROPERTY_APCIS.has(apci)) {
    st.properties.add(`${data[0]}/${data[1]}`);
  } else if (EXT_PROPERTY_APCIS.has(apci)) {
    st.properties.add(`t${data.readUInt16BE(0)}.${(data[2] << 4) | (data[3] >> 4)}/${((data[3] & 0x0f) << 8) | data[4]}`);
  } else if (apci === APCI.DEVICE_DESCRIPTOR_RESPONSE) {
    st.device(src, hex(data));
  } else if (apci === APCI.INDIVIDUAL_ADDRESS_WRITE) {
    st.assigned.add(numToIa(data.readUInt16BE(0)));
  } else if (apci === APCI.IA_SERIAL_WRITE) {
    st.assigned.add(`${numToIa(data.readUInt16BE(6))} (serial ${hex(data.subarray(0, 6))})`);
  } else if ((apci & 0x3c0) === APCI.INDIVIDUAL_ADDRESS_RESPONSE || apci === APCI.IA_SERIAL_RESPONSE) {
    st.device(src);
  } else if (apci === 0x3f1) {
    st.secure++;
  }
  return true;
}

// A secured telegram as the decoder left it. An opened S-A_Data's inner telegram is read like any other; one no
// key opened is counted by what its frame shows in clear.
function secureTelegram(st: FileStats, fr: SecureFrame, sent: boolean, src: string, group: boolean, dst: number): boolean {
  const q = { toolAccess: fr.toolAccess, group, dst };
  if (!fr.opened) { st.service(secureInside(`${fr.service} (not opened)`, q), sent, st.secureInside); return true; }
  st.secureShown++;
  st.openedWith.add(fr.opened.key);
  if (fr.service !== "S-A_Data") { st.service(secureInside(fr.service, q), sent, st.secureInside); return true; }
  const p = fr.opened.plaintext;
  // The inner APDU's first octet carries only the APCI's top two bits; the transport layer is the outer frame's.
  if (p.length < 2 || (p[0] & 0xfc) !== 0) { st.service(secureInside("S-A_Data (inner APDU malformed)", q), sent, st.secureInside); return false; }
  const apci = ((p[0] & 0x03) << 8) | p[1];
  st.service(secureInside(apciName(apci), q), sent, st.secureInside);
  return applicationTelegram(st, apci, p, sent, src);
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
    if (fr.src !== 0) st.tunnelIa = fr.src;
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
  // A group or broadcast telegram is unnumbered data: no sequence number, no numbered flag.
  if (fr.group && (t[0] & 0xfc) !== 0) return false;
  const apci = ((t[0] & 0x03) << 8) | t[1];
  const ok = applicationTelegram(st, apci, t, sent, src);
  if (apci !== 0x3f1 || !ok) return ok;
  const authenticated = fr.code === CEMI.LDATA_REQ && fr.src === 0 ? st.tunnelIa : fr.src;
  return secureTelegram(st, st.decoder.open(authenticated, dst, fr.group, t), sent, src, fr.group, dst);
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
const ETS_SEND_RECEIVE = /Falcon\.KnxStack\.LL - \[[^\]]*\] (Send|Received) (?=[A-Za-z_]+_(?:req|ind)\b)/;
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
    const target = to ?? addr;
    const q = { group: GA.test(target), dst: target === "0/0/0" ? 0 : -1 };
    const inner = rest.match(ETS_INNER);
    const sync = rest.match(/^\s*Sync(Req|Res)\b/);
    if (inner) {
      st.secureShown++;
      st.service(secureInside(ETS_NAMES[inner[1]] ?? `A_${inner[1]}`, q), sent, st.secureInside);
      ok = etsTelegram(st, sent, inner[1], inner[4], inner[5], inner[7]) && ok;
    } else if (sync) {
      st.secureShown++;
      st.service(secureInside(`Sync.${sync[1].toLowerCase()}`, q), sent, st.secureInside);
    } else {
      st.service(secureInside("S-A_Data (not shown)", q), sent, st.secureInside);
    }
  }
  return ok;
}

// ── group monitor ────────────────────────────────────────────────────────────

// ── pcap ─────────────────────────────────────────────────────────────────────

// A pcap capture of KNXnet/IP over UDP, as the proxy log tools/pcap.ts turns it into; its refusal is the reason.
export function indexPcap(file: string, bytes: Buffer, keys: SecureKeys = emptyKeys()): IndexedFile | NotIndexed {
  let log: string;
  try { log = pcapToLog(bytes, PCAP_CLIENT); }
  catch (e) { return { file, reason: `pcap capture tools/pcap.ts refuses: ${e instanceof Error ? e.message : String(e)}` }; }
  const r = indexText(file, log, keys);
  return "reason" in r ? r : { ...r, format: "pcap" };
}

// The listeners of the bench and house runs. A telegram from the bus: "<time> [GROUP |ANSWER ]<src> -> <ga>
// <tpdu hex> [<note>]", or "<time> GROUP <src> -> <ga> WRITE <tpdu hex>" whose word must agree with the TPDU. The
// listener's own sends: "<time> read <ga> con OK", "<time> SEND READ <ga>", and "<time> pulse <ga> con OK", which
// does not name its service and is counted as undecoded. Its other lines are notes, and its "RESULT ..." lines
// sum up the answers already logged as telegrams.
const GROUP_LINE = /^\S+ (?:GROUP |ANSWER )?(\d+\.\d+\.\d+) -> (\d+\/\d+\/\d+) (?:(READ|WRITE|RESPONSE) ([0-9a-fA-F]+)|([0-9a-fA-F]+))(?:\s.*)?$/;
// Any line that starts like a telegram from the bus; one GROUP_LINE does not read is counted as undecoded.
const GROUP_CANDIDATE = /^\S+ (?:GROUP |ANSWER )?\d+\.\d+\.\d+ -> /;
const GROUP_SEND = /^\S+ (?:(read|pulse) (\d+\/\d+\/\d+) con (\S+)|SEND READ (\d+\/\d+\/\d+))\s*$/;
const GROUP_WORD = { GroupValueRead: "READ", GroupValueResponse: "RESPONSE", GroupValueWrite: "WRITE" } as const;

function groupLine(st: FileStats, m: RegExpMatchArray): boolean {
  const [, , ga, word, wordHex, bareHex] = m;
  const h = word ? wordHex : bareHex;
  st.telegrams++;
  st.groups.add(ga);
  if (h.length % 2 || h.length < 4) return false;
  const tpdu = Buffer.from(h, "hex");
  if ((tpdu[0] & 0xfc) !== 0) return false; // unnumbered group data, no transport control
  const g = decodeGroupApdu(tpdu);
  if (g.apci === "GroupValueRead" && (tpdu.length !== 2 || (tpdu[1] & 0x3f) !== 0)) return false;
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

// `keys` open the secured telegrams of a proxy log, each file with its own decoder state.
export function indexText(file: string, text: string, keys: SecureKeys = emptyKeys()): IndexedFile | NotIndexed {
  const lines = text.split(/\r?\n/);
  const formats = new Set<Format>();
  const st = new FileStats(new SecureCaptureDecoder(keys));
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
      else if (GROUP_CANDIDATE.test(line) || /^\S+ (?:(?:read|pulse) \d+\/\d+\/\d+|SEND READ )/.test(line)) { formats.add("groupmonitor"); st.telegrams++; ok = false; }
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

export function indexFile(root: string, file: string, keys: SecureKeys = emptyKeys()): IndexedFile | NotIndexed {
  // A gzipped log is read as the log it holds.
  const gz = file.toLowerCase().endsWith(".gz");
  const ext = extname(gz ? file.slice(0, -3) : file).toLowerCase();
  const pcap = ext === ".pcapng" || ext === ".pcap";
  if (!pcap && !TEXT_EXTENSIONS.has(ext)) return { file, reason: `not a telegram log (${ext || "no extension"}${gz ? ", gzipped" : ""})` };
  let bytes: Buffer;
  try {
    const raw = readFileSync(join(root, file));
    bytes = gz ? gunzipSync(raw) : raw;
  } catch (e) { return { file, reason: `unreadable: ${e instanceof Error ? e.message : String(e)}` }; }
  // A file named .pcapng may hold the classic format; tools/pcap.ts tells them apart by the magic number.
  return pcap ? indexPcap(file, bytes, keys) : indexText(file, bytes.toString("latin1"), keys);
}

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = join(dir, name);
    if (rel === INDEX_MD || rel === INDEX_JSON) continue;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out); else out.push(rel);
  }
}

// The public password the bussard set's oracle rows name for its synthetic keyrings, where the corpus holds them.
export function documentedKeyringPasswords(root: string): string[] {
  const rows = join(root, BUSSARD_ROWS);
  if (!existsSync(rows)) return [];
  const m = readFileSync(rows, "utf8").match(/^#\s+BUSSARD_KEYRING_PASSWORD='([^']+)'/m);
  return m ? [m[1]] : [];
}

// The keys besides the corpus's own: the passwords of its protected projects and device keys it cannot hold.
export interface KeyInput { passwords: string[]; environment: NamedKey[] }

export function buildIndex(root: string, input: KeyInput = { passwords: [], environment: [] }): CaptureIndex {
  const files: string[] = [];
  for (const d of INDEX_DIRS) walk(root, d, files);
  files.sort();
  const load = corpusKeys(root, files.filter((f) => /\.(knxproj|knxkeys)$/.test(f)), [...input.passwords, ...documentedKeyringPasswords(root)]);
  addKeys(load.keys, input.environment);
  const keys: KeySources = {
    read: load.read, notRead: load.notRead, environment: input.environment.map((k) => k.name),
    deviceKeys: load.keys.device.length, groupKeys: [...load.keys.group.values()].reduce((n, l) => n + l.length, 0),
  };
  const index: CaptureIndex = { format: "busforge-capture-index/2", dirs: INDEX_DIRS, keys, files: [], notIndexed: [] };
  for (const f of files) {
    const r = indexFile(root, f, load.keys);
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
  out.push("counts A_SecureService telegrams and how many of them the index shows the service of: ETS's own log names it,");
  out.push("a proxy log or pcap capture carries it encrypted and shows it where a key below opened it. An opened");
  out.push("telegram's inner service counts among the sent and received services like any other, and is listed under");
  out.push("\"Inside secured telegrams\". **Tool** is the name the proxy wrote (`PROXY_TOOL`), which");
  out.push("the proxy cannot check, so where the tool's frames come from the other tool's frame builder the");
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

  const inside = new Map<string, string[]>();
  for (const f of index.files) for (const s of Object.keys(f.secure.inside)) inside.set(s, [...(inside.get(s) ?? []), f.file]);
  out.push("## Inside secured telegrams", "");
  out.push("The service each secured telegram carries, and the files that show it. In brackets what the frame shows in");
  out.push("clear: **tool access** (security control field bit 7: a device's tool key or FDSK), **broadcast** (to 0/0/0),");
  out.push("**group** (to another group address). ETS's log shows neither the control field nor a Sync's access, so its");
  out.push("telegrams name only the destination. **(not opened)**: no key below opened it; **(not shown)**: ETS logged");
  out.push("it encrypted.", "");
  for (const [s, fs] of [...inside.entries()].sort(([a], [b]) => byText(a, b))) {
    out.push(`- **${s}** (${fs.length}): ${fs.map((f) => `\`${f}\``).join(", ")}`);
  }
  out.push("");

  const k = index.keys;
  out.push("## Keys", "");
  out.push(`Secured telegrams were opened with ${k.deviceKeys} device keys (tool keys, FDSKs) and ${k.groupKeys} group keys, held in`);
  out.push("memory only. A key is named by the first file that holds it; which keys opened a capture's telegrams is in");
  out.push("`index.json` (`secure.openedWith`).", "");
  const added = k.read.filter((r) => r.deviceKeys + r.groupKeys > 0);
  for (const r of added) out.push(`- \`${r.file}\`: ${r.deviceKeys} device, ${r.groupKeys} group`);
  if (k.read.length > added.length) out.push(`- ${k.read.length - added.length} more projects and keyrings read, holding no other key`);
  out.push(k.environment.length ? `- from \`${KEYS_ENV}\`: ${k.environment.map((n) => `\`${n}\``).join(", ")}` : `- none from \`${KEYS_ENV}\``);
  out.push("");
  if (k.notRead.length) {
    out.push("Not read, so their keys are missing (give the password in `KNXPROJ_PASSWORDS`):", "");
    for (const n of k.notRead) out.push(`- \`${n.file}\`: ${n.reason}`);
    out.push("");
  }

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
    const secure = f.secure.telegrams ? `${f.secure.telegrams} (${f.secure.shown} shown)` : "";
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
    refuseDotenv(KEYS_ENV);
    const index = buildIndex(root, { passwords: passwords(), environment: parseKeyList(process.env[KEYS_ENV]) });
    writeFileSync(join(root, INDEX_JSON), JSON.stringify(index, null, 1) + "\n");
    writeFileSync(join(root, INDEX_MD), renderMarkdown(index));
    console.log(`capture-index: ${index.files.length} files read, ${index.notIndexed.length} not read -> ${INDEX_MD}, ${INDEX_JSON}`);
  } catch (e) {
    console.error(`capture-index: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
