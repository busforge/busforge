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
// everything else has no implemented programming path (-> UnsupportedProfile).
export type MemoryModel =
  | "absolute" // System 7: parameters in fixed AbsoluteSegments, System-7 group tables
  | "relative" // System B: parameters in a relative LSM4 segment, count-prefixed group tables
  | "bcu1" // System 1 fixed EEPROM model (not implemented)
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
}

// The full table. One row per known mask version. `m()` keeps the rows terse.
const m = (hex: number, medium: Medium, family: SystemFamily, memoryModel: MemoryModel, name: string): MaskInfo => ({
  mask: `MV-${hex.toString(16).toUpperCase().padStart(4, "0")}`,
  hex,
  medium,
  family,
  memoryModel,
  name,
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
  m(0x0700, "TP", "system-7", "absolute", "System 7 (BIM M112)"),
  m(0x0701, "TP", "system-7", "absolute", "System 7 (BIM M112)"),
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
