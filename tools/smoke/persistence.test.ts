import { test, expect, describe } from "bun:test";
import { observeReboot, restartInConnection, RestartNotSent, judgeRestoredConfig, judgeLoadStates, judgeRunError, type ProbeOutcome } from "./persistence.ts";
import type { ConfigView } from "./client.ts";

// A probe that answers from a scripted sequence, one entry per call; the last entry repeats. The
// first entry is the pre-restart probe.
const scripted = (seq: ProbeOutcome[]) => { let i = 0; return async () => seq[Math.min(i++, seq.length - 1)]; };
const clock = () => { let t = 0; return { now: () => (t += 50), sleep: async () => undefined, windowMs: 1_000 }; };
const noop = async () => true; // a restart the interface confirmed
const unconfirmed = async () => false; // a restart the interface confirmed negatively

describe("observeReboot", () => {
  test("silence after the restart, then an answer, is a reboot", async () => {
    expect(await observeReboot(noop, scripted(["answered", "answered", "silent", "answered"]), clock())).toMatchObject({ rebooted: true });
  });

  test("a device that answers throughout never rebooted", async () => {
    const r = await observeReboot(noop, scripted(["answered"]), clock());
    expect(r).toMatchObject({ rebooted: false, detail: expect.stringContaining("never went silent") });
  });

  test("a device that goes silent and stays silent did not come back", async () => {
    const r = await observeReboot(noop, scripted(["answered", "silent"]), clock());
    expect(r).toMatchObject({ rebooted: false, detail: expect.stringContaining("did not answer again") });
  });

  test("a device that is silent before the restart proves nothing, and is not restarted", async () => {
    let sent = false;
    const r = await observeReboot(async () => { sent = true; return true; }, scripted(["silent", "answered"]), clock());
    expect(r).toMatchObject({ rebooted: false, detail: expect.stringContaining("before the restart") });
    expect(sent).toBe(false);
  });

  test("a negatively confirmed restart: one silent probe is not enough, it could be a lost probe", async () => {
    const r = await observeReboot(unconfirmed, scripted(["answered", "silent", "answered"]), clock());
    expect(r).toMatchObject({ rebooted: false, unproven: true, detail: expect.stringContaining("confirmed negatively") });
  });

  // Only a device that answers again leaves the reboot merely unseen; one that stays away did not come back.
  test("a negatively confirmed restart: a device that never answers again is no unproven reboot", async () => {
    for (const tail of ["silent", "unacknowledged"] as const) {
      const r = await observeReboot(unconfirmed, scripted(["answered", tail]), clock());
      expect([tail, r.rebooted, r.unproven]).toEqual([tail, false, undefined]);
    }
  });
  test("a restart, confirmed or not, that the device answers throughout is no unproven reboot: it did not reboot", async () => {
    for (const restart of [noop, unconfirmed]) {
      const r = await observeReboot(restart, scripted(["answered"]), clock());
      expect([r.rebooted, r.unproven, r.detail]).toEqual([false, undefined, expect.stringContaining("never went silent")]);
    }
  });

  test("a negatively confirmed restart: silent on two probes in a row, then an answer, is a reboot", async () => {
    const r = await observeReboot(unconfirmed, scripted(["answered", "silent", "silent", "answered"]), clock());
    expect(r).toMatchObject({ rebooted: true, detail: expect.stringContaining("confirmed negatively") });
  });

  test("a negatively confirmed restart: silent probes that are not in a row do not count", async () => {
    const r = await observeReboot(unconfirmed, scripted(["answered", "silent", "answered", "silent", "answered"]), clock());
    expect(r).toMatchObject({ rebooted: false });
  });

  test("a confirmed restart: an unacknowledged probe counts as silence", async () => {
    expect(await observeReboot(noop, scripted(["answered", "unacknowledged", "answered"]), clock())).toMatchObject({ rebooted: true });
  });

  test("a negatively confirmed restart: unacknowledged probes are no silence, whatever their number", async () => {
    const r = await observeReboot(unconfirmed, scripted(["answered", "unacknowledged", "unacknowledged", "unacknowledged", "answered"]), clock());
    // No reboot shown, but a gap and an answer after it: unproven, left to the load states and the read-back.
    expect(r).toMatchObject({ rebooted: false, unproven: true });
  });

  test("a restart the interface refused is not swallowed", async () => {
    const err = await observeReboot(async () => { throw new Error("Cannot write to hid device"); }, scripted(["answered"]), clock()).then(() => null, (e: unknown) => e);
    expect(String(err)).toContain("hid");
  });

  test("an interface error while probing is not silence", async () => {
    let i = 0;
    const probe = async (): Promise<ProbeOutcome> => { if (i++ === 1) throw new Error("tunnel ack timeout"); return "answered"; };
    const err = await observeReboot(noop, probe, clock()).then(() => null, (e: unknown) => e);
    expect(String(err)).toContain("tunnel");
  });
});

const view = (over: { paramChanged?: boolean; objChanged?: boolean; flagsChanged?: boolean; readsFlags?: boolean }): ConfigView => ({
  blocks: [{ items: [
    { kind: "param", param: { refId: "P-1", changed: over.paramChanged ?? false } },
    { kind: "comObject", comObject: { refId: "O-1", number: 1, gaRaw: 0x0901, changed: over.objChanged ?? false, flagsChanged: over.flagsChanged ?? false } },
  ] }],
  readbackSupport: { params: true, links: true, flags: over.readsFlags ?? false },
} as unknown as ConfigView);
const full = { paramsRead: true, linksRead: true, linkGaps: 0 };

// The MEAN WELL KNX-40E-1280D power supply's restart as its wire logs recorded it (private corpus,
// collections/meanwell-hc07-2026-10-14/meanwell-busforge-final2-par-*.log, through a KNX-USB interface):
// the interface confirms A_Restart negatively; frames to the unit are confirmed negatively until
// +0.68 s, then acknowledged on layer 2 and never answered on a connection opened before the reboot;
// the unit's start-up telegrams follow at +2.19 s, and a connection opened after them is answered.
// Replayed through the runner's probe (rebootObserved in runner.ts: a fresh connection and a device
// descriptor read, three tries of ackMs 1500 plus retryGapMs 200 when nothing answers), on a clock
// each probe advances by its own duration.
describe("observeReboot on the MEAN WELL power supply's recorded restart", () => {
  const replay = (restartConfirmed: boolean) => {
    let t = 0;
    const probe = async (): Promise<ProbeOutcome> => {
      const start = t;
      if (start === 0) { t += 100; return "answered"; } // before the restart
      if (start < 680) { t += 50; return "unacknowledged"; } // the T_Connect itself is confirmed negatively
      if (start < 2190) { t += 3 * 1500 + 2 * 200; return "silent"; } // the connection predates the reboot
      t += 100; return "answered";
    };
    return observeReboot(async () => { t += 100; return restartConfirmed; }, probe, { now: () => t, sleep: async (ms) => { t += ms; }, windowMs: 60_000 });
  };

  // One probe spans the whole window between the negative confirmations and the reboot, so the check
  // never sees the two silent probes in a row a negatively confirmed restart needs: it cannot tell
  // this unit's reboot, and the device answers again, so the step is not assessed rather than failed.
  test("a negatively confirmed restart: the reboot is not seen, and is unproven", async () => {
    expect(await replay(false)).toMatchObject({ rebooted: false, unproven: true, detail: expect.stringContaining("never went silent on two probes in a row") });
  });
  // Through an interface that confirmed the restart (whether the house's KNXnet/IP interface does is not
  // recorded), one silent probe suffices and the reboot is seen.
  test("a restart the interface confirmed: the reboot is seen", async () => {
    expect(await replay(true)).toMatchObject({ rebooted: true });
  });
});

describe("judgeRestoredConfig", () => {
  test("a complete read-back equal to the project passes", () => {
    expect(judgeRestoredConfig(view({}), full).state).toBe("pass");
  });

  test("a parameter or a link that differs after the reboot fails and is named", () => {
    expect(judgeRestoredConfig(view({ paramChanged: true }), full)).toMatchObject({ state: "fail", detail: expect.stringContaining("P-1") });
    expect(judgeRestoredConfig(view({ objChanged: true }), full)).toMatchObject({ state: "fail", detail: expect.stringContaining("object 1") });
  });

  test("a read-back that did not cover parameters and links, or did not say, proves nothing", () => {
    expect(judgeRestoredConfig(view({}), { ...full, paramsRead: false }).state).toBe("fail");
    expect(judgeRestoredConfig(view({}), { ...full, linkGaps: 2 }).state).toBe("fail");
    expect(judgeRestoredConfig(view({}), null).state).toBe("fail");
  });

  test("where the product reads the com-object table, its flags must be read and equal to the project after the reboot", () => {
    expect(judgeRestoredConfig(view({ readsFlags: true }), { ...full, flagsRead: true })).toEqual({ state: "pass", detail: "parameters and links and the com-object flags read back equal to the project after the reboot" });
    expect(judgeRestoredConfig(view({ readsFlags: true, flagsChanged: true }), { ...full, flagsRead: true })).toMatchObject({ state: "fail", detail: expect.stringContaining("flags of object 1") });
    expect(judgeRestoredConfig(view({ readsFlags: true }), { ...full, flagsRead: false, flagsUnreadable: "COM_OBJECT_TABLE_NOT_LOADED: x" })).toMatchObject({ state: "fail", detail: expect.stringContaining("could not read the device's com-object table") });
  });
});

describe("judgeLoadStates", () => {
  const loaded = new Map([[1, 1], [2, 1], [3, 1], [4, 1]]);

  test("every load object that was loaded before the reboot is loaded after it", () => {
    expect(judgeLoadStates(loaded, new Map(loaded)).state).toBe("pass");
  });

  test("an application that comes back in ERROR fails, bytes or not", () => {
    // Jung 400021SE on the bench: tables LOADED, the application object ERROR after A_Restart,
    // while every byte read back equal.
    expect(judgeLoadStates(loaded, new Map([[1, 1], [2, 1], [3, 1], [4, 3]]))).toMatchObject({ state: "fail", detail: expect.stringContaining("object 4") });
  });

  test("a state that could not be read after the reboot is not a pass", () => {
    expect(judgeLoadStates(loaded, new Map([[1, 1], [2, 1], [3, 1], [4, null]])).state).toBe("fail");
  });

  test("nothing readable before the restart proves nothing", () => {
    expect(judgeLoadStates(new Map([[1, null], [2, null]]), new Map()).state).toBe("fail");
  });
});

describe("judgeRunError (System 1)", () => {
  test("FF before the restart and after the reboot passes; anything else, or nothing read, fails", () => {
    expect(judgeRunError(0xff, 0xff).state).toBe("pass");
    // The load procedure leaves 00 until it completes: an application that does not run again.
    expect(judgeRunError(0xff, 0x00)).toMatchObject({ state: "fail", detail: expect.stringContaining("00") });
    expect(judgeRunError(0xff, null)).toMatchObject({ state: "fail", detail: expect.stringContaining("unreadable") });
    expect(judgeRunError(0x00, 0xff).state).toBe("fail");
  });
});

describe("restartInConnection", () => {
  const coded = (code: string) => Object.assign(new Error(`${code}: test`), { code });
  const fake = (o: { descriptorError?: Error; connectError?: Error; confirmed?: boolean } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      dev: {
        connect: async () => { calls.push("connect"); if (o.connectError) throw o.connectError; },
        deviceDescriptor: async () => { calls.push("descriptor"); if (o.descriptorError) throw o.descriptorError; return 0x0705; },
        sendRestart: async () => { calls.push("restart"); return o.confirmed ?? true; },
        disconnect: async () => { calls.push("disconnect"); },
      },
    };
  };
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  test("A_Restart goes out only after the device has answered a request in the same connection", async () => {
    const { dev, calls } = fake();
    expect(await restartInConnection(dev)).toBe(true);
    expect(calls).toEqual(["connect", "descriptor", "restart", "disconnect"]);
  });

  test("the interface's negative confirmation of the restart is passed on", async () => {
    expect(await restartInConnection(fake({ confirmed: false }).dev)).toBe(false);
  });

  test("a device silent in the connection gets no restart, as the device's own result", async () => {
    for (const code of ["DEVICE_NOT_ANSWERING", "DEVICE_CLOSED_CONNECTION", "BUS_SEND_FAILED"]) {
      const { dev, calls } = fake({ descriptorError: coded(code) });
      const e = await failure(restartInConnection(dev));
      expect(e).toBeInstanceOf(RestartNotSent);
      expect(String(e)).toContain(code);
      expect(calls).toEqual(["connect", "descriptor", "disconnect"]);
    }
  });

  test("a secure device leaving the restart connection's Sync unanswered gets no restart, as the device's own result", async () => {
    const { dev, calls } = fake({ connectError: coded("SECURE_SYNC_NO_RESPONSE") });
    expect(await failure(restartInConnection(dev))).toBeInstanceOf(RestartNotSent);
    expect(calls).toEqual(["connect", "disconnect"]);
  });

  test("a device answering with another service is up and gets the restart", async () => {
    const { dev, calls } = fake({ descriptorError: coded("ANSWER_SERVICE_MISMATCH") });
    expect(await restartInConnection(dev)).toBe(true);
    expect(calls).toEqual(["connect", "descriptor", "restart", "disconnect"]);
  });

  test("a failure of the link to the interface is thrown as it is, no restart sent", async () => {
    const { dev, calls } = fake({ descriptorError: coded("TUNNEL_CON_TIMEOUT") });
    const e = await failure(restartInConnection(dev));
    expect(e).not.toBeInstanceOf(RestartNotSent);
    expect(String(e)).toContain("TUNNEL_CON_TIMEOUT");
    expect(calls).not.toContain("restart");
  });

  test("observeReboot reports a restart left unsent by a silent device as no reboot, and passes any other failure on", async () => {
    const answering = async (): Promise<ProbeOutcome> => "answered";
    const r = await observeReboot(() => restartInConnection(fake({ descriptorError: coded("DEVICE_NOT_ANSWERING") }).dev), answering, clock());
    expect(r).toEqual({ rebooted: false, detail: "the device did not answer in the restart's connection (DEVICE_NOT_ANSWERING), so A_Restart was not sent" });
    const e = await failure(observeReboot(() => restartInConnection(fake({ descriptorError: coded("TUNNEL_CON_TIMEOUT") }).dev), answering, clock()));
    expect(String(e)).toContain("TUNNEL_CON_TIMEOUT");
  });
});
