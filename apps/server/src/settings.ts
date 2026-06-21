import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Settings { interfaceIp: string; port: number; }

const DEFAULTS: Settings = { interfaceIp: "203.0.113.41", port: 3671 };
const FILE = join(import.meta.dir, "..", "data", "settings.json");

export function loadSettings(): Settings {
  if (!existsSync(FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): Settings {
  mkdirSync(dirname(FILE), { recursive: true });
  const merged: Settings = { interfaceIp: String(s.interfaceIp), port: Number(s.port) };
  writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}
