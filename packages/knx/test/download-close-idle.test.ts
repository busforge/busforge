import { test, expect, jest, afterEach } from "bun:test";
import { KnxDevice, PID, VERIFY_MODE } from "../src/device.ts";
import { planSystemBFullDownload, appId, STATE } from "../src/flash.ts";
import { runLoadPlan } from "../src/loadrunner.ts";
import { apdu, parseApdu, tpAck, tpDisconnect, APCI, type KnxTransport } from "../src/index.ts";

// The close of a thelsing/OpenKNX full download (planSystemBFullDownload without closeAtOnce): its
// waits after the last LoadCompleted (the device's flash commit, the eight-second save timer) are
// spent without an open connection, so the device never closes one for idleness and never refuses a
// request of ours, and the restart arrives on a connection of its own.
//
// The unit acts on the transport layer as thelsing/knx does: it closes a connection that carries no
// frame from us for 6 s (sending T_Disconnect), takes a T_Connect from the partner it is connected to as
// nothing (keeping that connection's sequence numbers), refuses a numbered frame out of sequence with
// T_NAK and answers one while closed with T_Disconnect. A_Restart reboots it: silent for 3 s, connection
// gone. Timers are faked, so the 8 s settle and the request timeouts cost no real time.
const IDLE_CLOSE_MS = 6_000, REBOOT_MS = 3_000;
const OBJ_BASE: Record<number, number> = { 1: 0x5000, 2: 0x5100, 3: 0x5200, 4: 0x6000 };

class ThelsingUnit implements KnxTransport {
  assignedIa = 0x11ff;
  onCemi: KnxTransport["onCemi"] = null;
  onClosed: KnxTransport["onClosed"] = null;
  readonly device = 0x1203; // 1.2.3
  idleClosures: number[] = [];   // when the unit closed an idle connection
  naks: number[] = [];           // when it refused a frame of ours with T_NAK
  connectsWhileOpen = 0;
  restartAt: number | null = null;
  lastMemoryTouch = 0;           // the last write the save timer counts (memory, load state, stamp)
  private connected = false;
  private rxSeq = 0;
  private txSeq = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private rebootUntil = 0;
  private deviceControl = 0;
  private state = new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED], [4, STATE.LOADED]]);
  private base = new Map<number, number>();
  private mem = new Map<number, number>();
  private props = new Map<string, Buffer>();
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(this.device, this.assignedIa, tpdu, false)); }
  private close() { this.connected = false; if (this.idle) clearTimeout(this.idle); this.idle = null; }
  private touchConnection() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idleClosures.push(Date.now()); this.close(); this.send(tpDisconnect()); }, IDLE_CLOSE_MS);
  }
  private answer(apci: number, data: Buffer, low = 0) { this.send(apdu(this.txSeq, apci, data, low)); this.txSeq = (this.txSeq + 1) & 0x0f; }

  async sendCemi(cemi: Buffer): Promise<void> {
    if (cemi.readUInt16BE(6) !== this.device) return;
    if (Date.now() < this.rebootUntil) return;
    const tpdu = cemi.subarray(9);
    if (tpdu[0] === 0x80) {
      if (this.connected) { this.connectsWhileOpen++; this.touchConnection(); return; }
      this.connected = true; this.rxSeq = 0; this.txSeq = 0; this.touchConnection();
      return;
    }
    if (tpdu[0] === 0x81) { this.close(); return; }
    const p = parseApdu(tpdu);
    if (p.control) { if (this.connected) this.touchConnection(); return; }
    if (!this.connected) { this.send(tpDisconnect()); return; }
    this.touchConnection();
    if (p.seq !== this.rxSeq) {
      if (p.seq === ((this.rxSeq - 1) & 0x0f)) this.send(tpAck(p.seq));
      else { this.naks.push(Date.now()); this.send(Buffer.from([0xc3 | (p.seq << 2)])); }
      return;
    }
    this.rxSeq = (this.rxSeq + 1) & 0x0f;
    const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
    if ((apci & 0x3c0) === APCI.RESTART) {
      // It reboots before it acknowledges, and loses the connection with it.
      this.restartAt = Date.now(); this.close(); this.rebootUntil = Date.now() + REBOOT_MS;
      return;
    }
    this.send(tpAck(p.seq));
    const d = p.data;
    if ((apci & 0x3c0) === APCI.MEMORY_WRITE) {
      const n = apci & 0x3f, at = d.readUInt16BE(0);
      for (let i = 0; i < n; i++) this.mem.set(at + i, d[2 + i]);
      this.lastMemoryTouch = Date.now();
      if (this.deviceControl & VERIFY_MODE) this.answer(APCI.MEMORY_RESPONSE, Buffer.from(d.subarray(0, 2 + n)), n);
      return;
    }
    if ((apci & 0x3c0) === APCI.MEMORY_READ) {
      const n = apci & 0x3f, at = d.readUInt16BE(0);
      this.answer(APCI.MEMORY_RESPONSE, Buffer.concat([d.subarray(0, 2), Buffer.from(Array.from({ length: n }, (_, i) => this.mem.get(at + i) ?? 0))]), n);
      return;
    }
    if (apci === APCI.DEVICE_DESCRIPTOR_READ) return this.answer(APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0xb0]));
    const [obj, pid] = d;
    const head = d.subarray(0, 4);
    if (apci === APCI.PROPERTY_READ) {
      const value = this.read(obj, pid);
      // A property it does not hold: element count 0.
      return this.answer(APCI.PROPERTY_RESPONSE, value ? Buffer.concat([head, value]) : Buffer.from([obj, pid, d[2] & 0x0f, d[3]]));
    }
    if (apci === APCI.PROPERTY_WRITE) {
      const value = d.subarray(4);
      if (obj === 0 && pid === PID.DEVICE_CONTROL) this.deviceControl = value[0];
      else if (pid === PID.LOAD_STATE_CONTROL) {
        this.lastMemoryTouch = Date.now();
        if (value[0] === 1) this.state.set(obj, STATE.LOADING);
        else if (value[0] === 2) this.state.set(obj, STATE.LOADED);
        else if (value[0] === 4) { this.state.set(obj, STATE.UNLOADED); this.base.delete(obj); }
        else if (value[0] === 3 && value[1] === 0x0b) this.base.set(obj, OBJ_BASE[obj]);
        return this.answer(APCI.PROPERTY_RESPONSE, Buffer.concat([head, Buffer.from([this.state.get(obj) ?? STATE.UNLOADED])]));
      } else { this.props.set(`${obj}:${pid}`, Buffer.from(value)); this.lastMemoryTouch = Date.now(); }
      return this.answer(APCI.PROPERTY_RESPONSE, Buffer.concat([head, value]));
    }
  }
  private read(obj: number, pid: number): Buffer | null {
    if (obj === 0 && pid === PID.DEVICE_CONTROL) return Buffer.from([this.deviceControl]);
    if (pid === PID.LOAD_STATE_CONTROL) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]);
    if (pid === PID.TABLE_REFERENCE) { const b = Buffer.alloc(4); b.writeUInt32BE(this.base.get(obj) ?? 0); return b; }
    return this.props.get(`${obj}:${pid}`) ?? null;
  }
}

// Runs `p` to its end on the faked clock: whenever nothing is left to run but timers, the next one fires.
async function onFakeClock<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; !done && i < 100_000; i++) {
    await new Promise((r) => setImmediate(r));
    if (!done && jest.getTimerCount() > 0) jest.advanceTimersToNextTimer();
  }
  return p;
}
afterEach(() => { jest.useRealTimers(); });

const tables = {
  params: Buffer.from(Array.from({ length: 40 }, (_, i) => i + 1)), paramsInImage: new Array<number>(40).fill(0xff),
  comObj: Buffer.from([0, 1, 0x00, 0x00, 0x4f, 0x00]), addr: Buffer.from([0, 1, 0x7f, 0xfa]), assoc: Buffer.from([0, 1, 0, 0]),
  programId: appId(0x00fa, 0xa012, 0x55),
};

test("the download ends without a connection the unit closes for idleness or refuses a frame on, and restarts it on its own connection", async () => {
  jest.useFakeTimers();
  const unit = new ThelsingUnit();
  const dev = new KnxDevice(unit, "1.2.3");
  const plan = planSystemBFullDownload(tables, 0, true, [], undefined, false, false);
  await onFakeClock((async () => {
    await dev.connect();
    await runLoadPlan(dev, plan);
  })());
  expect(unit.idleClosures).toEqual([]);
  expect(unit.naks).toEqual([]);
  expect(unit.connectsWhileOpen).toBe(0);
  expect(unit.restartAt).not.toBeNull();
  // The save timer (5 s after the last write) has run out before the restart.
  expect(unit.restartAt! - unit.lastMemoryTouch).toBeGreaterThan(5_000);
});
