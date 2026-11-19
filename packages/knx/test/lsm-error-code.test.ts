import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { runLoadPlan } from "../src/loadrunner.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// A load-state machine (object 4) that goes to ERROR on LOAD, answering on the wire as a device with
// a connection-oriented transport layer does. `errorCode`: what its PID_ERROR_CODE (28) holds, `null`
// for a device without that property (it answers with no element), `"refused"` for one that answers
// with no element and an error octet behind it, `"silent"` for one that never answers the read. Every request it takes is kept as its TPDU with the sequence number masked out.
class ErroredLsmDevice implements KnxTransport {
  assignedIa = 0x12fa; // 1.2.250
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly sent: string[] = [];
  private txSeq = 0;
  constructor(private readonly errorCode: number | null | "refused" | "silent") {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(0x1204, this.assignedIa, tpdu, false)); }
  private answer(body: Buffer) { this.send(apdu(this.txSeq, APCI.PROPERTY_RESPONSE, body)); this.txSeq = (this.txSeq + 1) & 0x0f; }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) return; // T_Connect / T_Disconnect
    const tpdu = cemi.subarray(9);
    const p = parseApdu(tpdu);
    if (p.control) return;
    const masked = Buffer.from(tpdu); masked[0] &= 0x03;
    this.sent.push(masked.toString("hex"));
    this.send(tpAck(p.seq));
    const [obj, pid] = p.data;
    if (p.apci === APCI.PROPERTY_WRITE) { this.answer(Buffer.from(p.data)); return; }
    if (p.apci !== APCI.PROPERTY_READ) return;
    if (pid === 5) { this.answer(Buffer.from([obj, pid, 0x10, 0x01, 0x03])); return; } // state ERROR
    if (this.errorCode === "silent") return;
    if (this.errorCode === null) { this.answer(Buffer.from([obj, pid, 0x00, 0x01])); return; }
    if (this.errorCode === "refused") { this.answer(Buffer.from([obj, pid, 0x00, 0x01, 0x07])); return; }
    this.answer(Buffer.from([obj, pid, 0x10, 0x01, this.errorCode]));
  }
}

const timeouts = { ackMs: 30, responseMs: 40, retryGapMs: 5 };
const LOAD = "03d70405100101" + "00".repeat(9);
const READ_STATE = "03d5040510" + "01";
const READ_ERROR_CODE = "03d5041c1001";

async function refusal(code: number | null | "refused" | "silent") {
  const tun = new ErroredLsmDevice(code);
  const dev = new KnxDevice(tun, "1.2.4", undefined, timeouts);
  const err = await runLoadPlan(dev, [{ op: "connect" }, { op: "load", lsm: 4 }]).then(() => null, (e: { code?: string; message?: string }) => e);
  await dev.disconnect();
  return { err, sent: tun.sent };
}

describe("a load-state machine that went to ERROR", () => {
  test("is asked once for its error code, and the refusal names it", async () => {
    const { err, sent } = await refusal(13);
    expect(sent).toEqual([LOAD, READ_STATE, READ_ERROR_CODE]);
    expect(err?.code).toBe("LOAD_STATE_UNEXPECTED");
    expect(err?.message).toBe("LSM 4 not LOADING after LOAD (got ERROR); its error code (PID 28) is 13, maximal table length exceeded");
  });

  test("a value DPT 20.011 does not define is named as such", async () => {
    const { err } = await refusal(0x42);
    expect(err?.message).toEndWith("its error code (PID 28) is 66, a value DPT 20.011 does not define");
  });

  test("a device without the property is still refused, and says it gives no code", async () => {
    const { err, sent } = await refusal(null);
    expect(sent).toEqual([LOAD, READ_STATE, READ_ERROR_CODE]);
    expect(err?.code).toBe("LOAD_STATE_UNEXPECTED");
    expect(err?.message).toEndWith("(got ERROR); the device gives no error code for it (PID 28)");
  });

  test("an octet behind an answer with no element is not taken for an error code", async () => {
    const { err } = await refusal("refused");
    expect(err?.message).toEndWith("(got ERROR); the device gives no error code for it (PID 28)");
  });

  test("a device that does not answer the read is still refused with the load state's code", async () => {
    const { err, sent } = await refusal("silent");
    expect(sent.slice(0, 3)).toEqual([LOAD, READ_STATE, READ_ERROR_CODE]);
    expect(err?.code).toBe("LOAD_STATE_UNEXPECTED");
    expect(err?.message).toMatch(/^LSM 4 not LOADING after LOAD \(got ERROR\); its error code \(PID 28\) could not be read: /);
  });
});

// A device stub whose load-state machines answer `state` to every state read, recording each read.
function stateStub(state: number) {
  const reads: string[] = [];
  const dev = {
    async propWrite(_obj: number, _pid: number, data: Buffer) { return Buffer.from(data); },
    async propRead(obj: number, pid: number) { reads.push(`prop ${obj}/${pid}`); return Buffer.from([state]); },
    async memWrite() {},
    async memRead(addr: number) { reads.push(`mem ${addr}`); return Buffer.from([state]); },
  };
  return { dev: dev as unknown as KnxDevice, reads };
}

describe("the error code is not asked", () => {
  test("of a load-state machine in another state than ERROR", async () => {
    const { dev, reads } = stateStub(1); // LOADED
    const err = await runLoadPlan(dev, [{ op: "load", lsm: 4 }]).then(() => null, (e: { message?: string }) => e);
    expect(err?.message).toBe("LSM 4 not LOADING after LOAD (got LOADED)");
    expect(reads).toEqual(["prop 4/5"]);
  });

  test("of a memory-mapped load-state machine, which has no such property", async () => {
    const { dev, reads } = stateStub(3); // ERROR
    const err = await runLoadPlan(dev, [{ op: "load", lsm: 3 }], { memMappedLsms: true }).then(() => null, (e: { message?: string }) => e);
    expect(err?.message).toBe("LSM 3 not LOADING after LOAD (got ERROR)");
    expect(reads).toEqual(["mem 46828"]);
  });
});
