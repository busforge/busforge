import { test, expect, describe } from "bun:test";
import { KnxDevice, elementRuns, transferChunks } from "../src/device.ts";
import { planSecurityObjectLoad, securityUnload, planSystemBFullDownload, planSystemBGaFlash } from "../src/flash.ts";
import { runLoadPlan } from "../src/loadrunner.ts";
import { parseApdu, tpAck, type KnxTransport } from "../src/index.ts";

// Reference: ETS 6.4.1's secured download of the bench Jung 400021SE (2026-09-28), decrypted. Its
// security-object bracket is LOAD, PID 54 element 0 = 0000, PID 53 element 1 = address-table index
// 0001 (0/0/1 is the first address) + key, PID 61 from element 1 in runs of 18 (1327 objects, only object 253 flagged 03), LOAD_COMPLETED.
// The key here is a dummy; the framing around it is ETS's.
const KEY = "00112233445566778899aabbccddeeff";
const FLAGS = Buffer.alloc(1327); FLAGS[252] = 0x03;
const ETS = {
  load: "01d4001100100501000000000000000000",
  clearIaTable: "01ce00110010360100000000",
  groupKey: "01ce00110010350100010001" + KEY,
  complete: "01d4001100100502000000000000000000",
  unload: "01d4001100100504000000000000000000",
  // ETS 6.4.1, 2026-09-29, after 1.1.100 (a router's tunnelling channel) was assigned to 0/0/1.
  sender1164: "01ce00110010360100011164000000000000",
};

// A security object that answers each extended service the way the Jung does: a write-con with
// success, a load event with the state it leads to.
class SecurityObjectDevice implements KnxTransport {
  assignedIa = 0x1164;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly sent: string[] = [];
  constructor(private readonly stateAfter: Record<number, number> = { 1: 2, 2: 1, 4: 0 }) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    const p = parseApdu(tpdu);
    if (p.control) return;
    const svc = Buffer.from(tpdu); svc[0] &= 0x03;
    const hex = svc.toString("hex");
    this.sent.push(hex);
    this.onCemi?.(0x11cc, this.assignedIa, tpAck(p.seq), false);
    const head = hex.slice(4, 14);
    const answer = hex.startsWith("01ce") ? "01cf" + head + hex.slice(14, 20) + "00"
      : "01d6" + head + "00" + this.stateAfter[svc[7]].toString(16).padStart(2, "0");
    const a = Buffer.from(answer, "hex");
    a[0] = 0x40 | (p.seq << 2) | (a[0] & 0x03);
    this.onCemi?.(0x11cc, this.assignedIa, a, false);
  }
}

describe("the security object load, against ETS's secured download", () => {
  test("the per-object flags split into ETS's 74 writes at the Jung's secured element budget", () => {
    const runs = elementRuns(1, 1, FLAGS, transferChunks(233, true).propWrite);
    expect(runs).toHaveLength(74);
    expect(runs.slice(0, 73).every((r, i) => r.start === 1 + 18 * i && r.count === 18)).toBe(true);
    expect(runs[73]).toMatchObject({ start: 1315, count: 13 });
    expect(runs.find((r) => r.bytes.includes(0x03))).toMatchObject({ start: 253 });
  });

  test("a group key entry does not fit a budget below one element, and is refused", () => {
    expect(() => elementRuns(1, 18, Buffer.alloc(18), 17)).toThrow(/does not fit/);
    expect(() => elementRuns(1, 18, Buffer.alloc(17), 18)).toThrow(/whole elements/);
  });

  test("the bracket sends ETS's events and table writes, and the flags land element for element", async () => {
    const tun = new SecurityObjectDevice();
    const dev = new KnxDevice(tun, "1.1.204");
    await runLoadPlan(dev, [securityUnload, ...planSecurityObjectLoad({ groupKeys: Buffer.from("0001" + KEY, "hex"), goFlags: FLAGS, senders: Buffer.alloc(0) })]);
    const s = tun.sent;
    expect(s.slice(0, 4)).toEqual([ETS.unload, ETS.load, ETS.clearIaTable, ETS.groupKey]);
    expect(s[s.length - 1]).toBe(ETS.complete);
    // The flag writes, reassembled by their start element, are exactly the 1327 bytes ETS wrote.
    const got = Buffer.alloc(1327);
    for (const h of s.slice(4, -1)) {
      const b = Buffer.from(h, "hex");
      expect(b.subarray(0, 7).toString("hex")).toBe("01ce001100103d");
      b.subarray(10).copy(got, b.readUInt16BE(8) - 1);
      expect(b.subarray(10).length).toBe(b[7]);
    }
    expect(got.equals(FLAGS)).toBe(true);
  });

  test("a listed sender is written after the table is cleared, frame for frame as ETS does it", async () => {
    const tun = new SecurityObjectDevice();
    await runLoadPlan(new KnxDevice(tun, "1.1.204"), planSecurityObjectLoad({ groupKeys: Buffer.from("0001" + KEY, "hex"), goFlags: FLAGS, senders: Buffer.from("1164000000000000", "hex") }));
    expect(tun.sent.slice(0, 4)).toEqual([ETS.load, ETS.clearIaTable, ETS.sender1164, ETS.groupKey]);
  });

  test("sender entries split at whole 8-byte elements within the secured budget", () => {
    const runs = elementRuns(1, 8, Buffer.alloc(8 * 5), transferChunks(233, true).propWrite);
    expect(runs.map((r) => r.count)).toEqual([2, 2, 1]);
  });

  test("a load event that does not reach its state stops the bracket", async () => {
    const tun = new SecurityObjectDevice({ 1: 3, 2: 1, 4: 0 }); // LOAD leaves the object in ERROR
    const err = await runLoadPlan(new KnxDevice(tun, "1.1.204"), planSecurityObjectLoad({ groupKeys: Buffer.alloc(0), goFlags: FLAGS, senders: Buffer.alloc(0) })).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("LOAD_STATE_UNEXPECTED");
    expect(tun.sent).toEqual([ETS.load]);
  });
});

describe("where the security object sits in a System B plan", () => {
  const sec = { groupKeys: Buffer.from("0001" + KEY, "hex"), goFlags: FLAGS, senders: Buffer.alloc(0) };
  const ops = (plan: { op: string; event?: number; lsm?: number }[]) => plan.map((st) => st.op === "securityLsm" ? `sec${st.event}` : st.lsm !== undefined ? `${st.op}${st.lsm}` : st.op);

  test("full download: unloaded with the other objects, loaded after every memory write and before the app id stamp", () => {
    const tables = { params: Buffer.alloc(24, 1), paramsInImage: new Array<number>(24).fill(0xff), comObj: Buffer.alloc(4), addr: Buffer.alloc(4), assoc: Buffer.alloc(2), programId: Buffer.alloc(5) };
    const plain = ops(planSystemBFullDownload(tables));
    const secured = ops(planSystemBFullDownload(tables, 0, true, [], sec));
    expect(secured.indexOf("sec4")).toBe(plain.indexOf("unload1") + 1);
    const lastWrite = secured.lastIndexOf("writeSegment4");
    expect(secured.slice(lastWrite + 1, lastWrite + 3)).toEqual(["sec1", "writeSecurityProp"]);
    expect(secured[secured.indexOf("stampAppId4") - 1]).toBe("sec2");
    // Without security the plan is the plain one, step for step.
    expect(secured.filter((o) => !o.startsWith("sec") && o !== "writeSecurityProp")).toEqual(plain);
  });

  test("group-address flash: reloaded in the same bracket, before the tables complete", () => {
    const tables = { addr: Buffer.alloc(4), assoc: Buffer.alloc(2), comObj: Buffer.alloc(4) };
    const plain = ops(planSystemBGaFlash(tables, true, true));
    const secured = ops(planSystemBGaFlash(tables, true, true, sec));
    expect(secured.indexOf("sec4")).toBe(plain.indexOf("unload1") + 1);
    expect(secured[secured.indexOf("loadCompleted3") - 1]).toBe("sec2");
    expect(secured.filter((o) => !o.startsWith("sec") && o !== "writeSecurityProp")).toEqual(plain);
  });
});
