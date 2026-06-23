import { XMLParser } from "fast-xml-parser";
import type { CommissioningFlag, DaliDevice, DaliScene, DaliSceneItem, LampType } from "./model.ts";

// Decode the backup-store bytes to text. The DCA writes UTF-16 (Encoding.Unicode);
// accept UTF-8 too so a pre-decoded string round-trips. Detect UTF-16 by a BOM or
// the characteristic interleaved NUL bytes of ASCII-heavy XML. UTF-16 is decoded
// by hand (BMP code units, covers Latin-1 + umlauts) so the decoder runs the same
// in the browser and under Bun without depending on a typed TextDecoder label.
function decode(input: Uint8Array | string): string {
  if (typeof input === "string") return input;
  const b = input;
  const bomLe = b.length >= 2 && b[0] === 0xff && b[1] === 0xfe;
  const bomBe = b.length >= 2 && b[0] === 0xfe && b[1] === 0xff;
  const heurLe = b.length >= 2 && b[0] === 0x3c && b[1] === 0x00; // UTF-16LE "<"
  if (bomLe || bomBe || heurLe) {
    const be = bomBe;
    let s = "";
    for (let i = bomLe || bomBe ? 2 : 0; i + 1 < b.length; i += 2) {
      s += String.fromCharCode(be ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8));
    }
    return s;
  }
  return new TextDecoder("utf-8").decode(b);
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const int = (v: unknown, dflt = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };

// Parse a Theben e64 backup-store into the typed model. Tolerant of missing
// sections (a fresh device may have empty <scenes> etc.).
export function parseDaliStore(input: Uint8Array | string): DaliDevice {
  const xml = decode(input);
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const root = p.parse(xml);
  const dev = root.device;
  if (!dev) throw new Error("backup-store: no <device> root (unrecognised format)");

  const groups = arr(dev.groups?.Group).map((g: any) => ({
    index: int(g.index), description: String(g.description ?? ""),
  }));

  const devEcgs = arr(dev.devecgs?.DevECG).map((d: any) => ({
    index: int(d.index),
    type: int(d.type) as LampType,
    subtype: int(d.subtype),
    groupIndex: int(d["groupindex"]),
    shortAddress: int(d["short-address"]),
    longAddress: String(d["long-address"] ?? "FFFFFF"),
    minValue: int(d["min-value"]),
  }));

  const ecgs = arr(dev.ecgs?.ECG).map((e: any) => ({
    index: int(e.index),
    groupIndex: int(e["groupindex"]),
    shortAddress: int(e["short-address"]),
    flags: int(e.flags) as CommissioningFlag,
    type: int(e.type) as LampType,
    description: String(e.description ?? ""),
  }));

  const scenes: DaliScene[] = arr(dev.scenes?.Scene).map((s: any) => {
    const items: DaliSceneItem[] = arr(s.SceneItem).map((it: any) => ({
      itemKind: String(it.itemtype ?? "").endsWith("Group") ? "Group" : "ECG",
      itemIndex: int(it.itemindex),
      valuePercent: int(it.value),
    }));
    return { index: int(s.index), fadeTime: int(s.fadeTime), knxScene: int(s.knxScene), items };
  });

  return {
    individualAddress: String(dev.IndividualAddress ?? ""),
    project: String(dev.Project ?? ""),
    type: String(dev.type ?? ""),
    version: String(dev.version ?? ""),
    canRestore: String(dev.CanRestore ?? "").toLowerCase() === "true",
    groups, devEcgs, ecgs, scenes,
  };
}
