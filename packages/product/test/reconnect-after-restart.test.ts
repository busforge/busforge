import { test, expect, describe } from "bun:test";
import { reconnectAfterRestart } from "../src/profiles.ts";

// An MDT IP interface stops serving its tunnels for 40-64 s whenever the MDT IP router beside it
// restarts, then drops them: the connection the flash runs over fails with a link error, not the
// device. Simulated: the link fails `failFor` times, then answers once it was opened again.
function device(opts: { failFor: number; reopenFails?: number; code?: string }) {
  let failures = 0, reopenFailures = 0, reopened = 0, probes = 0;
  const linkError = () => Object.assign(new Error("link down"), { code: opts.code ?? "TUNNEL_CLOSED" });
  return {
    get reopened() { return reopened; },
    get probes() { return probes; },
    async connect() { if (failures < opts.failFor) { failures++; throw linkError(); } },
    async disconnect() {},
    async deviceDescriptor() { probes++; return "MV-07B0"; },
    async reopenTransport() {
      if (reopenFailures < (opts.reopenFails ?? 0)) { reopenFailures++; throw Object.assign(new Error("no answer"), { code: "TUNNEL_CONNECT_TIMEOUT" }); }
      reopened++;
    },
  };
}

describe("reconnecting after a restart that took the interface's tunnels down", () => {
  test("a link error reopens the link, and the device is probed on it", async () => {
    const dev = device({ failFor: 1 });
    await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 1 });
    expect(dev.reopened).toBe(1);
    expect(dev.probes).toBe(1);
  });

  test("link errors are retried beyond the device tries until the link deadline", async () => {
    const dev = device({ failFor: 2, reopenFails: 8 });
    await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 1, tries: 2, linkDeadlineMs: 10_000 });
    expect(dev.probes).toBe(1);
  });

  test("a link that stays down past the deadline is reported as an unverified write", async () => {
    const dev = device({ failFor: 1000, code: "TUNNEL_CON_TIMEOUT" });
    const err = await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 5, tries: 2, linkDeadlineMs: 60 }).then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe("FLASH_UNVERIFIED_LINK_DOWN");
    expect(dev.probes).toBe(0);
  });

  test("once the link is back the device gets its own tries again", async () => {
    let linkFails = 4, deviceFails = 2, probes = 0;
    const dev = {
      async connect() { if (linkFails > 0) { linkFails--; throw Object.assign(new Error("down"), { code: "TUNNEL_CLOSED" }); } },
      async disconnect() {},
      async deviceDescriptor() { probes++; if (deviceFails-- > 0) throw Object.assign(new Error("booting"), { code: "DEVICE_NOT_ANSWERING" }); return "x"; },
      async reopenTransport() {},
    };
    await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 1, tries: 3, linkDeadlineMs: 10_000 });
    expect(probes).toBe(3);
  });

  test("a link that comes back under another address ends the reconnect at once", async () => {
    let reopens = 0;
    const dev = {
      async connect() { throw Object.assign(new Error("down"), { code: "TUNNEL_CLOSED" }); },
      async disconnect() {}, async deviceDescriptor() { return "x"; },
      async reopenTransport() { reopens++; throw Object.assign(new Error("other address"), { code: "TUNNEL_ADDRESS_CHANGED" }); },
    };
    const err = await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 1, tries: 6, linkDeadlineMs: 10_000 }).then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe("TUNNEL_ADDRESS_CHANGED");
    expect(reopens).toBe(1);
  });

  test("a verify that finds the link down starts in that state and reopens inside the retry budget", async () => {
    const dev = device({ failFor: 0, reopenFails: 3 });
    await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 1, linkDown: true, linkDeadlineMs: 10_000 });
    expect(dev.reopened).toBe(1);
    expect(dev.probes).toBe(1);
  });

  test("the error after the link deadline says the write may have landed", async () => {
    const dev = device({ failFor: 1000 });
    const err = await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 5, linkDeadlineMs: 40 }).then(() => null, (e: Error) => e);
    expect((err as Error & { code?: string })?.code).toBe("FLASH_UNVERIFIED_LINK_DOWN");
    expect(err?.message).toMatch(/did not come back within .* of the restart .*so the write is not verified/);
  });

  test("a reopen the interface refuses (no free channel yet) is still the link, retried past the device tries", async () => {
    let refusals = 5, probes = 0;
    const dev = {
      async connect() {}, async disconnect() {},
      async deviceDescriptor() { probes++; return "x"; },
      async reopenTransport() { if (refusals-- > 0) throw Object.assign(new Error("connect status 0x24"), { code: "TUNNEL_CONNECT_REJECTED" }); },
    };
    await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 1, tries: 2, linkDown: true, linkDeadlineMs: 10_000 });
    expect(probes).toBe(1);
  });

  test("a device error is not a link error: no reopen, the device tries only", async () => {
    let tries = 0;
    const dev = {
      async connect() { tries++; throw Object.assign(new Error("silent"), { code: "DEVICE_NOT_ANSWERING" }); },
      async disconnect() {}, async deviceDescriptor() { return "x"; },
      async reopenTransport() { throw new Error("must not reopen"); },
    };
    const err = await reconnectAfterRestart(dev, { initialMs: 0, delayMs: 1, tries: 3, linkDeadlineMs: 10_000 }).then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe("DEVICE_NOT_ANSWERING");
    expect(tries).toBe(3);
  });
});
