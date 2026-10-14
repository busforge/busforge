import { test, expect, describe } from "bun:test";
import { observeReboot, judgeRestoredConfig, judgeLoadStates, type ProbeOutcome } from "./persistence.ts";
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
    expect(r).toMatchObject({ rebooted: false, detail: expect.stringContaining("confirmed negatively") });
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
    expect(r).toMatchObject({ rebooted: false });
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

const view = (over: { paramChanged?: boolean; objChanged?: boolean }): ConfigView => ({
  blocks: [{ items: [
    { kind: "param", param: { refId: "P-1", changed: over.paramChanged ?? false } },
    { kind: "comObject", comObject: { refId: "O-1", number: 1, gaRaw: 0x0901, changed: over.objChanged ?? false } },
  ] }],
} as unknown as ConfigView);
const full = { paramsRead: true, linksRead: true, linkGaps: 0 };

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
