import { test, expect, describe } from "bun:test";
import { KnxDevice, LSM, STATE } from "@busforge/knx";
import { parseAppConfig, buildAbsoluteSegmentTargets, parameterMemoryBytes } from "@busforge/product";
import { classify } from "../src/deviceprofile.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// System 7 (MV-0705) parameter-flash ORCHESTRATION on a mock device, using the real
// hardware-proven M-0081 application program. The segment builder
// (buildAbsoluteSegmentTargets) is locked by the golden corpus, so it is trusted here
// for SEEDING the mock memory; the subject under test is flashParameters' orchestration:
// backup read -> surgical plan -> LSM bracket -> restart -> reconnect -> owned-byte verify.

corpusDescribe("the MV-0705 parameter flash against the real M-0081 application", () => {
  const xml = catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");
  const cfg = parseAppConfig(xml);

  // Byte-addressed mock (same shape as ga-flash.test.ts's): memory map + LSM state via
  // property 5, plus a write log so the no-write claims of dryRun/unchanged are positive
  // assertions rather than "nothing looked different".
  class MockDevice {
    mem = new Map<number, number>();
    state = new Map<number, number>(); // LSM object -> STATE
    writes: { addr: number; len: number }[] = [];
    async connect() {}
    async disconnect() {}
    async deviceDescriptor() { return "MV-0705"; } // post-restart liveness probe (reconnectAfterRestart)
    async restart() {}
    async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0xff; return b; }
    async writesConfirmed() { return false; } // no PID_MAX_APDU_LENGTH: the classic write
    confirmedWrites() { return []; }
    clearConfirmedWrites() {}
    setExtendedMemoryServices() {}
    async memWrite(addr: number, data: Buffer, opts: { verify?: boolean } = {}) {
      this.writes.push({ addr, len: data.length });
      for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]);
      if (opts.verify) { const back = await this.memRead(addr, data.length); if (!back.equals(data)) throw new Error("verify mismatch"); }
    }
    async propRead(obj: number, pid: number) { if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.LOADED]); return Buffer.alloc(0); }
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === 5) { const ev = data[0]; this.state.set(obj, ev === LSM.LOAD ? STATE.LOADING : ev === LSM.LOAD_COMPLETED ? STATE.LOADED : STATE.UNLOADED); }
      return Buffer.alloc(0);
    }
  }
  const asDev = (m: MockDevice) => m as unknown as KnxDevice;

  const SENTINEL = 0xee; // unowned bytes: never a value the target image would produce here

  // Segment layout the flash must respect. Empty params = the app's defaults; the corpus
  // locks that this yields exactly the byte image ETS computes.
  const params = new Map<string, string>();
  const targets = buildAbsoluteSegmentTargets(cfg, params);

  // The one owned byte the tests flip on the device. XOR 0xFF guarantees it differs from
  // the target, independent of what the target byte happens to be (no fake green from an
  // accidentally-matching seed).
  const flip = targets[0].verify.findIndex(Boolean);

  // Seed the mock: owned bytes carry the target value, EXCEPT the flip byte (inverted when
  // oneByteDrift), and every unowned byte carries the sentinel. The flash's surgical
  // guarantee is that the sentinel bytes survive untouched.
  function seeded(oneByteDrift: boolean): MockDevice {
    const dev = new MockDevice();
    for (const t of targets) {
      for (let i = 0; i < t.size; i++) dev.mem.set(t.address + i, t.owned[i] ? t.bytes[i] : SENTINEL);
    }
    if (oneByteDrift) dev.mem.set(targets[0].address + flip, targets[0].bytes[flip] ^ 0xff);
    return dev;
  }

  // Recording backup hook: the profile hands the device's CURRENT bytes over BEFORE any
  // write (runFlashOp's structural ordering); the log lets tests assert exactly that.
  const ctxFor = (dryRun: boolean) => {
    const backups: { file: string; bytes: Buffer }[] = [];
    const events: string[] = [];
    return {
      ctx: {
        // baseParams == params: the device was programmed with this very configuration, so the
        // com-object staleness gate is a no-op here and these tests exercise flash mechanics.
        deviceId: "d", appXml: xml, params, baseParams: params, moduleInstances: [], dryRun,
        persistBackups: (files: { file: string; bytes: Buffer }[]) => { backups.push(...files); events.push("backup-persisted"); return "backup"; },
      },
      backups, events,
    };
  };

  describe("MV-0705 parameter-flash orchestration (real M-0081 app, mock device)", () => {
    // Sanity on the fixture itself, so a fixture change fails loudly here instead of
    // silently weakening the assertions below (e.g. a flip index of -1 would "flip"
    // nothing and turn the whole flash test into a no-op).
    test("fixture ground truth: M-0081 is MV-0705 with an owned+verifiable parameter segment", () => {
      expect(cfg.mask).toBe("MV-0705");
      expect(targets.length).toBeGreaterThan(0);
      expect(flip).toBeGreaterThanOrEqual(0);
      expect(!!targets[0].owned[flip]).toBe(true);
    });

    test("real flash of a one-byte drift: writes the bytes ETS writes, that byte changed, verifies, LSM ends LOADED", async () => {
      const dev = seeded(true);
      const profile = classify(cfg);
      const { ctx, backups, events } = ctxFor(false);
      // interleave write events into the same log so the backup-before-write order is provable
      const origWrite = dev.memWrite.bind(dev);
      dev.memWrite = async (a: number, b: Buffer, o?: { verify?: boolean }) => { events.push("device-write"); return origWrite(a, b, o); };
      const res = await profile.flashParameters(asDev(dev), "0705", ctx);

      // The device's pre-flash state reached the backup hook BEFORE the first write, and
      // it carries the drifted byte (a backup of the OLD state, not the new image).
      expect(events[0]).toBe("backup-persisted");
      expect(events.filter((e) => e === "device-write").length).toBeGreaterThan(0);
      expect(events.indexOf("device-write")).toBeGreaterThan(events.indexOf("backup-persisted"));
      expect(backups.length).toBeGreaterThan(0);

      expect(res.kind).toBe("flashed");
      if (res.kind !== "flashed") throw new Error("unreachable"); // narrow for TS
      expect(res.verified).toBe(true);
      expect(res.diffBytes).toBe(1);

      // The drifted owned byte now holds the target value...
      expect(dev.mem.get(targets[0].address + flip)).toBe(targets[0].bytes[flip]);
      // ...and in fact every owned byte matches the target image.
      for (const t of targets) {
        for (let i = 0; i < t.size; i++) {
          if (t.owned[i]) expect(dev.mem.get(t.address + i)).toBe(t.bytes[i]);
        }
      }
      // The surgical guarantee: a parameter flash must NEVER touch unowned bytes
      // (manufacturer defaults / erased gaps / inactive branches). Every sentinel survives.
      for (const t of targets) {
        for (let i = 0; i < t.size; i++) {
          if (!t.owned[i]) expect(dev.mem.get(t.address + i)).toBe(SENTINEL);
        }
      }
      // The load bracket ran and completed: at least one LSM saw events, and every LSM
      // that did ended LOADED (a half-open machine would still read LOADING/UNLOADED).
      expect(dev.state.size).toBeGreaterThan(0);
      for (const [, s] of dev.state) expect(s).toBe(STATE.LOADED);
      // Written: every byte a parameter's memory covers, as ETS's parameter download of this application
      // writes them (parWriteSet); the bytes no active parameter owns carry what the device held.
      const covered = parameterMemoryBytes(cfg, targets[0].id, targets[0].size)!;
      const writtenAt = dev.writes.flatMap((w) => Array.from({ length: w.len }, (_, i) => w.addr + i));
      expect(writtenAt).toEqual(covered.flatMap((c, i) => (c ? [targets[0].address + i] : [])));
    }, 15_000); // reconnectAfterRestart sleeps 3 s (not injectable through flashParameters)

    test("verify has teeth: a device that does not persist the write reports verified:false, NOT a fake success", async () => {
      // Guards against the mock being a "perfect memory" where verify can never fail. Here the
      // device drops the write on restart (re-stamps the verifiable owned byte to a wrong value),
      // exactly the class of real failure a post-restart read-back must catch.
      const dev = seeded(true);
      const badByte = targets[0].address + flip; // a VERIFIABLE owned byte (flip = verify index)
      dev.restart = async () => { dev.mem.set(badByte, targets[0].bytes[flip] ^ 0xff); }; // write did not stick
      const profile = classify(cfg);
      const res = await profile.flashParameters(asDev(dev), "0705", ctxFor(false).ctx);

      expect(res.kind).toBe("flashed");
      if (res.kind !== "flashed") throw new Error("unreachable");
      expect(res.verified).toBe(false); // the read-back mismatch is surfaced, not swallowed
    }, 15_000); // reconnectAfterRestart + verifySettled retries

    test("dryRun of the same drift: reports diffBytes=1 and writes NOTHING", async () => {
      const dev = seeded(true);
      const before = new Map(dev.mem);
      const profile = classify(cfg);
      const res = await profile.flashParameters(asDev(dev), "0705", ctxFor(true).ctx);

      expect(res.kind).toBe("dryRun");
      if (res.kind !== "dryRun") throw new Error("unreachable");
      expect(res.diffBytes).toBe(1);
      // No memWrite calls at all, no LSM events, and the memory is byte-identical.
      expect(dev.writes).toEqual([]);
      expect(dev.state.size).toBe(0);
      expect(dev.mem).toEqual(before);
    });

    test("device already in sync: 'unchanged', no LSM events, no writes", async () => {
      const dev = seeded(false); // owned bytes = exact target
      const before = new Map(dev.mem);
      const profile = classify(cfg);
      const res = await profile.flashParameters(asDev(dev), "0705", ctxFor(false).ctx);

      expect(res.kind).toBe("unchanged");
      expect(dev.writes).toEqual([]);
      expect(dev.state.size).toBe(0);
      expect(dev.mem).toEqual(before);
    });

    // An interrupted earlier write can leave the bytes right and the load-state machine Loading: the
    // application does not run them, so "unchanged" would be a false all-clear. The absolute plan
    // writes only what differs, so it cannot finish that load; it refuses.
    test("a real change while the parameter load-state machine is Loading: refused too, nothing written", async () => {
      const dev = seeded(true);
      dev.state.set(3, STATE.LOADING);
      const err = await classify(cfg).flashParameters(asDev(dev), "0705", ctxFor(false).ctx).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("DEVICE_LOAD_INCOMPLETE");
      expect(dev.writes).toEqual([]);
    });

    test("in sync but the parameter load-state machine is Loading: refused, nothing written", async () => {
      const dev = seeded(false);
      dev.state.set(3, STATE.LOADING); // LdCtrlAbsSegment declares the parameter segment (0x4200) under LSM 3
      const err = await classify(cfg).flashParameters(asDev(dev), "0705", ctxFor(false).ctx).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("DEVICE_LOAD_INCOMPLETE");
      expect(dev.writes).toEqual([]);
    });
  });
});
