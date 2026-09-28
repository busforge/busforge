import { test, expect, describe } from "bun:test";
import { activateSecureDevice, type ActivationDeps } from "../src/activation.ts";
import type { KnxDevice } from "../src/device.ts";

const FDSK = Buffer.alloc(16, 0xfd), SERIAL = Buffer.from("00fa01020304", "hex"), NEW = Buffer.alloc(16, 0x11);

// A secure device as the activation sees it: which key opens it, its security mode, and what it
// does with a tool key write. `log` records the order of everything that happens.
function device(opts: { toolKey?: Buffer; mode?: boolean; keyWrite?: "takes" | "takes-then-silent" | "lost"; serial?: Buffer }) {
  const state = { toolKey: opts.toolKey ?? null as Buffer | null, mode: opts.mode ?? false };
  const log: string[] = [];
  const deps: ActivationDeps = {
    async open(key, serial) {
      const factory = state.toolKey === null && key.equals(FDSK);
      if (!factory && !(state.toolKey && key.equals(state.toolKey))) {
        log.push(`sync ${key[0].toString(16)} unanswered`);
        throw Object.assign(new Error("no sync"), { code: "SECURE_SYNC_NO_RESPONSE" });
      }
      log.push(`sync ${key[0].toString(16)} serial ${serial.toString("hex")}`);
      return {
        securityMode: async () => state.mode,
        propRead: async () => { log.push("read serial"); return opts.serial ?? SERIAL; },
        funcPropExtCommand: async () => { log.push("mode on"); state.mode = true; return { returnCode: 0, result: Buffer.from([0]) }; },
        writeToolKey: async (k: Buffer) => {
          log.push("write key");
          if (opts.keyWrite === "lost") throw Object.assign(new Error("lost"), { code: "DEVICE_NOT_ANSWERING" });
          state.toolKey = k;
          if (opts.keyWrite === "takes-then-silent") throw Object.assign(new Error("silent"), { code: "DEVICE_NOT_ANSWERING" });
        },
      } as unknown as KnxDevice;
    },
    async close() { log.push("close"); },
  };
  return { deps, state, log };
}

describe("secure activation from the factory key", () => {
  test("a device whose serial is not the certificate's is refused before a key is kept or written", async () => {
    const d = device({ serial: Buffer.from("00fa09090909", "hex") });
    const err = await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, newKey: () => NEW, persistKey: () => { throw new Error("must not persist"); } }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("CERTIFICATE_SERIAL_MISMATCH");
    expect(d.log).not.toContain("write key");
  });

  test("a device holding the key with its security mode off gets the mode switched on", async () => {
    const d = device({ toolKey: NEW, mode: false });
    const r = await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, storedKey: NEW, persistKey: () => {} });
    expect(r.outcome).toBe("already-active");
    expect(d.state.mode).toBe(true);
  });

  test("a factory device: FDSK session with the serial zeroed, key persisted before it is written, mode on, then proven under the new key", async () => {
    const d = device({});
    const persisted: Buffer[] = [];
    const r = await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, newKey: () => NEW, persistKey: (k) => { persisted.push(k); d.log.push("persist"); } });
    expect(r).toEqual({ outcome: "activated", toolKey: NEW });
    expect(persisted).toEqual([NEW]);
    expect(d.log).toEqual(["sync fd serial 000000000000", "read serial", "persist", "mode on", "write key", "close", "sync 11 serial 00fa01020304", "close"]);
    expect(d.state).toEqual({ toolKey: NEW, mode: true });
  });

  test("a device that already holds the key on file is left alone", async () => {
    const d = device({ toolKey: NEW, mode: true });
    const r = await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, storedKey: NEW, persistKey: () => { throw new Error("must not persist"); } });
    expect(r.outcome).toBe("already-active");
    expect(d.log).toEqual(["sync 11 serial 00fa01020304", "close"]);
  });

  test("a device holding a key busforge does not know is refused, nothing written", async () => {
    const d = device({ toolKey: Buffer.alloc(16, 0x77), mode: true });
    const err = await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, storedKey: NEW, persistKey: () => {} }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("ACTIVATION_NO_KEY_ACCEPTED");
    expect(d.log.some((l) => l === "write key" || l === "mode on")).toBe(false);
  });

  test("interrupted after the device took the key: the key on file opens it on the next run", async () => {
    const d = device({ keyWrite: "takes-then-silent" });
    let onFile: Buffer | undefined;
    const first = await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, newKey: () => NEW, persistKey: (k) => { onFile = k; } }).catch((e: unknown) => e);
    expect((first as { code?: string }).code).toBe("DEVICE_NOT_ANSWERING");
    expect(onFile).toEqual(NEW); // persisted although the write never confirmed
    const again = await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, storedKey: onFile, persistKey: () => {} });
    expect(again).toEqual({ outcome: "already-active", toolKey: NEW });
  });

  test("interrupted before the device took the key: the next run writes the same key from its factory session", async () => {
    const d = device({ keyWrite: "lost" });
    let onFile: Buffer | undefined;
    await activateSecureDevice(d.deps, { fdsk: FDSK, serial: SERIAL, newKey: () => NEW, persistKey: (k) => { onFile = k; } }).catch(() => {});
    const d2 = device({});
    const again = await activateSecureDevice(d2.deps, { fdsk: FDSK, serial: SERIAL, storedKey: onFile, newKey: () => Buffer.alloc(16, 0x22), persistKey: () => {} });
    expect(again).toEqual({ outcome: "activated", toolKey: NEW });
  });
});
