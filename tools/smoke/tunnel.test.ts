import { test, expect, describe } from "bun:test";
import { KnxError } from "../../packages/knx/src/index.ts";
import { connectTunnel, onFreshTunnel, DROP_WINDOW_MS } from "./tunnel.ts";

// A tunnel that refuses `refusals` connects (with `code`), then connects; counts its connects and closes.
const tunnels = (o: { refusals?: number; code?: string; closeError?: string } = {}) => {
  let left = o.refusals ?? 0;
  const log = { connects: 0, disconnects: 0 };
  const open = () => ({
    connect: async () => { log.connects++; if (left-- > 0) throw new KnxError(o.code ?? "TUNNEL_CONNECT_REJECTED", "no free channel"); },
    disconnect: async () => { log.disconnects++; if (o.closeError) throw new KnxError(o.closeError, "gone"); },
  });
  return { open, log };
};
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("the runner's tunnels to a unit whose restart drops the interface's tunnels", () => {
  test("a connect the interface refuses is tried again within the window", async () => {
    const t = tunnels({ refusals: 3 });
    await connectTunnel("h", 1, { drops: true, open: t.open, ...clock() });
    expect(t.log.connects).toBe(4);
  });

  test("past the window the refusal is thrown", async () => {
    const t = tunnels({ refusals: 1000 });
    const c = clock();
    const e = await failure(connectTunnel("h", 1, { drops: true, open: t.open, ...c }));
    expect(e).toMatchObject({ code: "TUNNEL_CONNECT_REJECTED" });
    expect(c.now()).toBeGreaterThanOrEqual(DROP_WINDOW_MS);
  });

  test("without drops a refused connect is thrown at once", async () => {
    const t = tunnels({ refusals: 1 });
    expect(await failure(connectTunnel("h", 1, { drops: false, open: t.open, ...clock() }))).toMatchObject({ code: "TUNNEL_CONNECT_REJECTED" });
    expect(t.log.connects).toBe(1);
  });

  test("a failure that is no refusal is thrown at once, drops or not", async () => {
    const t = tunnels({ refusals: 1, code: "SOMETHING_ELSE" });
    expect(await failure(connectTunnel("h", 1, { drops: true, open: t.open, ...clock() }))).toMatchObject({ code: "SOMETHING_ELSE" });
    expect(t.log.connects).toBe(1);
  });

  test("a read whose tunnel the interface drops runs again on a new one; without drops the loss is thrown", async () => {
    let tries = 0;
    const read = async () => { if (tries++ === 0) throw new KnxError("TUNNEL_CLOSED", "dropped"); return "bytes"; };
    const t = tunnels();
    expect(await onFreshTunnel("h", 1, { drops: true, open: t.open, ...clock() }, read)).toBe("bytes");
    expect(t.log).toEqual({ connects: 2, disconnects: 2 });
    tries = 0;
    expect(await failure(onFreshTunnel("h", 1, { drops: false, open: tunnels().open, ...clock() }, read))).toMatchObject({ code: "TUNNEL_CLOSED" });
  });

  test("a read that keeps losing its tunnel ends within one window, connects included", async () => {
    const c = clock();
    const read = async () => { throw new KnxError("TUNNEL_CLOSED", "dropped"); };
    const t = tunnels({ refusals: 1000 });
    let opened = 0;
    const open = () => { opened++; return opened % 2 ? t.open() : { connect: async () => undefined, disconnect: async () => undefined }; };
    expect(await failure(onFreshTunnel("h", 1, { drops: true, open, ...c }, read))).toMatchObject({ code: expect.stringMatching(/^TUNNEL_/) });
    expect(c.now()).toBeLessThanOrEqual(DROP_WINDOW_MS + 3_000);
  });

  test("a device's own failure is never repeated", async () => {
    let tries = 0;
    const read = async () => { tries++; throw new KnxError("DEVICE_NOT_ANSWERING", "silent"); };
    expect(await failure(onFreshTunnel("h", 1, { drops: true, open: tunnels().open, ...clock() }, read))).toMatchObject({ code: "DEVICE_NOT_ANSWERING" });
    expect(tries).toBe(1);
  });

  test("closing a tunnel the interface already dropped is no failure with drops, and is one without", async () => {
    const ok = async () => "bytes";
    expect(await onFreshTunnel("h", 1, { drops: true, open: tunnels({ closeError: "TUNNEL_CLOSED" }).open, ...clock() }, ok)).toBe("bytes");
    expect(await failure(onFreshTunnel("h", 1, { drops: false, open: tunnels({ closeError: "TUNNEL_CLOSED" }).open, ...clock() }, ok))).toMatchObject({ code: "TUNNEL_CLOSED" });
  });
});
