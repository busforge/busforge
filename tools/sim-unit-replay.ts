// What the tests of the simulated units (tools/sim-unit.ts, tools/sim-unit-0701.ts) share: a logging-proxy capture
// (tools/knxproxy.ts) read as frames and replayed into a simulator, and Busforge's full download into one
// through KnxIpServer and the proxy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { KnxIpServer, parseCemiLData } from "../packages/knx/src/index.ts";
import { downloadDeviceFull } from "../apps/server/src/deviceprofile.ts";
import type { Connection } from "../apps/server/src/db/connections.ts";
import { parseTunnelFrame } from "./etsdiff.ts";
import { startProxy } from "./knxproxy.ts";
import type { SimProperty, SimUnit } from "./sim-unit.ts";
import { removeTempDir, tempDir } from "./test-temp.ts";

// A property as the unit answered it, from element 1, its count read.
export const simProperty = (...elements: string[]): SimProperty => ({ elements: elements.map((e) => Buffer.from(e, "hex")), countKnown: true });

// The cEMI frame of a capture line's KNXnet/IP frame.
export const cemiOf = (hex: string) => { const f = Buffer.from(hex, "hex"); return f.subarray(f[0] + f[f[0]]); };

export interface CaptureFrame { dir: ">>" | "<<"; tpdu: string; con?: "OK" | "NEG"; ctrl?: number; to?: number }
// The L_Data frames of a capture between the tool and the unit: the tool's requests with the interface's
// confirmation, the unit's frames to the interface with their first control field.
export function captureFrames(text: string, tool: string, device: number): CaptureFrame[] {
  const out: CaptureFrame[] = [];
  const pending: CaptureFrame[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/\| ([0-9a-fA-F]+)\s*$/);
    const fr = m && line.includes("TUNNELLING_REQ") ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group) continue;
    if (line.includes(`${tool}->BRIDGE`) && fr.code === 0x11 && fr.dst === device) { const f: CaptureFrame = { dir: ">>", tpdu: fr.tpdu.toString("hex") }; out.push(f); pending.push(f); }
    else if (line.includes(`BRIDGE->${tool}`) && fr.code === 0x2e && fr.dst === device) { const f = pending.shift(); if (f) f.con = line.includes("CON-NEG") ? "NEG" : "OK"; }
    else if (line.includes(`BRIDGE->${tool}`) && fr.code === 0x29 && fr.src === device) { const c = cemiOf(m![1]); out.push({ dir: "<<", tpdu: fr.tpdu.toString("hex"), ctrl: c[2 + c[1]], to: fr.dst }); }
  }
  return out;
}

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

const frameOf = (cemi: Buffer, tpdu: Buffer) => `${cemi[2 + cemi[1]].toString(16).padStart(2, "0")} ${tpdu.toString("hex")}`;

// Every request the tool sent the unit in a capture, replayed in order into a simulator on the capture's clock,
// beside the unit's frames and the interface's confirmations as the capture holds them. A step holds the frames
// the unit sent between its request and the next one; an answer that comes after the tool's next request (a
// T_Disconnect sent while the unit still answers) lands one step later than the simulator's, so frames are
// compared in their order, not by step. `tool` is the proxy's name for it (`ETS`, `Busforge`); a request from
// 0.0.0 goes from `interfaceIa`, as the bridge sends it. `clock` is set to each request's time before it is sent.
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
      const last = steps.at(-1);
      if (!last) throw new Error(`the unit sent ${fr.tpdu.toString("hex")} before the tool's first request, which the replay cannot attribute`);
      last.unit.push(frameOf(cemiOf(m![1]), fr.tpdu));
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

// A port for the KNXnet/IP server, which takes a port number for its UDP socket and TCP listener alike.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
  });
}

export interface SimProject { ia: string; params: Map<string, string>; links: { comObjNum: number; gaRaws: number[] }[] }

// Busforge's full download through KnxIpServer and the logging proxy the captures are taken with, as the server's
// download task runs it, into `sim`; the proxy's capture of the session, which ends with its T_Ack and T_Disconnect
// after the result.
export async function busforgeFullDownload(sim: SimUnit, opts: { interfaceMaxApdu: number; appXml: string; project: SimProject }) {
  const dir = tempDir("busforge-sim-unit-");
  const port = await freePort();
  const server = new KnxIpServer({ transport: sim, maxApdu: opts.interfaceMaxApdu, port });
  const log = join(dir, "capture.log");
  const proxy = startProxy({ port: 0, bridgeHost: "127.0.0.1", bridgePort: port, log, tool: "Busforge" });
  try {
    await server.start();
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const proxyPort = (proxy.address() as { port: number }).port;
    const connection: Connection = { id: "sim", name: "sim", type: "ip", host: "127.0.0.1", port: proxyPort, ipTransport: "tcp", usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0 };
    const { ia, params, links } = opts.project;
    const result = await downloadDeviceFull({ projectId: "p", deviceId: "d", ia, appXml: opts.appXml, dataDir: dir, connection, params, links, comObjectOverrides: new Map(), dryRun: false });
    for (let i = 0; !readFileSync(log, "utf8").includes("DISCONNECT_REQ"); i++) {
      if (i === 100) throw new Error("the session did not end within 10 s of the download's result");
      await new Promise((r) => setTimeout(r, 100));
    }
    return { result, capture: readFileSync(log, "utf8") };
  } finally {
    proxy.close();
    await server.stop();
    removeTempDir(dir);
  }
}
