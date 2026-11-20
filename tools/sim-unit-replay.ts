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
  // Undefined where the request was not sent (`skipUnconfirmedEnd`).
  simCon: "OK" | "NEG" | undefined;
}

// The cEMI frame of a capture line's KNXnet/IP frame.
export const cemiOfLine = (line: string) => { const f = Buffer.from(line.match(/\| ([0-9a-fA-F]+)\s*$/)![1], "hex"); return f.subarray(f[0] + f[f[0]]); };
// A broadcast (the address type in the second control field) is marked as one.
const frameOf = (cemi: Buffer, tpdu: Buffer) => `${cemi[2 + cemi[1]].toString(16).padStart(2, "0")} ${cemi[3 + cemi[1]] & 0x80 ? "broadcast " : ""}${tpdu.toString("hex")}`;
// KNXnet/IP tunnelling: the interface confirms a request within 3 s or not at all.
const CONFIRMATION_TIMEOUT_MS = 3_000;

// A step holds the frames the unit sent between its request and the next one; an answer that comes after the
// tool's next request (a T_Disconnect sent while the unit still answers) lands one step later than the
// simulator's, so frames are compared in their order (framePairs), not by step. `tool` is the proxy's name for
// it (`ETS`, `Busforge`); a request from 0.0.0 goes from the tunnel address the capture's last CONNECT_RES before
// it assigned, as the interface sends it, or from `interfaceIa` where the capture holds none. `clock` is set to
// each request's time before it is sent. `skipUnconfirmedEnd`: the requests at the end of a capture that ends before
// the interface confirmed them are not sent (their step holds no answer and no confirmation of the simulator); a
// request inside it without a confirmation is refused. With `broadcasts`, the tool's broadcasts (the address reads)
// and the unit's are replayed with the rest; group telegrams never are. A confirmation goes to the oldest request
// with its TPDU sent within the interface's confirmation timeout before it; a request whose confirmation the
// capture lacks keeps none. `from` (ms since the epoch) starts the replay later in the capture.
export async function replayCapture(sim: SimUnit, text: string, opts: { tool: string; device: number; interfaceIa: number; clock: (ms: number) => void; skipUnconfirmedEnd?: boolean; broadcasts?: boolean; from?: number }): Promise<ReplayStep[]> {
  const steps: (ReplayStep & { cemi: Buffer })[] = [];
  const pending: ReplayStep[] = [];
  const lines = text.split("\n");
  let at = 0, tunnel = opts.interfaceIa;
  for (const fr of captureLData(text, opts.tool)) {
    // The CONNECT_RES lines up to this frame's: one with status 0 carries the tunnel's address at the end of its CRD.
    for (; at < lines.length && lines[at] !== fr.line; at++) {
      const res = lines[at].match(/CONNECT_RES\s+\| ([0-9a-f]+)\s*$/);
      const crd = res ? Buffer.from(res[1], "hex") : null;
      if (crd && crd.length >= 20 && crd[7] === 0) tunnel = crd.readUInt16BE(18);
    }
    at++;
    const time = Date.parse(fr.line.split(" ")[0]);
    if ((fr.group && (fr.dst !== 0 || !opts.broadcasts)) || time < (opts.from ?? 0)) continue;
    const toUnit = fr.group || fr.dst === opts.device;
    if (fr.fromTool && fr.code === 0x11 && toUnit) {
      const cemi = Buffer.from(cemiOfLine(fr.line));
      if (cemi.readUInt16BE(4) === 0) cemi.writeUInt16BE(tunnel, 4);
      const s: ReplayStep & { cemi: Buffer } = { request: fr.tpdu.toString("hex"), at: time, unit: [], unitCon: undefined, sim: [], simCon: undefined, cemi };
      steps.push(s);
      pending.push(s);
    } else if (!fr.fromTool && fr.code === 0x2e && toUnit) {
      const k = pending.findIndex((p) => p.request === fr.tpdu.toString("hex") && time - p.at <= CONFIRMATION_TIMEOUT_MS);
      if (k >= 0) pending.splice(k, 1)[0].unitCon = fr.line.includes("CON-NEG") ? "NEG" : "OK";
    } else if (!fr.fromTool && fr.code === 0x29 && fr.src === opts.device) {
      const last = steps.at(-1);
      if (!last) throw new Error(`the unit sent ${fr.tpdu.toString("hex")} before the tool's first request, which the replay cannot attribute`);
      last.unit.push(frameOf(cemiOfLine(fr.line), fr.tpdu));
    }
  }
  let sent = steps.length;
  if (opts.skipUnconfirmedEnd) {
    while (sent > 0 && steps[sent - 1].unitCon === undefined) sent--;
    const inside = steps.slice(0, sent).findIndex((s) => s.unitCon === undefined);
    if (inside >= 0) throw new Error(`request ${inside} ${steps[inside].request} holds no confirmation inside the capture`);
  }
  const answered: string[] = [];
  const before = sim.onRawCemi;
  sim.onRawCemi = (c) => answered.push(frameOf(c, parseCemiLData(c).tpdu));
  try {
    for (const s of steps.slice(0, sent)) {
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

// Where the simulator's frames or confirmations differ from the unit's: one line per difference; with `context`, a
// frame's line also names the request it follows and up to that many of the unit's frames before it.
export function replayDifferences(steps: ReplayStep[], opts: { context?: number } = {}): string[] {
  const pairs = framePairs(steps);
  const around = (k: number, step: number) => {
    if (!opts.context || step < 0) return "";
    const before = pairs.slice(Math.max(0, k - opts.context), k).map((p) => p.unit ?? "nothing");
    return ` (request ${steps[step].request}; the unit's frames before: ${before.join(", ") || "none"})`;
  };
  return [...confirmationDifferences(steps), ...pairs.flatMap((f, k) => (f.unit === f.sim ? [] : [`frame ${k}: the unit sent ${f.unit ?? "nothing"} after request ${f.unitStep}, the simulator ${f.sim ?? "nothing"} after request ${f.simStep}${around(k, f.unitStep >= 0 ? f.unitStep : f.simStep)}`]))];
}
