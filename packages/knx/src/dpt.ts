// Decode a KNX group-value payload into a human-readable string using its
// datapoint type. Pure and browser-safe (no node imports) so the web app can
// use it directly. Covers the common scalar DPTs; unknown types fall back to
// hex. `dpt` is the display form "main.sub" (e.g. "9.001", "1.001").

const hexToBytes = (hex: string): number[] => {
  const b: number[] = [];
  for (let i = 0; i + 1 < hex.length + 1 && i + 2 <= hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
  return b;
};

const fmt = (n: number, digits = 2): string => {
  if (!Number.isFinite(n)) return String(n);
  return Number(n.toFixed(digits)).toString();
};

// DPT 9: KNX 2-byte float = 0.01 * M * 2^E, M an 11-bit two's-complement mantissa.
function knxFloat16(b0: number, b1: number): number {
  const raw = (b0 << 8) | b1;
  const exp = (raw >> 11) & 0x0f;
  let mant = raw & 0x07ff;
  if (raw & 0x8000) mant -= 2048;
  return 0.01 * mant * Math.pow(2, exp);
}

const BOOL_LABELS: Record<string, [string, string]> = {
  "1.001": ["Off", "On"], "1.002": ["False", "True"], "1.003": ["Disable", "Enable"],
  "1.005": ["No alarm", "Alarm"], "1.006": ["Low", "High"], "1.007": ["Decrease", "Increase"],
  "1.008": ["Up", "Down"], "1.009": ["Open", "Close"], "1.010": ["Stop", "Start"],
  "1.011": ["Inactive", "Active"], "1.100": ["Cooling", "Heating"],
};
const UNIT_9: Record<string, string> = {
  "9.001": "°C", "9.002": "K", "9.003": "K/h", "9.004": "lx", "9.005": "m/s", "9.006": "Pa",
  "9.007": "%", "9.008": "ppm", "9.010": "s", "9.011": "ms", "9.020": "mV", "9.021": "mA",
  "9.022": "W/m²", "9.024": "kW", "9.025": "l/h", "9.027": "°F", "9.028": "km/h",
};
const UNIT_7: Record<string, string> = { "7.002": "ms", "7.003": "ms", "7.004": "ms", "7.005": "s", "7.006": "min", "7.007": "h", "7.011": "mm", "7.012": "mA", "7.013": "lx" };
const UNIT_14: Record<string, string> = { "14.007": "°", "14.019": "A", "14.027": "V", "14.028": "V", "14.033": "Hz", "14.056": "W", "14.065": "m/s", "14.068": "°C", "14.076": "m³" };
const HVAC_20_102 = ["Auto", "Comfort", "Standby", "Economy", "Building Protection"];

export function decodeDpt(hex: string, dpt: string | undefined): string {
  const fallback = hex ? `0x${hex}` : "";
  // Accept "main.sub" ("9.001"), main-only with wildcard ("9.*"), and bare "9".
  const main = dpt ? parseInt(dpt, 10) : NaN;
  if (!Number.isFinite(main)) return fallback;
  const sub = dpt!.split(".")[1] ?? "";
  const key = `${main}.${sub}`;
  const b = hexToBytes(hex);
  const u16 = () => (b[0] << 8) | (b[1] ?? 0);
  const s16 = () => { const v = u16(); return v & 0x8000 ? v - 0x10000 : v; };

  switch (main) {
    case 1: { const [off, on] = BOOL_LABELS[key] ?? ["Off", "On"]; return (b[0] ?? 0) & 1 ? on : off; }
    case 2: { const v = (b[0] ?? 0) & 0x03; return `${v & 0x02 ? "ctrl " : ""}${v & 0x01 ? "On" : "Off"}`; }
    case 3: { const v = (b[0] ?? 0) & 0x0f; const step = v & 0x07; const dir = v & 0x08 ? "Increase" : "Decrease"; return step === 0 ? "Break" : `${dir} ${step}`; }
    case 5: {
      const v = b[0] ?? 0;
      if (key === "5.001") return `${Math.round((v * 100) / 255)} %`;
      if (key === "5.003") return `${Math.round((v * 360) / 255)}°`;
      if (key === "5.004") return `${v} %`;
      return String(v);
    }
    case 6: return String((b[0] ?? 0) & 0x80 ? (b[0] ?? 0) - 256 : b[0] ?? 0);
    case 7: return `${u16()}${UNIT_7[key] ? " " + UNIT_7[key] : ""}`;
    case 8: return `${s16()}`;
    case 9: return b.length >= 2 ? `${fmt(knxFloat16(b[0], b[1]))}${UNIT_9[key] ? " " + UNIT_9[key] : ""}` : `0x${hex}`;
    case 10: { // time of day: day(3b) + hour(5b), min, sec
      if (b.length < 3) return fallback;
      const days = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const day = (b[0] >> 5) & 0x07, h = b[0] & 0x1f, m = b[1] ?? 0, s = b[2] ?? 0;
      const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      return day ? `${days[day]} ${t}` : t;
    }
    case 11: { if (b.length < 3) return fallback; const d = b[0], mo = b[1], y = b[2]; return `${String(d).padStart(2, "0")}.${String(mo).padStart(2, "0")}.${y < 90 ? 2000 + y : 1900 + y}`; }
    case 12: return b.length < 4 ? fallback : String(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
    case 13: return b.length < 4 ? fallback : String((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]);
    case 14: { if (b.length < 4) return `0x${hex}`; const f = new DataView(new Uint8Array(b).buffer).getFloat32(0, false); return `${fmt(f, 3)}${UNIT_14[key] ? " " + UNIT_14[key] : ""}`; }
    case 16: return String.fromCharCode(...b.filter((c) => c > 0));
    case 17: case 18: return `Scene ${((b[0] ?? 0) & 0x3f) + 1}`;
    case 19: { // date+time (8 bytes): year+1900, month, day, hour...
      if (b.length < 6) return `0x${hex}`;
      const y = 1900 + b[0], mo = b[1] & 0x0f, d = b[2] & 0x1f, h = b[3] & 0x1f, mi = b[4] & 0x3f, s = b[5] & 0x3f;
      return `${String(d).padStart(2, "0")}.${String(mo).padStart(2, "0")}.${y} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    case 20: { const v = b[0] ?? 0; if (key === "20.102" && HVAC_20_102[v]) return HVAC_20_102[v]; return String(v); }
    default: return b.length > 0 && b.length <= 4 ? String(b.reduce((a, c) => (a << 8) | c, 0) >>> 0) : `0x${hex}`;
  }
}
