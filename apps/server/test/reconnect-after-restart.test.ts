import { test, expect, describe } from "bun:test";
import { reconnectAfterRestart, verifySettled } from "../src/deviceprofile.ts";

// A minimal stand-in for KnxDevice: deviceDescriptor() throws for the first `failProbes`
// attempts (simulating a device still rebooting after the LoadProcedure restart), then answers.
function mockDev(failProbes: number) {
  const calls = { connect: 0, disconnect: 0, probe: 0 };
  const dev = {
    connect: async () => { calls.connect++; },
    disconnect: async () => { calls.disconnect++; },
    deviceDescriptor: async () => {
      if (calls.probe++ < failProbes) throw new Error("no reliable response (device not answering)");
      return "MV-0705";
    },
  };
  return { dev, calls };
}

describe("reconnectAfterRestart", () => {
  test("succeeds once the rebooted device starts answering (retries with reconnect)", async () => {
    const { dev, calls } = mockDev(2); // silent for two probes, then up
    await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 0, tries: 6 });
    expect(calls.probe).toBe(3);      // two failures + one success
    expect(calls.connect).toBe(3);    // reconnect before every probe
    expect(calls.disconnect).toBe(2); // cleanup after each failed probe
  });

  test("succeeds immediately on a fast device (no wasted retries)", async () => {
    const { dev, calls } = mockDev(0);
    await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 0, tries: 6 });
    expect(calls.probe).toBe(1);
    expect(calls.connect).toBe(1);
    expect(calls.disconnect).toBe(0);
  });

  test("throws the device error after exhausting the budget (no false success)", async () => {
    const { dev, calls } = mockDev(99); // never answers
    await expect(reconnectAfterRestart(dev, { initialMs: 0, delayMs: 0, tries: 3 }))
      .rejects.toThrow(/device not answering/);
    expect(calls.connect).toBe(3); // tried exactly `tries` times
  });
});

describe("verifySettled", () => {
  test("matches on the first read (no wasted re-read)", async () => {
    let reads = 0;
    const r = await verifySettled(async () => { reads++; return 7; }, (v) => v === 7, 0);
    expect(r.ok).toBe(true);
    expect(reads).toBe(1);
  });

  test("absorbs a transient mismatch: re-reads once and succeeds", async () => {
    let reads = 0;
    // first read is a settling-transient (wrong), second read is correct
    const r = await verifySettled(async () => { reads++; return reads === 1 ? 0 : 7; }, (v) => v === 7, 0);
    expect(r.ok).toBe(true);
    expect(reads).toBe(2); // exactly one re-read
    expect(r.value).toBe(7);
  });

  test("a genuine mis-write still fails (mismatch persists on re-read)", async () => {
    let reads = 0;
    const r = await verifySettled(async () => { reads++; return 0; }, (v) => v === 7, 0);
    expect(r.ok).toBe(false);
    expect(reads).toBe(2); // tried once more, still wrong
  });
});
