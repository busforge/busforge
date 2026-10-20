import { test, expect, describe } from "bun:test";
import { gaToNum } from "../../packages/knx/src/index.ts";
import type { DeviceReadbackInfo } from "../../packages/product/src/index.ts";
import { capFlashLinks, capReadLinks, type CapCtx } from "./capabilities.ts";
import { flagsMoved, flagsNotRead, type CfgComObjView, type Client, type ConfigView, type FlashResult } from "./client.ts";
import type { DeviceSpec } from "./spec.ts";

type Flags = CfgComObjView["flags"];
const APP_FLAGS: Flags = { read: true, write: true, comm: true, transmit: true, update: false, readOnInit: false };

// A device with two objects behind a server that keeps the project's links and flags apart from the
// device's: a GA flash writes the project's to the device (through `write`, which a test can falsify),
// a read-back takes the device's into the baseline the view compares with.
function bench(opts: { editable?: string[]; readsFlags?: boolean; readback?: Partial<DeviceReadbackInfo>; write?: (links: number[]) => number[] } = {}) {
  const refs = ["O-0", "O-1"];
  const project = { links: new Map(refs.map((r) => [r, [] as number[]])), flags: new Map(refs.map((r) => [r, { ...APP_FLAGS }])) };
  const device = { links: new Map(refs.map((r) => [r, [] as number[]])), flags: new Map(refs.map((r) => [r, { ...APP_FLAGS }])) };
  const base = { links: new Map(device.links), flags: new Map([...device.flags].map(([r, f]) => [r, { ...f }])) };
  const calls: string[] = [];
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((g, i) => g === b[i]);
  const view = (): ConfigView => ({
    blocks: [{ items: refs.map((refId, number) => ({
      kind: "comObject",
      comObject: {
        refId, number, name: refId, functionText: "", objectSize: "1 Bit", dpt: "", priority: "Low",
        flags: { ...project.flags.get(refId)! }, gaRaws: [...project.links.get(refId)!], gaRaw: project.links.get(refId)![0] ?? null,
        changed: !same(project.links.get(refId)!, base.links.get(refId)!),
        flagsChanged: JSON.stringify(project.flags.get(refId)) !== JSON.stringify(base.flags.get(refId)),
      },
    })) }],
    readbackSupport: { params: true, links: true, flags: opts.readsFlags ?? true },
    comObjFlagsEditable: opts.editable ?? ["read", "write", "comm", "transmit", "update", "readOnInit", "priority"],
  }) as unknown as ConfigView;
  const flashed: FlashResult = { kind: "flashed", verified: true } as FlashResult;
  const client = {
    getConfig: async () => view(),
    ensureGa: async (_pid: string, ga: string) => { calls.push(`ensureGa ${ga}`); },
    link: async (_p: string, _d: string, ref: string, ga: string) => { calls.push(`link ${ref} ${ga}`); project.links.set(ref, [gaToNum(ga)]); return view(); },
    setLinks: async (_p: string, _d: string, ref: string, gaRaws: number[]) => { calls.push(`setLinks ${ref} ${gaRaws.join(",")}`); project.links.set(ref, [...gaRaws]); return view(); },
    setFlags: async (_p: string, _d: string, ref: string, flags: Partial<Record<keyof Flags, boolean | null>>) => {
      calls.push(`setFlags ${ref} ${JSON.stringify(flags)}`);
      const f = project.flags.get(ref)!;
      for (const [k, v] of Object.entries(flags)) f[k as keyof Flags] = v ?? APP_FLAGS[k as keyof Flags];
      return view();
    },
    flashGaReal: async () => {
      calls.push("flash-ga");
      for (const [r, l] of project.links) device.links.set(r, (opts.write ?? ((x) => x))([...l]));
      for (const [r, f] of project.flags) device.flags.set(r, { ...f });
      return flashed;
    },
    flashGaDry: async () => {
      calls.push("flash-ga dry");
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      return { kind: refs.every((r) => same(project.links.get(r), device.links.get(r)) && same(project.flags.get(r), device.flags.get(r))) ? "unchanged" : "dryRun" } as FlashResult;
    },
    readBack: async () => {
      calls.push("read-back");
      for (const [r, l] of device.links) base.links.set(r, [...l]);
      for (const [r, f] of device.flags) base.flags.set(r, { ...f });
      return { paramsRead: true, linksRead: true, linkGaps: 0, flagsRead: opts.readsFlags ?? true, ...opts.readback } as DeviceReadbackInfo;
    },
  } as unknown as Client;
  let next = 1;
  const ctx: CapCtx = {
    client, ui: null, pid: "p", did: "d", channel: "api", log: () => undefined, settle: async () => undefined,
    spec: { id: "t", device: { appRef: "M-0000_H-1_HP-1", productRef: "P", ia: "1.1.1", mask: "MV-07B0" }, provision: "skip-if-present", configure: [], behaviours: [] } as unknown as DeviceSpec,
    rnd: () => 0.5, allocGa: () => `1/3/${next++}`,
  };
  return { ctx, calls, device, project };
}

describe("flashLinks", () => {
  test("adds a second address behind the first and turns the read flag over in one GA flash, takes both back in another, and leaves the device as it was apart from the link", async () => {
    const b = bench();
    const r = await capFlashLinks(b.ctx);
    expect(r.state).toBe("pass");
    expect(r.detail).toContain("1/3/2 added behind it and its read flag off in one GA flash, taken back in another");
    expect(b.calls).toEqual([
      "ensureGa 1/3/1", "link O-0 1/3/1", "flash-ga", "read-back",
      "ensureGa 1/3/2", `setLinks O-0 ${gaToNum("1/3/1")},${gaToNum("1/3/2")}`, 'setFlags O-0 {"read":false}', "flash-ga", "read-back",
      `setLinks O-0 ${gaToNum("1/3/1")}`, 'setFlags O-0 {"read":true}', "flash-ga", "read-back",
    ]);
    expect(b.device.links.get("O-0")).toEqual([gaToNum("1/3/1")]);
    expect(b.device.flags.get("O-0")).toEqual(APP_FLAGS);
  });

  test("fails when the device keeps only the first of two addresses, and takes the flag back on the device", async () => {
    const b = bench({ write: (l) => l.slice(0, 1) });
    const r = await capFlashLinks(b.ctx);
    expect(r.state).toBe("fail");
    expect(r.detail).toBe("after adding 1/3/2 behind 1/3/1 and setting the read flag off on object 0: the device holds other links than the project; the object was taken back on the device");
    expect(b.project.links.get("O-0")).toEqual([gaToNum("1/3/1")]);
    expect(b.device.links.get("O-0")).toEqual([gaToNum("1/3/1")]);
    expect(b.device.flags.get("O-0")).toEqual(APP_FLAGS);
  });

  test("takes the second address and the flag back when a step throws before anything was written", async () => {
    const b = bench();
    const flash = b.ctx.client.flashGaReal.bind(b.ctx.client);
    let n = 0;
    b.ctx.client.flashGaReal = (p, d, on) => (++n === 2 ? Promise.reject(new Error("TUNNEL_CLOSED: send on a closed tunnel")) : flash(p, d, on));
    const r = await capFlashLinks(b.ctx);
    expect(r.state).toBe("fail");
    expect(r.detail).toBe("TUNNEL_CLOSED: send on a closed tunnel; the object was taken back in the project, the device already held it");
    expect(b.project.links.get("O-0")).toEqual([gaToNum("1/3/1")]);
    expect(b.project.flags.get("O-0")).toEqual(APP_FLAGS);
  });

  test("fails when the second address lands in front of the first", async () => {
    const b = bench();
    const setLinks = b.ctx.client.setLinks.bind(b.ctx.client);
    b.ctx.client.setLinks = (p, d, ref, gaRaws) => setLinks(p, d, ref, [...gaRaws].reverse());
    const r = await capFlashLinks(b.ctx);
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("the project links 1/3/2, 1/3/1, expected 1/3/1, 1/3/2");
  });

  test("leaves the flags alone where the downloads do not write the read flag, and says so", async () => {
    const b = bench({ editable: [] });
    const r = await capFlashLinks(b.ctx);
    expect(r.state).toBe("pass");
    expect(b.calls.some((c) => c.startsWith("setFlags"))).toBe(false);
    expect(r.detail).toContain("its flags not edited (the downloads do not write the read flag)");
  });

  test("leaves the flags alone where the read-back does not read the com-object table, and says so", async () => {
    const b = bench({ readsFlags: false });
    const r = await capFlashLinks(b.ctx);
    expect(r.state).toBe("pass");
    expect(b.calls.some((c) => c.startsWith("setFlags"))).toBe(false);
    expect(r.detail).toContain("its flags not edited (the read-back does not read the com-object table)");
  });

  test("stops where the read-back could not read the com-object table of a product that reads it", async () => {
    const b = bench({ readback: { flagsRead: false, flagsUnreadable: "COM_OBJECT_TABLE_NOT_LOADED: not loaded" } });
    const e = await capFlashLinks(b.ctx).then(() => null, (x: unknown) => x);
    expect(String(e)).toContain("the read-back could not read the device's com-object table: COM_OBJECT_TABLE_NOT_LOADED");
  });
});

describe("readLinks", () => {
  test("passes with every object's flags read and equal to the project", async () => {
    const r = await capReadLinks(bench().ctx);
    expect(r.state).toBe("pass");
    expect(r.detail).toContain("every object's flags read from the com-object table, equal to the project");
  });

  test("names the objects whose flags on the device differ from the project, as it does not judge links either", async () => {
    const b = bench();
    b.device.flags.get("O-1")!.transmit = false;
    const r = await capReadLinks(b.ctx);
    expect(r.state).toBe("pass");
    expect(r.detail).toBe("group tables read back and decoded, no gaps; every object's flags read from the com-object table, object(s) 1 holding other flags than the project");
  });
});

describe("flagsNotRead", () => {
  const view = (flags: boolean) => ({ readbackSupport: { params: true, links: true, flags } });
  const rb = (r: Partial<DeviceReadbackInfo>) => ({ paramsRead: true, linksRead: true, linkGaps: 0, ...r }) as DeviceReadbackInfo;
  test("asks nothing of a product whose read-back does not read the com-object table", () => {
    expect(flagsNotRead(view(false), rb({}))).toBeNull();
  });
  test("names objects whose flags the read could not take", () => {
    expect(flagsNotRead(view(true), rb({ flagsRead: true, flagsUndecoded: [3, 7] }))).toBe("the read-back could not take the flags of object(s) 3, 7 from the device's com-object table");
  });
  test("refuses a read that does not say it took the flags", () => {
    expect(flagsNotRead(view(true), rb({}))).toBe("the read-back did not take the flags from the device's com-object table, although the product reads it");
  });
  test("passes a read that took every object's flags", () => {
    expect(flagsNotRead(view(true), rb({ flagsRead: true }))).toBeNull();
  });
});

test("flagsMoved names each object whose flags differ from the import, with the values that set them back", () => {
  const b = bench();
  b.project.flags.get("O-1")!.read = false;
  b.project.flags.get("O-1")!.update = true;
  return b.ctx.client.getConfig("p", "d").then((v) => {
    expect(flagsMoved(v, new Map([["O-0", { ...APP_FLAGS }], ["O-1", { ...APP_FLAGS }]]))).toEqual([{ refId: "O-1", set: { read: true, update: false } }]);
  });
});
