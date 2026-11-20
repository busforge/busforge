// A logging-proxy capture (tools/knxproxy.ts) replayed into a simulated unit of any mask (tools/sim-unit.ts and the
// units on its core): every request the tool sent the unit, in order and on the capture's clock, beside the unit's
// frames and the interface's confirmations as the capture holds them.
import { parseCemiLData } from "../packages/knx/src/index.ts";
import { captureLData } from "./etsdiff.ts";
import type { SimUnit } from "./sim-unit.ts";

export interface ReplayStep {
  // The request's TPDU, as the tool sent it.
  request: string;
  at: number;
  // The unit's frames after it (first control field and TPDU, `b0 43400701`) and the interface's confirmation,
  // in the capture and from the simulator.
  unit: string[];
  unitCon: "OK" | "NEG" | undefined;
  sim: string[];
  simCon: "OK" | "NEG";
}

// KNXnet/IP tunnelling: the interface confirms a request within 3 s or not at all.
const CONFIRMATION_TIMEOUT_MS = 3_000;

// The cEMI frame of a capture line's KNXnet/IP frame.
const cemiOfLine = (line: string) => { const f = Buffer.from(line.match(/\| ([0-9a-fA-F]+)\s*$/)![1], "hex"); return f.subarray(f[0] + f[f[0]]); };
// A broadcast (the address type in the second control field) is marked as one.
const frameOf = (cemi: Buffer, tpdu: Buffer) => `${cemi[2 + cemi[1]].toString(16).padStart(2, "0")} ${cemi[3 + cemi[1]] & 0x80 ? "broadcast " : ""}${tpdu.toString("hex")}`;

// A step holds the frames the unit sent between its request and the next one; an answer that comes after the
// tool's next request (a T_Disconnect sent while the unit still answers) lands one step later than the
// simulator's, so frames are compared in their order (framePairs), not by step. `tool` is the proxy's name for
// it (`ETS`, `Busforge`); a request from 0.0.0 goes from `interfaceIa`, as the bridge sends it. `clock` is set to
// each request's time before it is sent. With `broadcasts`, the tool's broadcasts (the address reads) and the
// unit's are replayed with the rest; group telegrams never are. A confirmation goes to the oldest request with its
// TPDU sent within the interface's confirmation timeout before it; a request whose confirmation the capture lacks
// keeps none. `from` (ms since the epoch) starts the replay
// later in the capture.
export async function replayCapture(sim: SimUnit, text: string, opts: { tool: string; device: number; interfaceIa: number; clock: (ms: number) => void; from?: number; broadcasts?: boolean }): Promise<ReplayStep[]> {
  const steps: (ReplayStep & { cemi: Buffer })[] = [];
  const pending: ReplayStep[] = [];
  for (const fr of captureLData(text, opts.tool)) {
    const at = Date.parse(fr.line.split(" ")[0]);
    if ((fr.group && (fr.dst !== 0 || !opts.broadcasts)) || at < (opts.from ?? 0)) continue;
    const toUnit = fr.group || fr.dst === opts.device;
    if (fr.fromTool && fr.code === 0x11 && toUnit) {
      const cemi = Buffer.from(cemiOfLine(fr.line));
      if (cemi.readUInt16BE(4) === 0) cemi.writeUInt16BE(opts.interfaceIa, 4);
      const s = { request: fr.tpdu.toString("hex"), at, unit: [], unitCon: undefined, sim: [], simCon: "OK" as const, cemi };
      steps.push(s);
      pending.push(s);
    } else if (!fr.fromTool && fr.code === 0x2e && toUnit) {
      const k = pending.findIndex((p) => p.request === fr.tpdu.toString("hex") && at - p.at <= CONFIRMATION_TIMEOUT_MS);
      if (k >= 0) pending.splice(k, 1)[0].unitCon = fr.line.includes("CON-NEG") ? "NEG" : "OK";
    } else if (!fr.fromTool && fr.code === 0x29 && fr.src === opts.device) {
      const last = steps.at(-1);
      if (!last) throw new Error(`the unit sent ${fr.tpdu.toString("hex")} before the tool's first request, which the replay cannot attribute`);
      last.unit.push(frameOf(cemiOfLine(fr.line), fr.tpdu));
    }
  }
  const answered: string[] = [];
  const before = sim.onRawCemi;
  sim.onRawCemi = (c) => answered.push(frameOf(c, parseCemiLData(c).tpdu));
  try {
    for (const s of steps) {
      opts.clock(s.at);
      answered.length = 0;
      s.simCon = await sim.sendCemi(s.cemi).then(() => "OK" as const, () => "NEG" as const);
      await new Promise((r) => setTimeout(r, 2));
      s.sim = [...answered];
    }
  } finally {
    sim.onRawCemi = before;
  }
  return steps.map(({ cemi: _, ...s }) => s);
}

// The unit's and the simulator's frames side by side, in their order, each with the step it follows.
export interface FramePair { unit: string | undefined; unitStep: number; sim: string | undefined; simStep: number }
export function framePairs(steps: ReplayStep[]): FramePair[] {
  const flat = (side: "unit" | "sim") => steps.flatMap((s, i) => s[side].map((f) => ({ f, i })));
  const u = flat("unit"), m = flat("sim");
  return Array.from({ length: Math.max(u.length, m.length) }, (_, k) => ({ unit: u[k]?.f, unitStep: u[k]?.i ?? -1, sim: m[k]?.f, simStep: m[k]?.i ?? -1 }));
}

// The confirmations that differ, one line each.
export function confirmationDifferences(steps: ReplayStep[]): string[] {
  return steps.flatMap((s, i) => (s.unitCon === s.simCon ? [] : [`request ${i} ${s.request}: confirmed ${s.unitCon} by the unit's interface, ${s.simCon} by the simulator`]));
}

// Where the simulator's frames or confirmations differ from the unit's: one line per difference.
export function replayDifferences(steps: ReplayStep[]): string[] {
  return [...confirmationDifferences(steps), ...framePairs(steps).flatMap((f, k) => (f.unit === f.sim ? [] : [`frame ${k}: the unit sent ${f.unit ?? "nothing"} after request ${f.unitStep}, the simulator ${f.sim ?? "nothing"} after request ${f.simStep}`]))];
}
