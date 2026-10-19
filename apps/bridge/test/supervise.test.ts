import { test, expect, describe } from "bun:test";
import { KnxError, type KnxTransport } from "@busforge/knx";
import { superviseInterface } from "../src/supervise.ts";

class FakeUsb implements KnxTransport {
  onCemi: KnxTransport["onCemi"] = null;
  onRawCemi: KnxTransport["onRawCemi"] = null;
  onClosed: KnxTransport["onClosed"] = null;
  disconnected = 0;
  constructor(public assignedIa = 0x12fa) {}
  connect(): Promise<void> { return Promise.resolve(); }
  sendCemi(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { this.disconnected++; return Promise.resolve(); }
  /** The stick re-enumerates under the handle. */
  lose(reason: string): void { this.onClosed?.(reason); }
}

function rig(attempts: (() => Promise<KnxTransport>)[]) {
  const events: string[] = [];
  const server = {
    interfaceLost: (r: string) => { events.push(`lost: ${r}`); },
    interfaceRestored: (t: KnxTransport) => {
      if (t.assignedIa === 0) throw new KnxError("BRIDGE_NO_ADDRESS", "did not tell its address yet");
      if (t.assignedIa !== 0x12fa) throw new KnxError("BRIDGE_INTERFACE_CHANGED", "back under another address; restart the bridge");
      events.push("restored");
    },
  };
  const logs: string[] = [];
  // Retries run on an injected timer so the test steps them one by one.
  const pending: (() => void)[] = [];
  const first = new FakeUsb();
  const sup = superviseInterface({
    initial: first,
    server,
    open: () => {
      const next = attempts.shift();
      if (!next) throw new Error("test ran out of attempts");
      return next();
    },
    log: (m) => logs.push(m),
    schedule: (fn) => { pending.push(fn); },
  });
  const step = async () => {
    const fn = pending.shift();
    if (!fn) throw new Error("no retry scheduled");
    fn();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { first, sup, events, logs, pending, step };
}

describe("superviseInterface", () => {
  test("a lost stick is reported to the server, retried until it opens, and then restored", async () => {
    const back = new FakeUsb();
    const r = rig([
      () => Promise.reject(new Error("no attached USB interface matches 147b:5120")),
      () => Promise.reject(new Error("no attached USB interface matches 147b:5120")),
      () => Promise.resolve(back),
    ]);
    r.first.lose("the USB interface refused a write: Cannot write to hid device");
    expect(r.events).toEqual(["lost: the USB interface refused a write: Cannot write to hid device"]);
    expect(r.first.disconnected).toBe(1);

    await r.step();
    await r.step();
    // The same failure twice is logged once, not once per retry.
    expect(r.logs.filter((l) => l.includes("no attached USB interface")).length).toBe(1);
    await r.step();
    expect(r.events.at(-1)).toBe("restored");
    expect(r.sup.current()).toBe(back);
    expect(r.pending.length).toBe(0);

    // The reopened transport is watched as well.
    back.lose("gone again");
    expect(r.events.at(-1)).toBe("lost: gone again");
    expect(r.pending.length).toBe(1);
  });

  test("a stick that has not told its address yet is released and tried again", async () => {
    const early = new FakeUsb(0);
    const back = new FakeUsb();
    const r = rig([() => Promise.resolve(early), () => Promise.resolve(back)]);
    r.first.lose("gone");
    await r.step();
    expect(early.disconnected).toBe(1);
    expect(r.events).toEqual(["lost: gone"]);
    expect(r.logs.some((l) => l.includes("did not tell its address yet"))).toBe(true);
    await r.step();
    expect(r.events.at(-1)).toBe("restored");
  });

  test("stop() ends the retries", async () => {
    const r = rig([]);
    r.first.lose("gone");
    r.sup.stop();
    r.pending.shift()?.();
    await Promise.resolve();
    expect(r.events).toEqual(["lost: gone"]);
    expect(r.sup.current()).toBeNull();
  });

  test("an interface that opens after stop() is released, not restored", async () => {
    let resolve!: (t: KnxTransport) => void;
    const late = new FakeUsb();
    const r = rig([() => new Promise<KnxTransport>((res) => { resolve = res; })]);
    r.first.lose("gone");
    const fn = r.pending.shift()!;
    fn();
    r.sup.stop();
    resolve(late);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(late.disconnected).toBe(1);
    expect(r.events).toEqual(["lost: gone"]);
  });

  test("the stick back under another address ends the reopening instead of opening it every 2 s", async () => {
    const moved = new FakeUsb(0x1199);
    const r = rig([() => Promise.resolve(moved)]);
    r.first.lose("gone");
    await r.step();
    expect(moved.disconnected).toBe(1);
    expect(r.pending.length).toBe(0);
    expect(r.sup.current()).toBeNull();
    expect(r.logs.at(-1)).toContain("restart the bridge");
  });
});
