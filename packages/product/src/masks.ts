// KNX mask-version registry: the authoritative list of device "mask versions" and what
// each one IS. A mask version is every KNX device's identity stamp (read off the bus via
// the device descriptor); it determines the device's MEDIUM (twisted-pair, powerline, RF,
// IP) and its SYSTEM FAMILY, and the family in turn fixes the MEMORY MODEL (how parameters
// and group tables are laid out in the device, and therefore how we read and program it).
//
// The two axes are NOT a free cross-product: the mask version is the primary key and
// projects onto (medium, family), and family fixes the memory model essentially 1:1
// (System 7 = absolute segments, System B = relative segment, BCU1/BCU2 = the classic
// fixed EEPROM models). So this is one list keyed by mask, with the derived properties as
// columns. The point of enumerating ALL of them, even the ones we cannot program, is
// HONESTY: a device whose mask we recognise but whose memory model we do not implement is
// reported as explicitly unsupported (classify() -> UnsupportedProfile, which throws),
// instead of being silently misrouted into a path that fabricates a wrong result.
//
// Source: KNX Association "Mask Versions" + Calimero DeviceDescriptor DD0 enum. See
// docs/device-support.md for the rendered matrix.

export type Medium = "TP" | "PL" | "RF" | "IP";

// The system family a mask belongs to. The application-bearing families (system-1/2/300/7/b)
// have a memory model; the rest (couplers, interfaces, IR decoders, media couplers, RF-only,
// dummy) have no application memory model we program.
export type SystemFamily =
  | "system-1" // BCU1
  | "system-2" // BCU2
  | "system-300"
  | "system-7" // BIM M112
  | "system-b"
  | "coupler"
  | "interface"
  | "ir-decoder"
  | "media-coupler"
  | "rf" // RF-only S-mode devices (their own model)
  | "dummy"
  | "unknown";

// The on-device memory model that decides how we read/program a device. This is what
// classify() dispatches on: "relative" -> System B path, "absolute" -> System 7 path,
// "bcu1" -> System 1 (read only), everything else has no implemented path (-> UnsupportedProfile).
export type MemoryModel =
  | "absolute" // System 7: parameters in fixed AbsoluteSegments, System-7 group tables
  | "relative" // System B: parameters in a relative LSM4 segment, count-prefixed group tables
  | "bcu1" // System 1 fixed EEPROM model (read only, see system1.ts)
  | "bcu2" // System 2 fixed EEPROM model (not implemented)
  | "system300" // System 300 model (not implemented)
  | "none"; // no application memory model (couplers, interfaces, IR, media couplers, dummy)

export interface MaskInfo {
  /** Canonical mask string as it appears in the product XML / on the bus, e.g. "MV-0705". */
  mask: string;
  /** Numeric mask value, e.g. 0x0705. */
  hex: number;
  medium: Medium;
  family: SystemFamily;
  memoryModel: MemoryModel;
  /** Human label for the matrix / UI. */
  name: string;
  /**
   * How the load-state machines are driven. `true` (the modern default): LSM events/state
   * are interface-object PROPERTY writes/reads to PID_LOAD_STATE_CONTROL (System B, and the
   * System 7 MV-0705/2705/5705 variants, `PropertyMappedLsms=1` in the ETS master data).
   * `false`: the deprecated MEMORY-MAPPED interface (write the load control to StandardMemory
   * 0x0104, read the load status from 46825+LsmIdx) used by the BIM M112 masks MV-0700/0701.
   * Only meaningful for application-bearing families; absent/true elsewhere.
   */
  propertyMappedLsms?: boolean;
}

// The full table. One row per known mask version. `m()` keeps the rows terse.
const m = (hex: number, medium: Medium, family: SystemFamily, memoryModel: MemoryModel, name: string, propertyMappedLsms = true): MaskInfo => ({
  mask: `MV-${hex.toString(16).toUpperCase().padStart(4, "0")}`,
  hex,
  medium,
  family,
  memoryModel,
  name,
  propertyMappedLsms,
});

export const MASKS: MaskInfo[] = [
  // --- Twisted pair (TP1) ---
  m(0x0001, "TP", "dummy", "none", "Dummy"),
  m(0x0010, "TP", "system-1", "bcu1", "System 1 (BCU1)"),
  m(0x0011, "TP", "system-1", "bcu1", "System 1 (BCU1)"),
  m(0x0012, "TP", "system-1", "bcu1", "System 1 (BCU1)"),
  m(0x0013, "TP", "system-1", "bcu1", "System 1 (BCU1)"),
  m(0x0020, "TP", "system-2", "bcu2", "System 2 (BCU2)"),
  m(0x0021, "TP", "system-2", "bcu2", "System 2 (BCU2)"),
  m(0x0025, "TP", "system-2", "bcu2", "System 2 (BCU2)"),
  m(0x0300, "TP", "system-300", "system300", "System 300"),
  m(0x0310, "TP", "interface", "none", "TP1 USB interface v1"),
  m(0x0311, "TP", "interface", "none", "TP1 USB interface v2"),
  m(0x0700, "TP", "system-7", "absolute", "System 7 (BIM M112)", false), // memory-mapped LSMs
  m(0x0701, "TP", "system-7", "absolute", "System 7 (BIM M112)", false), // memory-mapped LSMs
  m(0x0705, "TP", "system-7", "absolute", "System 7 (BIM M112)"),
  m(0x07b0, "TP", "system-b", "relative", "System B"),
  m(0x0810, "TP", "ir-decoder", "none", "IR decoder"),
  m(0x0811, "TP", "ir-decoder", "none", "IR decoder"),
  m(0x0900, "TP", "coupler", "none", "Coupler 0900"),
  m(0x0910, "TP", "coupler", "none", "Coupler 1.0"),
  m(0x0911, "TP", "coupler", "none", "Coupler 1.1"),
  m(0x0912, "TP", "coupler", "none", "Coupler 1.2"),
  m(0x091a, "TP", "coupler", "none", "KNXnet/IP router"),
  m(0x0afd, "TP", "unknown", "none", "Unspecified (0AFD)"),
  m(0x0afe, "TP", "unknown", "none", "Unspecified (0AFE)"),
  // --- Powerline (PL110) ---
  m(0x1011, "PL", "system-1", "bcu1", "PL110 System 1"),
  m(0x1012, "PL", "system-1", "bcu1", "PL110 BCU1"),
  m(0x1013, "PL", "system-1", "bcu1", "PL110 BCU1"),
  m(0x1310, "PL", "interface", "none", "PL110 USB interface v1"),
  m(0x1311, "PL", "interface", "none", "PL110 USB interface v2"),
  m(0x17b0, "PL", "system-b", "relative", "System B (PL110)"),
  m(0x1900, "PL", "media-coupler", "none", "Media coupler PL-TP"),
  // --- Radio frequency (RF) ---
  m(0x2010, "RF", "rf", "none", "RF bidirectional"),
  m(0x2110, "RF", "rf", "none", "RF unidirectional"),
  m(0x2311, "RF", "interface", "none", "RF USB interface v2"),
  m(0x2705, "RF", "system-7", "absolute", "System 7 (RF)"),
  m(0x27b0, "RF", "system-b", "relative", "System B (RF)"),
  m(0x2920, "RF", "media-coupler", "none", "TP1/RF media coupler 2.0"),
  // --- IP ---
  m(0x3012, "IP", "system-1", "bcu1", "IP BCU1"),
  m(0x4012, "IP", "system-1", "bcu1", "IP BCU1"),
  m(0x5705, "IP", "system-7", "absolute", "System 7 (IP)"),
  m(0x57b0, "IP", "system-b", "relative", "System B (IP)"),
];

const BY_MASK = new Map(MASKS.map((info) => [info.mask, info]));

// Normalise a mask string to the canonical "MV-XXXX" form. Accepts "MV-0705", "0705",
// "705", "mv-705" etc. Returns "" if it cannot be parsed as a hex mask.
function canonical(mask: string): string {
  const hex = mask.trim().replace(/^MV-/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(hex)) return "";
  return `MV-${parseInt(hex, 16).toString(16).toUpperCase().padStart(4, "0")}`;
}

// Canonical mask equality: "MV-07B0", "07B0", "7b0" all name the same mask. Used by the
// device-session safety gate (wrong device/application aborts), which previously did a
// SUBSTRING match. Unparseable input never equals anything (fail closed).
export function sameMask(a: string, b: string): boolean {
  const ca = canonical(a), cb = canonical(b);
  return ca !== "" && ca === cb;
}

// Look up a mask version. An unrecognised (but parseable) mask resolves to an "unknown"
// family with no memory model, so the caller still gets a deterministic, honestly-unsupported
// answer rather than a crash. An unparseable mask resolves to hex 0 / unknown.
export function maskInfo(mask: string): MaskInfo {
  const canon = canonical(mask);
  const known = BY_MASK.get(canon);
  if (known) return known;
  const hex = canon ? parseInt(canon.replace("MV-", ""), 16) : 0;
  return { mask: canon || mask, hex, medium: "TP", family: "unknown", memoryModel: "none", name: `Unknown mask (${mask || "—"})` };
}

// True when the mask drives its load-state machines through the deprecated MEMORY-MAPPED
// interface (load control at StandardMemory 0x0104, load status at 46825+LsmIdx) rather than
// interface-object properties. The BIM M112 masks MV-0700/0701 do; every other supported family
// is property-mapped. Hardware-confirmed on MV-0701 (ABB US/U 4.2): the property path the
// MV-0705 flash uses does not drive these devices' LSMs; the memory-mapped one does.
export function isMemoryMappedLsm(mask: string): boolean {
  return maskInfo(mask).propertyMappedLsms === false;
}

// How a device of this mask leaves programming mode once its individual address is assigned. System 1
// (BCU1) has no device object to take PID_PROGMODE, and ETS ends the mode there with A_Restart after
// reading the descriptor at the new address (private corpus internal/captures/hager-th001). Every
// other family takes PID_PROGMODE 0. `mask` is what the device reported on the bus; where it reported
// none (a Data Secure unit answers a plain descriptor read with FFFF, a device that closed the connection
// gives nothing), Busforge takes `projectMask`, the mask of the application the project holds for the
// device. Any mask the device does report decides, registered or not.
export function progModeEndFor(mask: string, projectMask?: string): "property" | "restart" {
  const { hex } = maskInfo(mask);
  const shown = hex !== 0 && hex !== 0xffff;
  return maskInfo(shown ? mask : projectMask ?? mask).family === "system-1" ? "restart" : "property";
}
