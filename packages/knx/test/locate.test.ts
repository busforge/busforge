import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { blinkProgrammingMode } from "../src/locate.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// Finding a device by its programming LED, against a simulated device object whose PID 54 behaves as
// the bench MDT BE-02001.02 and Jung 400021SE answered it (a write answered with the value it holds) and
// as ETS's own switch-off on a Theben DALI gateway (MV-07B0) shows it: PropertyValue_Write 0/54 := 00,
// answered 00 (private corpus: captures/dali-ets6log-unload.txt).
class SimDevice implements KnxTransport {
  assignedIa = 0x12fa;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  progMode = 0x00;
  // What happened on the wire, in order: "connect", "read=xx", "write:xx", "disconnect".
  log: string[] = [];
  noProperty = false;      // PID 54 answered with no element (MV-0701)
  refusesOn = false;       // a write of 1 is answered with 0
  writesOffFail = 0;       // this many writes of 0 are acknowledged and never answered
  buttonAfterReads = -1;   // after this many reads in the hold, the device leaves programming mode itself
  private reads = 0;
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    if (tpdu[0] === 0x80) { this.log.push("connect"); return; }
    if (tpdu[0] === 0x81) { this.log.push("disconnect"); return; }
    const p = parseApdu(tpdu);
    if (p.control) return;
    const reply = (data: Buffer) => {
      this.onCemi?.(0x1138, this.assignedIa, tpAck(p.seq), false);
      this.onCemi?.(0x1138, this.assignedIa, apdu(p.seq, APCI.PROPERTY_RESPONSE, data), false);
    };
    const head = p.data.subarray(0, 4);
    if (p.apci === APCI.PROPERTY_READ) {
      this.reads++;
      if (this.buttonAfterReads >= 0 && this.reads > this.buttonAfterReads + 1) this.progMode = 0;
      this.log.push(`read=${this.progMode.toString(16).padStart(2, "0")}`);
      if (this.noProperty) return reply(Buffer.from([head[0], head[1], 0x00, 0x01]));
      return reply(Buffer.concat([head, Buffer.from([this.progMode])]));
    }
    if (p.apci === APCI.PROPERTY_WRITE) {
      const v = p.data[4];
      this.log.push(`write:${v.toString(16).padStart(2, "0")}`);
      if (v === 0 && this.writesOffFail > 0) { this.writesOffFail--; this.onCemi?.(0x1138, this.assignedIa, tpAck(p.seq), false); return; }
      if (!(v === 1 && this.refusesOn)) this.progMode = v;
      return reply(Buffer.concat([head, Buffer.from([this.progMode])]));
    }
  }
}

const fast = { ackMs: 50, responseMs: 100, retryGapMs: 5 };
const device = (sim: SimDevice) => new KnxDevice(sim, "1.1.56", undefined, fast);
const writes = (sim: SimDevice) => sim.log.filter((l) => l.startsWith("write:"));

describe("blinking the programming LED", () => {
  test("switches programming mode on, holds it with reads, and ends with it off, read back", async () => {
    const sim = new SimDevice();
    const dev = device(sim);
    await dev.connect();
    const r = await blinkProgrammingMode(dev, { holdMs: 120, pollMs: 40 });
    expect(r).toMatchObject({ kind: "located", endedBy: "time", progModeOff: true });
    expect(writes(sim)).toEqual(["write:01", "write:00"]);
    expect(sim.log.at(-1)).toBe("read=00");
    expect(sim.log.filter((l) => l === "read=01").length).toBeGreaterThanOrEqual(1);
    expect(sim.progMode).toBe(0);
  });

  test("a cancel during the hold ends it at once, with programming mode off", async () => {
    const sim = new SimDevice();
    const dev = device(sim);
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 60);
    const r = await blinkProgrammingMode(dev, { holdMs: 60_000, pollMs: 20, signal: ac.signal });
    expect(r.endedBy).toBe("cancel");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(writes(sim)).toEqual(["write:01", "write:00"]);
    expect(sim.progMode).toBe(0);
  });

  test("a device that leaves programming mode itself (its button) ends the hold, and is still switched off", async () => {
    const sim = new SimDevice();
    sim.buttonAfterReads = 1;
    const r = await blinkProgrammingMode(device(sim), { holdMs: 60_000, pollMs: 10 });
    expect(r.endedBy).toBe("device");
    expect(writes(sim)).toEqual(["write:01", "write:00"]);
  });

  test("a device without the property is refused before anything is written", async () => {
    const sim = new SimDevice();
    sim.noProperty = true;
    const e = await blinkProgrammingMode(device(sim), { holdMs: 100 }).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("LOCATE_NO_PROG_MODE_PROPERTY");
    expect(writes(sim)).toEqual([]);
  });

  test("a cancel accepted before the first write writes nothing", async () => {
    const sim = new SimDevice();
    const e = await blinkProgrammingMode(device(sim), { holdMs: 100, enterWrites: () => { throw new Error("cancelled"); } }).catch((x: unknown) => x);
    expect(String(e)).toMatch(/cancelled/);
    expect(writes(sim)).toEqual([]);
  });

  test("a device that does not take the mode is refused, and still switched off", async () => {
    const sim = new SimDevice();
    sim.refusesOn = true;
    const e = await blinkProgrammingMode(device(sim), { holdMs: 100 }).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("LOCATE_PROG_MODE_NOT_TAKEN");
    expect(writes(sim)).toEqual(["write:01", "write:00"]);
  });

  test("a switch-off that fails once is tried again on a new connection", async () => {
    const sim = new SimDevice();
    sim.writesOffFail = 3; // the three tries of one request
    const r = await blinkProgrammingMode(device(sim), { holdMs: 30, pollMs: 10 });
    expect(r.progModeOff).toBe(true);
    expect(writes(sim)).toEqual(["write:01", "write:00", "write:00", "write:00", "write:00"]);
    expect(sim.log).toContain("connect");
    expect(sim.progMode).toBe(0);
  });

  test("a switch-off that cannot be shown is a coded failure naming the button, never a success", async () => {
    const sim = new SimDevice();
    sim.writesOffFail = 99;
    const e = await blinkProgrammingMode(device(sim), { holdMs: 30, pollMs: 10 }).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("LOCATE_PROG_MODE_LEFT_ON");
    expect(String((e as Error).message)).toMatch(/programming button/);
  });

  test("the switch-off failure keeps what failed before it", async () => {
    const sim = new SimDevice();
    sim.refusesOn = true;
    sim.writesOffFail = 99;
    const e = await blinkProgrammingMode(device(sim), { holdMs: 30 }).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("LOCATE_PROG_MODE_LEFT_ON");
    expect(String((e as Error).message)).toMatch(/did not take programming mode/);
  });
});
