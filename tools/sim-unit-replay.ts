// A logging-proxy capture (tools/knxproxy.ts) replayed into a simulated unit (tools/sim-unit.ts): every request
// the tool sent the unit, in order and on the capture's clock, beside the unit's frames and the interface's
// confirmations as the capture holds them. A step holds the frames the unit sent between its request and the
// next one; an answer that comes after the tool's next request (a T_Disconnect sent while the unit still
// answers) lands one step later than the simulator's, so frames are compared in their order, not by step.
import { parseCemiLData } from "../packages/knx/src/index.ts";
import { parseTunnelFrame } from "./etsdiff.ts";
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

// The cEMI frame of a capture line's KNXnet/IP frame.
const cemiOf = (hex: string) => { const f = Buffer.from(hex, "hex"); return f.subarray(f[0] + f[f[0]]); };
const frameOf = (cemi: Buffer, tpdu: Buffer) => `${cemi[2 + cemi[1]].toString(16).padStart(2, "0")} ${tpdu.toString("hex")}`;

// `tool` is the proxy's name for it (`ETS`, `Busforge`); a request from 0.0.0 goes from `interfaceIa`, as the bridge
// sends it. `clock` is set to each request's capture time before it is sent.
export async function replayCapture(sim: SimUnit, text: string, opts: { tool: string; device: number; interfaceIa: number; clock: (ms: number) => void }): Promise<ReplayStep[]> {
  const steps: (ReplayStep & { cemi: Buffer })[] = [];
  const pending: ReplayStep[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/\| ([0-9a-fA-F]+)\s*$/);
    const fr = m && line.includes("TUNNELLING_REQ") ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group) continue;
    if (line.includes(`${opts.tool}->BRIDGE`) && fr.code === 0x11 && fr.dst === opts.device) {
      const cemi = Buffer.from(cemiOf(m![1]));
      if (cemi.readUInt16BE(4) === 0) cemi.writeUInt16BE(opts.interfaceIa, 4);
      const s = { request: fr.tpdu.toString("hex"), at: Date.parse(line.split(" ")[0]), unit: [], unitCon: undefined, sim: [], simCon: "OK" as const, cemi };
      steps.push(s);
      pending.push(s);
    } else if (line.includes(`BRIDGE->${opts.tool}`) && fr.code === 0x2e && fr.dst === opts.device) {
      const s = pending.shift();
      if (s) s.unitCon = line.includes("CON-NEG") ? "NEG" : "OK";
    } else if (line.includes(`BRIDGE->${opts.tool}`) && fr.code === 0x29 && fr.src === opts.device) {
      steps.at(-1)?.unit.push(frameOf(cemiOf(m![1]), fr.tpdu));
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

// Where the simulator's frames or confirmations differ from the unit's: one line per difference.
export function replayDifferences(steps: ReplayStep[]): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => { if (s.unitCon !== s.simCon) out.push(`request ${i} ${s.request}: confirmed ${s.unitCon} by the unit's interface, ${s.simCon} by the simulator`); });
  framePairs(steps).forEach((f, k) => { if (f.unit !== f.sim) out.push(`frame ${k}: the unit sent ${f.unit ?? "nothing"} after request ${f.unitStep}, the simulator ${f.sim ?? "nothing"} after request ${f.simStep}`); });
  return out;
}
