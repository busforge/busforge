// A curated list of the common KNX datapoint subtypes, for the searchable type
// picker when editing a group address. Not exhaustive (KNX defines hundreds);
// the picker also folds in the datapoint types already used in the project and
// lets you enter any custom id, so nothing is locked out.
export interface DptOption { id: string; label: string }

export const DPT_CATALOG: DptOption[] = [
  { id: "1.001", label: "Switch (on/off)" },
  { id: "1.002", label: "Boolean (true/false)" },
  { id: "1.003", label: "Enable" },
  { id: "1.005", label: "Alarm" },
  { id: "1.008", label: "Up/Down" },
  { id: "1.009", label: "Open/Close" },
  { id: "1.010", label: "Start/Stop" },
  { id: "1.011", label: "State" },
  { id: "1.017", label: "Trigger" },
  { id: "1.018", label: "Occupancy" },
  { id: "1.019", label: "Window/Door" },
  { id: "2.001", label: "Switch control (1-bit + priority)" },
  { id: "3.007", label: "Dimming control" },
  { id: "3.008", label: "Blinds control" },
  { id: "4.001", label: "Character (ASCII)" },
  { id: "5.001", label: "Percent (0..100%)" },
  { id: "5.003", label: "Angle (0..360°)" },
  { id: "5.004", label: "Percent (0..255)" },
  { id: "5.010", label: "Counter pulses (0..255)" },
  { id: "6.010", label: "Counter pulses (-128..127)" },
  { id: "7.001", label: "Pulses (2-byte unsigned)" },
  { id: "7.012", label: "Current (mA)" },
  { id: "7.013", label: "Brightness (lux)" },
  { id: "8.001", label: "Pulses (2-byte signed)" },
  { id: "9.001", label: "Temperature (°C)" },
  { id: "9.002", label: "Temperature difference (K)" },
  { id: "9.004", label: "Brightness (lux)" },
  { id: "9.005", label: "Wind speed (m/s)" },
  { id: "9.006", label: "Pressure (Pa)" },
  { id: "9.007", label: "Humidity (%)" },
  { id: "9.008", label: "Air quality (ppm)" },
  { id: "9.020", label: "Voltage (mV)" },
  { id: "9.021", label: "Current (mA)" },
  { id: "9.024", label: "Power (kW)" },
  { id: "9.027", label: "Temperature (°F)" },
  { id: "10.001", label: "Time of day" },
  { id: "11.001", label: "Date" },
  { id: "12.001", label: "Counter (4-byte unsigned)" },
  { id: "13.001", label: "Counter (4-byte signed)" },
  { id: "13.010", label: "Active energy (Wh)" },
  { id: "13.013", label: "Active energy (kWh)" },
  { id: "14.056", label: "Power (W)" },
  { id: "14.076", label: "Volume (m³)" },
  { id: "16.000", label: "String (ASCII)" },
  { id: "16.001", label: "String (Latin-1)" },
  { id: "17.001", label: "Scene number" },
  { id: "18.001", label: "Scene control" },
  { id: "20.102", label: "HVAC mode" },
  { id: "28.001", label: "String (UTF-8)" },
  { id: "232.600", label: "RGB colour" },
];

// Catalog lookup by full id, for showing a datapoint's specific meaning (e.g.
// "Alarm" for 1.005) rather than only its main-type family ("Boolean").
const BY_ID = new Map(DPT_CATALOG.map((d) => [d.id, d]));
export function dptSubtypeLabel(id: string): string | undefined {
  return BY_ID.get(id)?.label;
}

// Merge the catalog with the datapoint types already present in the project (and
// the current value), so existing/custom ids are always offered. Deduped by id,
// sorted by numeric main then sub.
export function mergeDpts(extra: string[]): DptOption[] {
  const byId = new Map(DPT_CATALOG.map((d) => [d.id, d]));
  for (const id of extra) if (id && !byId.has(id)) byId.set(id, { id, label: "" });
  return [...byId.values()].sort((a, b) => {
    const [am, as] = a.id.split(".").map(Number);
    const [bm, bs] = b.id.split(".").map(Number);
    return am - bm || (as || 0) - (bs || 0);
  });
}
