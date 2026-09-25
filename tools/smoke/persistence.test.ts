import { test, expect, describe } from "bun:test";
import { observeReboot, judgeRestoredConfig, type ProbeOutcome } from "./persistence.ts";
import type { ConfigView } from "./client.ts";

// A probe that answers from a scripted sequence, one entry per call; the last entry repeats. The
// first entry is the pre-restart probe.
const scripted = (seq: ProbeOutcome[]) => { let i = 0; return async () => seq[Math.min(i++, seq.length - 1)]; };
const clock = () => { let t = 0; return { now: () => (t += 50), sleep: async () => undefined, windowMs: 1_000 }; };
const noop = async () => undefined;

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
    const r = await observeReboot(async () => { sent = true; }, scripted(["silent", "answered"]), clock());
    expect(r).toMatchObject({ rebooted: false, detail: expect.stringContaining("before the restart") });
    expect(sent).toBe(false);
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
