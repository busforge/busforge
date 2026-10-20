// Typed model of the Theben DALI-Gateway "Backup-Store", the logical DALI
// configuration as the ETS project holds it (not read from the device). The
// gateway's ETS DCA persists this as UTF-16 XML in the project's BinaryData; we
// parse it directly instead of running the DCA. Effects and templates in the
// store are not modelled.
// Field meanings recovered from the decompiled DCA (Dalie64.DcaApp.*); see
// docs/plugins.md.

// DALI lamp/control-gear type (DcaApp LampType).
export type LampType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 129;
export const lampTypeLabel: Record<number, string> = {
  0: "Fluorescent", 1: "Emergency", 2: "Discharge", 3: "Low voltage", 4: "Incandescent",
  5: "Converter", 6: "LED", 7: "Relay module", 8: "Colour", 129: "Emergency (non-switchable)",
};

// ECG commissioning state (DcaApp ECG.CommissioningFlag).
export type CommissioningFlag = 0 | 1 | 2 | 3 | 4 | 5;
export const commissioningLabel: Record<number, string> = {
  0: "-", 1: "-", 2: "Plan(E)", 3: "Plan", 4: "OK", 5: "Backup",
};

// Sentinel group indices (DcaApp Group).
export const GROUP_SINGLE = 16;     // controlled individually ("S")
export const GROUP_UNASSIGNED = 32;
export const GROUP_MISSING = 255;
export const SHORT_ADDR_UNASSIGNED = 255;
export const LONG_ADDR_EMPTY = "FFFFFF";

export interface DaliGroup { index: number; description: string; }

// A physically discovered control gear (one DALI short-address slot).
export interface DaliDevEcg {
  index: number;            // slot = short address (0-63)
  type: LampType;
  subtype: number;          // SubTypeFlags bitfield (1 XY, 2 TC, 4 PC, 8 RGBW, 0x80 non-switchable)
  groupIndex: number;
  shortAddress: number;     // 0-63, 255 = unassigned
  longAddress: string;      // 24-bit DALI long address as 6 hex digits; "FFFFFF" = empty slot
  minValue: number;         // DALI MIN LEVEL (0-254)
}

// A logical ECG channel as configured in ETS (links to a DevECG by short address).
export interface DaliEcg {
  index: number;            // 0-63
  groupIndex: number;
  shortAddress: number;
  flags: CommissioningFlag;
  type: LampType;
  description: string;      // installer name, e.g. "Kitchen 1"
}

export interface DaliSceneItem { itemKind: "Group" | "ECG"; itemIndex: number; valuePercent: number; }
export interface DaliScene {
  index: number;            // 0-15
  fadeTime: number;         // ColourFadeIn enum int
  knxScene: number;         // KNX scene number that triggers it (1-64)
  items: DaliSceneItem[];
}

export interface DaliDevice {
  individualAddress: string;
  project: string;
  type: string;             // "e64"
  version: string;          // DCA assembly version, e.g. "1.1.3.0"
  canRestore: boolean;
  groups: DaliGroup[];
  devEcgs: DaliDevEcg[];
  ecgs: DaliEcg[];
  scenes: DaliScene[];
}

export const isPresentEcg = (e: DaliEcg) => e.flags !== 0 && e.flags !== 1;
export const isPopulatedSlot = (d: DaliDevEcg) => d.longAddress.toUpperCase() !== LONG_ADDR_EMPTY;

// Resolve a group index to a human label, honouring the sentinel values.
export function groupLabel(groups: DaliGroup[], groupIndex: number): string {
  if (groupIndex === GROUP_SINGLE) return "S";
  if (groupIndex === GROUP_UNASSIGNED || groupIndex === GROUP_MISSING) return "-";
  const g = groups.find((x) => x.index === groupIndex);
  return g && g.description ? g.description : `Group ${groupIndex}`;
}
