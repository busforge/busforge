import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { KnxIpTunnel, type TcpSocket } from "../src/connection.ts";
import { KnxDevice, type DeviceTimeouts } from "../src/device.ts";
import { runLoadPlan } from "../src/loadrunner.ts";
import { LSM, STATE } from "../src/flash.ts";
import { KnxError } from "../src/errors.ts";
import { SVC, CEMI, APCI, knxFrame, hpai, iaToNum, cemiLData, parseApdu, apdu, tpAck, tpDisconnect } from "../src/frame.ts";
import { parseCemiLData, type KnxTransport } from "../src/transport.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 2.3 s with the
// file alone (load 5-27) and up to 2.3 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(60_000);

// A TCP link to the KNX interface that stalls in both directions for 2, 5, 8 and 15 s, at each phase of
// an operation: a read, a write, the load bracket, the restart. Behind the link a scripted interface
// confirms every frame it puts on the bus and answers connection-state requests; on the bus a device
// runs the connection-oriented transport layer as thelsing/OpenKNX transport_layer.cpp does: it closes
// a connection that carried nothing for 6 s, repeats an unacknowledged frame of its own three times
// 3 s apart and then closes, answers a numbered frame on a closed connection with T_Disconnect and
// passes nothing on, acknowledges a repetition without passing it on. A stall holds every frame in
// both directions and lets them through at its end in order, the ones towards Busforge in one chunk
// (the worst case for telling their order). Every time is scaled: one second is SEC milliseconds.
const SEC = 50;
const CLIENT = iaToNum("1.2.250");
const UNIT = iaToNum("1.2.4");
const CHANNEL = 7;

const TIMEOUTS: DeviceTimeouts = {
  ackMs: 1.5 * SEC, responseMs: 2 * SEC, retryGapMs: 0.2 * SEC, syncResponseMs: 3 * SEC, restartAnswerMs: 2 * SEC,
  restartProofMs: 4 * SEC, droppedRepeatMs: 12 * SEC, staleConnectionMs: 12 * SEC, reconnectGapMs: 2.3 * SEC, confirmLateMs: 3 * SEC,
};

// The device's transport layer and enough application layer for memory, the load-state machines and
// A_Restart. `executed` lists every request its application carried out.
class TpUnit {
  state: "closed" | "idle" | "wait" = "closed";
  private partner = 0;
  private seqRecv = 0;
  private seqSend = 0;
  private saved: Buffer | null = null;
  private reps = 0;
  private queued: Buffer[] = [];
  private connTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  readonly memory = Buffer.alloc(0x10000);
  readonly lsm = new Map<number, number>();
  readonly executed: string[] = [];
  restarts = 0;
  // Close the connection with T_Disconnect as it takes A_Restart, which a device may do before it
  // reboots (Calimero ManagementClientImpl.restart: "a remote endpoint is allowed to not send a TL
  // disconnect before restart").
  disconnectOnRestart = false;
  // Acknowledge A_Restart and carry on without rebooting.
  ignoreRestart = false;
  // Pass over a numbered frame on a closed connection without a T_Disconnect, as a Theben Meteodata 140 S does.
  silentWhenClosed = false;
  constructor(private readonly toBus: (dst: number, tpdu: Buffer) => void) {
    for (let i = 0; i < this.memory.length; i++) this.memory[i] = (i * 7 + 3) & 0xff;
  }

  private close(): void { this.state = "closed"; this.partner = 0; clearTimeout(this.connTimer); clearTimeout(this.ackTimer); this.queued = []; }
  private armConnection(): void {
    clearTimeout(this.connTimer);
    this.connTimer = setTimeout(() => { const p = this.partner; this.close(); this.toBus(p, tpDisconnect()); }, 6 * SEC);
  }
  private sendData(frame: Buffer): void {
    if (this.state === "wait") { this.queued.push(frame); return; }
    const t = Buffer.from(frame); t[0] = (t[0]! & 0xc3) | (this.seqSend << 2);
    this.saved = t; this.reps = 0; this.state = "wait";
    this.toBus(this.partner, t);
    this.armAck();
  }
  private armAck(): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      if (this.reps < 3) { this.reps++; this.toBus(this.partner, this.saved!); this.armAck(); return; }
      const p = this.partner; this.close(); this.toBus(p, tpDisconnect());
    }, 3 * SEC);
  }

  receive(src: number, tpdu: Buffer): void {
    const t = tpdu[0]!;
    if ((t & 0xc0) === 0x80) { // T_Connect / T_Disconnect
      if ((t & 0x03) === 0x00) {
        if (this.state === "closed") { this.state = "idle"; this.partner = src; this.seqRecv = 0; this.seqSend = 0; this.armConnection(); }
        else if (src !== this.partner) this.toBus(src, tpDisconnect());
      } else if (src === this.partner) this.close();
      return;
    }
    if (this.state === "closed" && this.silentWhenClosed) return;
    if (this.state === "closed" || src !== this.partner) { this.toBus(src, tpDisconnect()); return; }
    this.armConnection();
    const seq = (t >> 2) & 0x0f;
    if ((t & 0xc0) === 0xc0) { // T_ACK / T_NAK
      if ((t & 0x03) === 0x02 && this.state === "wait" && seq === this.seqSend) {
        clearTimeout(this.ackTimer); this.seqSend = (this.seqSend + 1) & 0x0f; this.state = "idle";
        const next = this.queued.shift(); if (next) this.sendData(next);
      }
      return;
    }
    if (seq === ((this.seqRecv - 1) & 0x0f)) { this.toBus(src, tpAck(seq)); return; }
    if (seq !== this.seqRecv) { this.toBus(src, Buffer.from([0xc3 | (seq << 2)])); return; }
    const p = parseApdu(tpdu);
    if ((p.apci & 0x3c0) === APCI.RESTART && this.ignoreRestart) {
      this.toBus(src, tpAck(seq)); this.seqRecv = (this.seqRecv + 1) & 0x0f; this.executed.push("restart ignored"); return;
    }
    if ((p.apci & 0x3c0) === APCI.RESTART) {
      this.restarts++; this.executed.push("restart");
      if (this.disconnectOnRestart) this.toBus(src, tpDisconnect());
      this.close(); return;
    }
    this.toBus(src, tpAck(seq));
    this.seqRecv = (this.seqRecv + 1) & 0x0f;
    const answer = this.execute(p.apci, p.data);
    if (answer) this.sendData(answer);
  }

  private execute(apci: number, d: Buffer): Buffer | null {
    const service = apci & 0x3c0;
    if (service === APCI.DEVICE_DESCRIPTOR_READ) { this.executed.push("descriptor"); return apdu(0, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0xb0])); }
    if (service === APCI.MEMORY_READ) {
      const n = apci & 0x3f, a = d.readUInt16BE(0);
      this.executed.push(`read ${a.toString(16)}`);
      return apdu(0, APCI.MEMORY_RESPONSE, Buffer.concat([d.subarray(0, 2), this.memory.subarray(a, a + n)]), n);
    }
    if (service === APCI.MEMORY_WRITE) {
      const n = apci & 0x3f, a = d.readUInt16BE(0);
      this.executed.push(`write ${a.toString(16)}`);
      d.copy(this.memory, a, 2, 2 + n);
      return null;
    }
    if (apci === APCI.PROPERTY_READ) {
      const [obj, pid] = [d[0]!, d[1]!];
      if (pid === 5) return apdu(0, APCI.PROPERTY_RESPONSE, Buffer.from([obj, pid, 0x10, 0x01, this.lsm.get(obj) ?? STATE.UNLOADED]));
      return apdu(0, APCI.PROPERTY_RESPONSE, Buffer.from([obj, pid, 0x00, 0x01]));
    }
    if (apci === APCI.PROPERTY_WRITE && d[1] === 5) {
      const obj = d[0]!, event = d[4]!, now = this.lsm.get(obj) ?? STATE.UNLOADED;
      this.executed.push(`lsm ${obj} event ${event}`);
      const next = event === LSM.LOAD ? STATE.LOADING : event === LSM.UNLOAD ? STATE.UNLOADED
        : event === LSM.LOAD_COMPLETED ? (now === STATE.LOADING ? STATE.LOADED : STATE.ERROR) : STATE.ERROR;
      this.lsm.set(obj, next);
      return apdu(0, APCI.PROPERTY_RESPONSE, Buffer.from([obj, 5, 0x10, 0x01, next]));
    }
    throw new Error(`the scripted unit has no answer for service 0x${apci.toString(16)}`);
  }
}

const tpduOfReq = (frame: Buffer): Buffer | null =>
  frame.readUInt16BE(2) === SVC.TUNNEL_REQ ? parseCemiLData(frame.subarray(10)).tpdu : null;

// The interface behind the link, the link itself (TcpSocket seen from Busforge) and the unit on its bus.
class StallingLink implements TcpSocket {
  readonly unit: TpUnit;
  private dataCb: ((c: Buffer) => void) | null = null;
  private upHeld: Buffer[] | null = null;
  private downHeld: Buffer[] | null = null;
  private stallAt: ((frame: Buffer) => boolean) | null = null;
  private stallMs = 0;
  stalls = 0;
  // Only the direction towards the interface stalls; and how late the interface answers a
  // connection-state request.
  upOnly = false;
  stateLatencyMs = 0;
  // Every TPDU Busforge put on the link.
  readonly written: Buffer[] = [];
  // Frames the interface confirms negatively: a unit that reboots at once on A_Restart sends no
  // layer-2 acknowledgement for it.
  negativeCon: (tpdu: Buffer) => boolean = () => false;
  // How long the interface's confirmation of a frame takes to come back, the frame itself on the bus at once.
  conDelayMs: (tpdu: Buffer) => number = () => 0;
  constructor() {
    this.unit = new TpUnit((dst, tpdu) => {
      const ind = cemiLData(UNIT, dst, tpdu); ind[0] = CEMI.LDATA_IND;
      this.toClient(knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, CHANNEL, 0, 0]), ind])));
    });
  }
  // A stall of `ms` that starts when Busforge writes the first frame `at` matches, that frame held in it.
  stallWhen(ms: number, at: (frame: Buffer) => boolean): void { this.stallMs = ms; this.stallAt = at; }
  // A stall of `ms` that starts when the interface sends Busforge the first frame `at` matches, that frame held in it.
  stallWhenDown(ms: number, at: (frame: Buffer) => boolean): void { this.stallMs = ms; this.stallDownAt = at; }
  private stallDownAt: ((frame: Buffer) => boolean) | null = null;

  connect(_port: number, _ip: string, onConnect: () => void): void { onConnect(); }
  onData(cb: (c: Buffer) => void): void { this.dataCb = cb; }
  onClose(): void {}
  end(): void {}
  write(frame: Buffer): void {
    const t = tpduOfReq(frame);
    if (t) this.written.push(Buffer.from(t));
    if (this.stallAt?.(frame)) { this.stallAt = null; this.stall(); }
    if (this.upHeld) { this.upHeld.push(Buffer.from(frame)); return; }
    const f = Buffer.from(frame);
    setTimeout(() => this.fromClient(f), 0);
  }
  private stall(): void {
    this.stalls++;
    this.upHeld = []; this.downHeld = this.upOnly ? null : [];
    setTimeout(() => {
      const up = this.upHeld!; this.upHeld = null;
      for (const f of up) this.fromClient(f);
      const down = this.downHeld; this.downHeld = null;
      if (down && down.length > 0) this.dataCb?.(Buffer.concat(down));
    }, this.stallMs);
  }
  private toClient(frame: Buffer): void {
    if (this.stallDownAt?.(frame)) { this.stallDownAt = null; this.stall(); }
    if (this.downHeld) { this.downHeld.push(frame); return; }
    setTimeout(() => this.dataCb?.(frame), 0);
  }
  private fromClient(frame: Buffer): void {
    const svc = frame.readUInt16BE(2);
    if (svc === SVC.CONNECT_REQ) {
      this.toClient(knxFrame(SVC.CONNECT_RES, Buffer.concat([Buffer.from([CHANNEL, 0]), hpai("0.0.0.0", 0), Buffer.from([0x04, 0x04, CLIENT >> 8, CLIENT & 0xff])])));
    } else if (svc === SVC.CONNECTIONSTATE_REQ) {
      const res = knxFrame(SVC.CONNECTIONSTATE_RES, Buffer.from([CHANNEL, 0]));
      if (this.stateLatencyMs > 0) setTimeout(() => this.toClient(res), this.stateLatencyMs);
      else this.toClient(res);
    } else if (svc === SVC.DISCONNECT_REQ) {
      this.toClient(knxFrame(SVC.DISCONNECT_RES, Buffer.from([CHANNEL, 0])));
    } else if (svc === SVC.TUNNEL_REQ) {
      const cemi = frame.subarray(10);
      const { src, dst, tpdu } = parseCemiLData(cemi);
      const con = Buffer.from(cemi); con[0] = CEMI.LDATA_CON;
      if (this.negativeCon(tpdu)) con[2] |= 0x01;
      const conFrame = knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, CHANNEL, 0, 0]), con]));
      const delay = this.conDelayMs(tpdu);
      if (delay > 0) setTimeout(() => this.toClient(conFrame), delay); else this.toClient(conFrame);
      if (dst === UNIT) this.unit.receive(src, tpdu);
    }
  }
}

async function open(): Promise<{ link: StallingLink; tun: KnxIpTunnel; dev: KnxDevice }> {
  const link = new StallingLink();
  const tun = KnxIpTunnel.tcp("192.0.2.1", 3671, () => link);
  tun["conTimeoutMs"] = 3 * SEC;
  tun["stateTimeoutMs"] = 10 * SEC;
  tun["searchTimeoutMs"] = 0.2 * SEC;
  await tun.connect();
  const dev = new KnxDevice(tun, "1.2.4", undefined, TIMEOUTS);
  return { link, tun, dev };
}

// The nth frame of ours whose TPDU matches.
function nth(n: number, match: (tpdu: Buffer) => boolean): (frame: Buffer) => boolean {
  let seen = 0;
  return (frame) => { const t = tpduOfReq(frame); return t !== null && match(t) && ++seen === n; };
}
const numbered = (t: Buffer) => (t[0]! & 0xc0) === 0x40;
const service = (t: Buffer) => ((t[0]! & 0x03) << 8) | (t[1] ?? 0);
const isMemRead = (t: Buffer) => numbered(t) && (service(t) & 0x3c0) === APCI.MEMORY_READ;
const isMemWrite = (t: Buffer) => numbered(t) && (service(t) & 0x3c0) === APCI.MEMORY_WRITE;
const isLoadCompleted = (t: Buffer) => numbered(t) && service(t) === APCI.PROPERTY_WRITE && t[3] === 5 && t[6] === LSM.LOAD_COMPLETED;
const isRestart = (t: Buffer) => numbered(t) && (service(t) & 0x3c0) === APCI.RESTART;

const STALLS = [2, 5, 8, 15];

describe("a stalled link to the interface", () => {
  for (const s of STALLS) {
    test(`a read survives a ${s} s stall and returns the device's bytes`, async () => {
      const { link, tun, dev } = await open();
      link.stallWhen(s * SEC, nth(3, isMemRead));
      await dev.connect();
      const got = await dev.memRead(0x4000, 60, 12);
      expect(link.stalls).toBe(1);
      expect(got.equals(link.unit.memory.subarray(0x4000, 0x4000 + 60))).toBe(true);
      await dev.disconnect(); await tun.disconnect();
    }, 60_000);

    test(`a write survives a ${s} s stall, each chunk written once where the device took it`, async () => {
      const { link, tun, dev } = await open();
      const data = Buffer.from(Array.from({ length: 48 }, (_, i) => 0xa0 ^ i));
      link.stallWhen(s * SEC, nth(2, isMemWrite));
      await dev.connect();
      await dev.memWrite(0x4100, data, { chunk: 12, verify: true });
      expect(link.stalls).toBe(1);
      expect(link.unit.memory.subarray(0x4100, 0x4100 + 48).equals(data)).toBe(true);
      expect(link.unit.executed.filter((e) => e.startsWith("write")).length).toBe(4);
      await dev.disconnect(); await tun.disconnect();
    }, 60_000);

    test(`the load bracket survives a ${s} s stall at LoadCompleted, which the device carries out once`, async () => {
      const { link, tun, dev } = await open();
      const data = Buffer.from(Array.from({ length: 24 }, (_, i) => 0x55 ^ i));
      link.stallWhen(s * SEC, nth(1, isLoadCompleted));
      dev.setExtendedMemoryServices(false);
      await runLoadPlan(dev, [
        { op: "connect" }, { op: "load", lsm: 4 }, { op: "writeMem", address: 0x4200, bytes: data }, { op: "loadCompleted", lsm: 4 },
      ]);
      expect(link.stalls).toBe(1);
      expect(link.unit.lsm.get(4)).toBe(STATE.LOADED);
      expect(link.unit.executed.filter((e) => e.startsWith("lsm"))).toEqual([`lsm 4 event ${LSM.LOAD}`, `lsm 4 event ${LSM.LOAD_COMPLETED}`]);
      await dev.disconnect(); await tun.disconnect();
    }, 60_000);

    test(`a restart survives a ${s} s stall, the device restarts once and the reboot is proven`, async () => {
      const { link, tun, dev } = await open();
      link.stallWhen(s * SEC, nth(1, isRestart));
      await dev.connect();
      await dev.restart(true);
      expect(link.stalls).toBe(1);
      expect(link.unit.restarts).toBe(1);
      await tun.disconnect();
    }, 60_000);
  }

  test("a device that closes the connection as it takes A_Restart, behind its confirmation in one burst after a 2 s stall, restarts once and is proven", async () => {
    const { link, tun, dev } = await open();
    link.unit.disconnectOnRestart = true;
    link.stallWhen(2 * SEC, nth(1, isRestart));
    await dev.connect();
    await dev.restart(true);
    expect(link.stalls).toBe(1);
    expect(link.unit.restarts).toBe(1);
    await tun.disconnect();
  }, 60_000);

  test("a device that closes the connection as it takes A_Restart, after a 5 s stall that made the restart's confirmation late, restarts once but is not taken as proven", async () => {
    const { link, tun, dev } = await open();
    link.unit.disconnectOnRestart = true;
    link.stallWhen(5 * SEC, nth(1, isRestart));
    await dev.connect();
    expect((await dev.restart(true).catch((e: KnxError) => e) as KnxError).code).toBe("RESTART_UNPROVEN");
    expect(link.unit.restarts).toBe(1);
    await tun.disconnect();
  }, 60_000);

  for (const s of [8, 15]) {
    test(`a device that ignores A_Restart and closes the idle connection during a ${s} s stall at the probe is not taken as rebooted`, async () => {
      const { link, tun, dev } = await open();
      link.unit.ignoreRestart = true;
      link.stallWhen(s * SEC, nth(1, (t) => numbered(t) && (service(t) & 0x3c0) === APCI.DEVICE_DESCRIPTOR_READ));
      await dev.connect();
      expect((await dev.restart(true).catch((e: KnxError) => e) as KnxError).code).toBe("RESTART_UNPROVEN");
      expect(link.unit.restarts).toBe(0);
      await tun.disconnect();
    }, 60_000);
  }

  for (const s of [8, 15]) {
    test(`a restart the interface confirms negatively, sent again after a ${s} s stall, is proven by the device closing the probe's connection`, async () => {
      const { link, tun, dev } = await open();
      link.negativeCon = isRestart;
      link.stallWhen(s * SEC, nth(1, isRestart));
      await dev.connect();
      await dev.restart(true);
      expect(link.unit.restarts).toBe(1);
      expect(link.written.filter(isRestart).length).toBe(2);
      await tun.disconnect();
    }, 60_000);
  }

  const isDescriptorRead = (t: Buffer) => numbered(t) && (service(t) & 0x3c0) === APCI.DEVICE_DESCRIPTOR_READ;
  for (const s of [5, 8]) {
    test(`a device that acknowledges a confirmed restart, leaves it unanswered and ignores it is not taken as rebooted through a ${s} s outbound stall at the probe`, async () => {
      const { link, tun, dev } = await open();
      link.unit.ignoreRestart = true;
      link.upOnly = true;
      link.stallWhen(s * SEC, nth(1, isDescriptorRead));
      await dev.connect();
      const e = await dev.restart(true, true).then(() => null, (x: KnxError) => x);
      expect(["RESTART_UNPROVEN", "RESTART_IGNORED"]).toContain(e?.code ?? "resolved");
      expect(link.unit.restarts).toBe(0);
      await tun.disconnect();
    }, 60_000);
  }

  test("a device that ignores a plain restart whose confirmation came 2.5 s late is not taken as rebooted through a 5 s outbound stall at the probe", async () => {
    const { link, tun, dev } = await open();
    link.unit.ignoreRestart = true;
    link.conDelayMs = (t) => (isRestart(t) ? 2.5 * SEC : 0);
    link.upOnly = true;
    link.stallWhen(5 * SEC, nth(1, isDescriptorRead));
    await dev.connect();
    const e = await dev.restart(true).then(() => null, (x: KnxError) => x);
    expect(["RESTART_UNPROVEN", "RESTART_IGNORED"]).toContain(e?.code ?? "resolved");
    expect(link.unit.restarts).toBe(0);
    await tun.disconnect();
  }, 60_000);

  test("a restart after the device closed an idle connection goes out once, on a new connection", async () => {
    const { link, tun, dev } = await open();
    await dev.connect();
    await new Promise((r) => setTimeout(r, 7 * SEC));
    await dev.restart(true);
    expect(link.unit.restarts).toBe(1);
    expect(link.written.filter(isRestart).length).toBe(1);
    await tun.disconnect();
  }, 60_000);

  test("an answer to a connection-state request written before the frame does not show the interface read the frame", async () => {
    const { link, tun } = await open();
    link.upOnly = true;
    link.stateLatencyMs = 4 * SEC;
    const frame = cemiLData(CLIENT, iaToNum("1.2.9"), apdu(0, APCI.DEVICE_DESCRIPTOR_READ));
    link.stallWhen(8 * SEC, (f) => tpduOfReq(f) !== null);
    void tun["heartbeat"]();
    await tun.sendCemi(frame);
    expect(link.stalls).toBe(1);
    await tun.disconnect();
  }, 60_000);

  test("a read survives a 15 s stall that holds our acknowledgement of an answer, which the device repeats and then closes on", async () => {
    const { link, tun, dev } = await open();
    link.stallWhen(15 * SEC, nth(3, (t) => (t[0]! & 0xc3) === 0xc2));
    await dev.connect();
    const got = await dev.memRead(0x4000, 60, 12);
    expect(link.stalls).toBe(1);
    expect(got.equals(link.unit.memory.subarray(0x4000, 0x4000 + 60))).toBe(true);
    await dev.disconnect(); await tun.disconnect();
  }, 60_000);

  for (const silent of [false, true]) {
    test(`a read survives a 15 s stall that holds the device's answer, its repetition and its closing of the connection, and the next read goes out on a new connection (${silent ? "a device silent on a closed connection" : "a device that answers it with T_Disconnect"})`, async () => {
      const { link, tun, dev } = await open();
      link.unit.silentWhenClosed = silent;
      let answers = 0;
      link.stallWhenDown(15 * SEC, (f) => {
        const t = tpduOfReq(f);
        return f[10] === CEMI.LDATA_IND && t !== null && numbered(t) && (service(t) & 0x3c0) === APCI.MEMORY_RESPONSE && ++answers === 3;
      });
      await dev.connect();
      const got = await dev.memRead(0x4000, 60, 12);
      expect(link.stalls).toBe(1);
      expect(got.equals(link.unit.memory.subarray(0x4000, 0x4000 + 60))).toBe(true);
      expect(link.written.filter((t) => t[0] === 0x80).length).toBe(2);
      expect(link.unit.executed).toEqual(["read 4000", "read 400c", "read 4018", "read 4024", "read 4030"]);
      await dev.disconnect(); await tun.disconnect();
    }, 60_000);
  }

  test("a stall longer than the interface's three unanswered connection-state requests ends the tunnel, and the device is reported neither silent nor written", async () => {
    const { link, dev } = await open();
    const data = Buffer.from(Array.from({ length: 24 }, (_, i) => i));
    link.stallWhen(40 * SEC, nth(1, isMemWrite));
    await dev.connect();
    const t0 = Date.now();
    const e = await dev.memWrite(0x4300, data, { chunk: 12, verify: true }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(KnxError);
    expect((e as KnxError).code).toBe("TUNNEL_CLOSED");
    expect((e as KnxError).message).toMatch(/three connection-state requests/);
    await new Promise((r) => setTimeout(r, 45 * SEC - (Date.now() - t0)));
    expect(link.unit.executed.some((x) => x.startsWith("write"))).toBe(false);
  }, 60_000);
});

// A transport whose frames from the device arrive as their own events, ahead of the send's
// confirmation (`ahead`) or after it (`after`), scripted per numbered frame of ours; it answers a
// T_Connect with `onConnect`. `numbered` lists the numbered frames sent, `connects` the T_Connects.
type Event = "ack" | "disconnect" | { answer: string } | { disconnectIn: number };
class ScriptedLink implements KnxTransport {
  assignedIa = CLIENT;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  numbered: Buffer[] = [];
  connects = 0;
  onConnect: Event[] = [];
  connectReplyMs = 1;
  // Numbered frames the interface confirms negatively.
  negative: (tpdu: Buffer) => boolean = () => false;
  constructor(private readonly script: { ahead?: Event[]; after?: Event[] }[]) {}
  async connect() {}
  async disconnect() {}
  private emit(seq: number, e: Event): void {
    if (typeof e === "object" && "disconnectIn" in e) { setTimeout(() => this.onCemi?.(UNIT, CLIENT, tpDisconnect(), false), e.disconnectIn); return; }
    const tpdu = e === "ack" ? tpAck(seq) : e === "disconnect" ? tpDisconnect() : (() => { const a = Buffer.from(e.answer, "hex"); a[0] = 0x40 | (seq << 2) | (a[0]! & 0x03); return a; })();
    this.onCemi?.(UNIT, CLIENT, tpdu, false);
  }
  sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    if (tpdu[0] === 0x80) { this.connects++; for (const e of this.onConnect) setTimeout(() => this.emit(0, e), this.connectReplyMs); }
    if ((tpdu[0]! & 0xc0) !== 0x40) return new Promise((r) => setTimeout(r, 2));
    this.numbered.push(Buffer.from(tpdu));
    const seq = (tpdu[0]! >> 2) & 0x0f;
    const step = this.script.shift() ?? {};
    for (const e of step.ahead ?? []) setTimeout(() => this.emit(seq, e), 1);
    const neg = this.negative(tpdu);
    return new Promise((r, j) => setTimeout(() => { if (neg) j(new KnxError("BUS_SEND_FAILED", "negative confirmation")); else r(); for (const e of step.after ?? []) setTimeout(() => this.emit(seq, e), 1); }, 3));
  }
}
const SHORT: Partial<DeviceTimeouts> = { ackMs: 20, responseMs: 30, retryGapMs: 1, reconnectGapMs: 5, staleConnectionMs: 40 };
const DESCRIPTOR = { ahead: ["ack" as Event, { answer: "4340" + "07b0" }] };

describe("a connection the device closes, told apart", () => {
  test("a request the device acknowledged before closing is not asked again", async () => {
    const link = new ScriptedLink([DESCRIPTOR, { ahead: ["ack", "disconnect"] }]);
    const dev = new KnxDevice(link, "1.2.4", undefined, SHORT);
    await dev.connect();
    await dev.deviceDescriptor();
    expect((await dev.propRead(0, 56).catch((e: KnxError) => e) as KnxError).code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(link.numbered.length).toBe(2);
    expect(link.connects).toBe(1);
  });

  test("a request sent only once is not asked again on a new connection", async () => {
    const link = new ScriptedLink([DESCRIPTOR, { ahead: ["disconnect"] }]);
    const dev = new KnxDevice(link, "1.2.4", undefined, SHORT);
    await dev.connect();
    await dev.deviceDescriptor();
    const e = await dev["request"]((sq: number) => apdu(sq, APCI.PROPERTY_READ, Buffer.from([0, 56, 0x10, 0x01])), true, 1).catch((x: KnxError) => x);
    expect((e as KnxError).code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(link.connects).toBe(1);
  });

  test("the same request sent with its tries is asked again on a new connection", async () => {
    const link = new ScriptedLink([DESCRIPTOR, { ahead: ["disconnect"] }, { ahead: ["ack", { answer: "43d6" + "00381001" + "00d2" }] }]);
    const dev = new KnxDevice(link, "1.2.4", undefined, SHORT);
    await dev.connect();
    await dev.deviceDescriptor();
    expect((await dev.propRead(0, 56)).toString("hex")).toBe("00d2");
    expect(link.connects).toBe(2);
  });

  test("a T_Disconnect of an earlier connection that lands before the device took a frame of this one does not count for a later request", async () => {
    const link = new ScriptedLink([DESCRIPTOR, { after: ["disconnect"] }]);
    link.onConnect = ["disconnect"];
    const dev = new KnxDevice(link, "1.2.4", undefined, SHORT);
    await dev.connect();
    await new Promise((r) => setTimeout(r, 5));
    await dev.deviceDescriptor();
    expect((await dev.propRead(0, 56).catch((e: KnxError) => e) as KnxError).code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(link.connects).toBe(1);
  });

  test("after a restart sent again, a T_Disconnect ahead of the probe is not taken as the reboot", async () => {
    const link = new ScriptedLink([{ ahead: ["disconnect"] }, {}, { ahead: ["disconnect"] }]);
    const dev = new KnxDevice(link, "1.2.4", undefined, SHORT);
    await dev.connect();
    expect((await dev.restart(true).catch((e: KnxError) => e) as KnxError).code).toBe("RESTART_UNPROVEN");
    expect(link.connects).toBe(2);
  });

  test("after a negatively confirmed restart sent again, a T_Disconnect ahead of a probe is not taken as the reboot", async () => {
    const link = new ScriptedLink([{ ahead: ["disconnect"] }, {}, { ahead: ["disconnect"] }]);
    link.negative = isRestart;
    const dev = new KnxDevice(link, "1.2.4", undefined, { ...SHORT, restartProofMs: 200 });
    await dev.connect();
    expect((await dev.restart(true).catch((e: KnxError) => e) as KnxError).code).toBe("RESTART_UNPROVEN");
    expect(link.connects).toBe(2);
  });

  test("after a negatively confirmed restart sent again, a T_Disconnect between two probes is not taken as the reboot", async () => {
    // The first probe goes unanswered; the T_Disconnect lands in the pause before the next one.
    const link = new ScriptedLink([{ ahead: ["disconnect"] }, {}, { after: [{ disconnectIn: 22 }] }]);
    link.negative = isRestart;
    const dev = new KnxDevice(link, "1.2.4", undefined, { ...SHORT, retryGapMs: 15, restartProofMs: 200 });
    await dev.connect();
    expect((await dev.restart(true).catch((e: KnxError) => e) as KnxError).code).toBe("RESTART_UNPROVEN");
  });

  test("a device that closes every new connection at once, holding another, is tried on two connections and named so", async () => {
    const link = new ScriptedLink([{ after: ["disconnect"] }, { after: ["disconnect"] }]);
    // Its T_Disconnect to our T_Connect arrives while the first request waits for its confirmation.
    link.onConnect = ["disconnect"];
    link.connectReplyMs = 3;
    const dev = new KnxDevice(link, "1.2.4", undefined, SHORT);
    await dev.connect();
    const e = await dev.deviceDescriptor().catch((x: KnxError) => x);
    expect((e as KnxError).message).toMatch(/refused the connection twice/);
    expect(link.connects).toBe(2);
  });
});
