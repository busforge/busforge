import { test, expect, describe, mock, afterAll, setDefaultTimeout } from "bun:test";
import { parseApdu, tpAck, type KnxTransport } from "@busforge/knx";
import type { Connection } from "../src/db/connections.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { tempDir } from "../../../tools/test-temp.ts";

setDefaultTimeout(60_000);

// Finding a device: the family gate on the mask the device reports, against a simulated device on the
// transport. It answers the descriptor read with `mask` and holds PID 54 of the device object; every
// property write is logged, so a refusal can be shown to have written nothing.
class SimDevice implements KnxTransport {
  assignedIa = 0x12fa;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  progMode = 0;
  writes: string[] = [];
  constructor(private readonly mask: string) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const dst = cemi.readUInt16BE(6);
    const tpdu = cemi.subarray(9);
    const p = parseApdu(tpdu);
    if (p.control || (tpdu[0] & 0xc0) === 0x80) return;
    const reply = (hex: string) => {
      const a = Buffer.from(hex, "hex");
      a[0] = 0x40 | (p.seq << 2) | (a[0] & 0x03);
      queueMicrotask(() => { this.onCemi?.(dst, this.assignedIa, tpAck(p.seq), false); this.onCemi?.(dst, this.assignedIa, a, false); });
    };
    if (p.apci === 0x300) return reply("0340" + this.mask);
    if (p.apci === 0x3d5 && p.data[1] === 54) return reply(`03d6003610010${this.progMode}`);
    if (p.apci === 0x3d7) {
      this.writes.push(p.data.toString("hex"));
      this.progMode = p.data[4] & 1;
      return reply(`03d6003610010${this.progMode}`);
    }
  }
}

let sim = new SimDevice("07b0");
const realTransport = await import("../src/transport.ts");
const realMake = realTransport.makeTransport;
let makeImpl: typeof realMake = () => sim;
await mock.module("../src/transport.ts", () => ({ ...realTransport, makeTransport: (c: Connection) => makeImpl(c) }));
const { locateDevice } = await import("../src/deviceprofile.ts");
const { handleApi, createState } = await import("../src/app.ts");
afterAll(() => { makeImpl = realMake; });

const conn = { id: "sim", kind: "ip" } as unknown as Connection;
const code = (e: unknown) => (e as { code?: string }).code;

describe("finding a device by its programming LED", () => {
  test("System B: programming mode on, then off, read back", async () => {
    sim = new SimDevice("07b0");
    const r = await locateDevice(conn, "1.1.56", undefined, { holdMs: 50 });
    expect(r).toMatchObject({ kind: "located", endedBy: "time", progModeOff: true });
    expect(sim.writes).toEqual(["00361001" + "01", "00361001" + "00"]);
    expect(sim.progMode).toBe(0);
  });

  test("System 7 with property-mapped load control (MV-0705) is switched the same way", async () => {
    sim = new SimDevice("0705");
    await locateDevice(conn, "1.1.56", undefined, { holdMs: 20 });
    expect(sim.writes.length).toBe(2);
  });

  test("System 1, memory-mapped System 7 and an interface are refused before anything is written", async () => {
    for (const mask of ["0012", "0701", "091a"]) {
      sim = new SimDevice(mask);
      const e = await locateDevice(conn, "1.1.56", undefined, { holdMs: 20 }).catch((x: unknown) => x);
      expect(code(e)).toBe("LOCATE_UNSUPPORTED_FAMILY");
      expect(sim.writes).toEqual([]);
    }
  });

  test("a Data Secure device read without its key is refused as such, not as a wrong family", async () => {
    sim = new SimDevice("ffff");
    const e = await locateDevice(conn, "1.1.204", undefined, { holdMs: 20 }).catch((x: unknown) => x);
    expect(code(e)).toBe("SECURE_KEY_MISSING");
    expect(sim.writes).toEqual([]);
  });
});

// A project with one device, for the route.
const M = "M-0009";
const HP = `${M}_H-9.20.2F.2F.20TH001-1_HP`;
const PRODUCT = `${M}_H-9.20.2F.2F.20TH001-1_P-TH001`;
const hardware = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="${M}"><Hardware>
  <Hardware Id="${M}_H-9.20.2F.2F.20TH001-1" Name="TH001" VersionNumber="1">
    <Products><Product Id="${PRODUCT}" Text="Modular RS 232" OrderNumber="TH001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${HP}"/></Hardware2Programs>
  </Hardware>
</Hardware></Manufacturer></ManufacturerData></KNX>`;
const project = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><Project Id="P-0001"><Installations><Installation Name="">
  <Topology><Area Id="P-0001-0_A-1" Address="1"><Line Id="P-0001-0_L-1" Address="1"><Segment Id="P-0001-0_S-1" Number="0" MediumTypeRefId="MT-0">
    <DeviceInstance Id="P-0001-0_DI-1" Address="56" Name="" ProductRefId="${PRODUCT}" Hardware2ProgramRefId="${HP}"/>
  </Segment></Line></Area></Topology>
</Installation></Installations></Project></KNX>`;
async function setup() {
  const dir = tempDir("busforge-locate-");
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const call = async (path: string, init?: RequestInit) => (await handleApi(new Request(`http://x${path}`, init), state))!.json() as Promise<any>;
  const form = new FormData();
  form.set("file", new File([storeZip({ [`${M}/Hardware.xml`]: hardware, "P-0001/0.xml": project })], "TH001.knxproj"));
  const { id } = await call("/api/projects/import", { method: "POST", body: form });
  const c = await call("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }) });
  await call(`/api/projects/${id}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: c.id }) });
  const locate = (body: unknown) => handleApi(new Request(`http://x/api/projects/${id}/devices/P-0001-0_DI-1/locate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), state);
  return { state, locate };
}

describe("the locate route", () => {
  test("refuses a duration outside 1 to 120 whole seconds before anything is queued", async () => {
    const { locate } = await setup();
    for (const seconds of [0, 121, 1.5, "30", undefined]) {
      const res = (await locate({ seconds }))!;
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe("LOCATE_DURATION_INVALID");
    }
  });

  test("queues a write that a cancel ends early, with programming mode off", async () => {
    const { state, locate } = await setup();
    sim = new SimDevice("07b0");
    const res = (await locate({ seconds: 60 }))!;
    expect(res.status).toBe(202);
    const task = await res.json() as { id: string; kind: string; writes: boolean };
    expect(task).toMatchObject({ kind: "locate", writes: true });
    while (sim.progMode === 0) await Bun.sleep(5);
    expect(state.queue.cancel(task.id)).toBe("running");
    const done = (await state.queue.wait(task.id))!;
    expect(done.state).toBe("done");
    expect(done.result).toMatchObject({ kind: "located", endedBy: "cancel", progModeOff: true });
    expect(sim.progMode).toBe(0);
  });
});
