// The weather guard of a run on a weather station in service. While the station restarts, and while
// a write ends with its restart, it sends no measured values and no alarms, so an awning whose wind
// lock waits for the station's alarm stays out in a gust. The run therefore reads the installation's
// weather addresses before the channel and before every write and restart, and stops when one of them
// does not answer, an alarm is set, or the wind is near the alarm threshold.
//
// The addresses and the threshold belong to the installation, so the operator gives them per run
// (--weather-guard), never the spec:
//
//   --weather-guard=wind:<ga>:<threshold m/s>,<name>:<ga>,...
//
// `wind` is read as a 2-byte float (DPT 9, m/s) and must stay below WIND_MARGIN of the threshold; every
// other entry is a 1-bit address (an alarm, rain, a lock) that must read 0. Every address must be
// answered by the station itself: an answer from another device (one holding a stored value) is no
// reading of the weather.
//
// The reads are a snapshot before a write: the station is silent through the whole write (a full
// download takes minutes) and its restart, and nothing is read in between.
import { decodeDpt9 } from "../../packages/product/src/index.ts";

// A wind reading at or above this share of the alarm threshold stops the run: the station may cross
// the threshold during a restart, when it sends nothing.
export const WIND_MARGIN = 0.7;
// No station's wind alarm lies above this (m/s); a larger threshold is a typing error that would
// make the wind check never stop.
const MAX_THRESHOLD_MS = 60;

export interface WeatherGuard {
  wind: { ga: string; thresholdMs: number };
  // 1-bit addresses that must read 0, by the operator's name for them.
  bits: { name: string; ga: string }[];
}

// Three levels, main 0-31, middle 0-7, sub 0-255.
const isGa = (ga: string): boolean => {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(ga);
  return !!m && Number(m[1]) <= 31 && Number(m[2]) <= 7 && Number(m[3]) <= 255;
};

// The operator's --weather-guard value, or the reason it is refused.
export function parseWeatherGuard(arg: string): WeatherGuard | { refused: string } {
  const refused = (why: string) => ({ refused: `--weather-guard=${arg}: ${why}` });
  let wind: WeatherGuard["wind"] | undefined;
  const bits: WeatherGuard["bits"] = [];
  const seen = new Set<string>();
  for (const entry of arg.split(",")) {
    const parts = entry.split(":");
    const [name, ga] = parts;
    if (!name || !ga || !isGa(ga)) return refused(`"${entry}" is not <name>:<main/middle/sub>`);
    if (seen.has(ga)) return refused(`${ga} is named twice`);
    seen.add(ga);
    if (name === "wind") {
      if (wind) return refused("wind is named twice");
      const threshold = Number(parts[2]);
      if (parts.length !== 3 || !Number.isFinite(threshold) || !(threshold > 0)) return refused(`"${entry}" gives no threshold: wind:<ga>:<m/s>`);
      if (threshold > MAX_THRESHOLD_MS) return refused(`a wind alarm threshold of ${threshold} m/s is above ${MAX_THRESHOLD_MS} m/s`);
      wind = { ga, thresholdMs: threshold };
    } else {
      if (parts.length !== 2) return refused(`"${entry}" is not <name>:<main/middle/sub>`);
      bits.push({ name, ga });
    }
  }
  if (!wind) return refused("no wind address: wind:<ga>:<threshold m/s>");
  return { wind, bits };
}

// What the guard's reads show: pass, or the reason to stop, naming each address by the operator's name
// only, since the reason goes into the run's record and the addresses belong to the installation. `answers` maps each address to the value
// the station's GroupValueResponse carried (hex), null where the station did not answer.
export function judgeWeather(g: WeatherGuard, answers: Map<string, string | null>): { pass: boolean; detail: string } {
  const seen: string[] = [];
  const stops: string[] = [];
  const w = answers.get(g.wind.ga) ?? null;
  const limit = Math.round(g.wind.thresholdMs * WIND_MARGIN * 100) / 100;
  // 0x7FFF is DPT 9's "invalid data".
  if (w === null) stops.push(`wind did not answer from the station`);
  else if (w.length !== 4 || w.toLowerCase() === "7fff") stops.push(`wind answered ${w}, not a 2-byte float`);
  else {
    const ms = decodeDpt9(parseInt(w, 16));
    seen.push(`wind ${ms} m/s (limit ${limit})`);
    if (ms >= limit) stops.push(`wind ${ms} m/s is at or above ${WIND_MARGIN * 100} % of the alarm threshold ${g.wind.thresholdMs} m/s`);
  }
  for (const b of g.bits) {
    const v = answers.get(b.ga) ?? null;
    if (v === null) stops.push(`${b.name} did not answer from the station`);
    else if (v === "00") seen.push(`${b.name} 0`);
    else if (v === "01") { seen.push(`${b.name} 1`); stops.push(`${b.name} is set`); }
    else stops.push(`${b.name} answered ${v}, not a 1-bit value`);
  }
  return stops.length ? { pass: false, detail: `${stops.join("; ")}${seen.length ? ` (read: ${seen.join(", ")})` : ""}` } : { pass: true, detail: seen.join(", ") };
}

export const guardAddresses = (g: WeatherGuard): { name: string; ga: string }[] => [{ name: "wind", ga: g.wind.ga }, ...g.bits];
