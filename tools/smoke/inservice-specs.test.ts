import { expect, mock, afterAll, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnxDevice } from "../../packages/knx/src/index.ts";
import { buildAbsoluteSegmentTargets, buildRelativeSegmentTarget, classify, classifyByMask, parseAppConfig, type AppConfig, type DeviceReadbackInfo } from "../../packages/product/src/index.ts";
import { getDeviceModules, getDeviceParams } from "../../apps/server/src/db/deviceparams.ts";
import { CollectedUnit, asDevice, type Collection } from "../../packages/product/test/collected-unit.ts";
import { catalogueXml, corpusPath, inServiceCollection, IN_SERVICE_COLLECTIONS } from "../corpus.ts";
import { corpusDescribe } from "../corpus-test.ts";
import { runInService, planInService, type InServiceIo, type InServiceOptions } from "./inservice.ts";
import { Client, type FlashResult, type ConfigView } from "./client.ts";
import type { DeviceSpec } from "./spec.ts";
import { SPECS } from "./specs/index.ts";

// Every registered device-in-service spec, run against the real server routes and the real read and
// write paths of its family, on its unit emulated from a read-only collection taken before any write
// of a smoke run (packages/product/test/collected-unit.ts). Only the bus session is replaced: every
// profile call reaches the emulated unit instead of a tunnel. What this shows: the run's sequence
// passes the server's guards and refusals and leaves the unit's memory as it found it. What it does
// not: that the device acts on the bytes (behaviour), or that it keeps them (the emulated restart
// keeps everything).
const real = await import("../../apps/server/src/deviceprofile.ts");
const realRead = real.readDeviceState;
const realReadOn = real.readStateOn;
const realParamFlash = real.flashDeviceParameters;
const realGaFlash = real.flashDeviceGroupAddresses;
const realStructure = real.flashDeviceStructure;
const realDownload = real.downloadDeviceFull;

// The unit the profile calls reach while a run goes; without one every call is the real one, so a
// leaked mock behaves as the module does.
let unit: CollectedUnit | null = null;
const backups = (projectId: string) => () => `/data/projects/${projectId}/backups/backup.json`;
const onUnit = <O, R>(realFn: (o: O) => Promise<R>, run: (dev: KnxDevice, mask: string, o: O) => Promise<R>) =>
  (o: O): Promise<R> => (unit ? run(asDevice(unit), unit.mask, o) : realFn(o));
const profileOf = (o: { appXml: string }) => classify(parseAppConfig(o.appXml));
await mock.module("../../apps/server/src/deviceprofile.ts", () => ({
  ...real,
  readDeviceState: onUnit(realRead, (dev, mask, o) => realReadOn(dev, mask, o)),
  flashDeviceParameters: onUnit(realParamFlash, (dev, mask, o) => profileOf(o).flashParameters(dev, mask, { ...o, persistBackups: backups(o.projectId) })),
  flashDeviceGroupAddresses: onUnit(realGaFlash, (dev, mask, o) => profileOf(o).flashGroupTables(dev, mask, { ...o, persistBackups: backups(o.projectId) })),
  flashDeviceStructure: onUnit(realStructure, (dev, mask, o) => profileOf(o).flashStructure(dev, mask, { ...o, persistBackups: backups(o.projectId) })),
  downloadDeviceFull: onUnit(realDownload, (dev, mask, o) => profileOf(o).downloadFull(dev, mask, { ...o, persistBackups: backups(o.projectId) })),
}));
// app.ts after the mock, so its routes bind the wrappers.
const { handleApi, createState } = await import("../../apps/server/src/app.ts");
type AppState = ReturnType<typeof createState>;
afterAll(() => { unit = null; });

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

// The application of a spec, as the catalogue holds it: the appRef names its hardware-program pair.
const appOf = (spec: DeviceSpec) => spec.device.appRef.replace(/_H-.*_HP-/, "_A-");
const IN_SERVICE = SPECS.filter((s) => s.provision === "in-service");

test("every registered device-in-service spec has its unit emulated here, or is named as not emulable", () => {
  expect(IN_SERVICE.map((s) => s.id).filter((id) => !(IN_SERVICE_COLLECTIONS as readonly string[]).includes(id))).toEqual([...NOT_EMULATED.keys()]);
});

corpusDescribe("the device-in-service specs, against the server and their emulated units", () => {
  const fixtures = join(import.meta.dir, "..", "..", "packages", "project", "test", "fixtures");
  const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
  const call = async <T>(state: AppState, method: string, path: string, body?: unknown): Promise<T> => {
    const res = (await handleApi(req(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), state))!;
    const json = (await res.json()) as T & { error?: { code: string; message: string } };
    if (!res.ok) throw Object.assign(new Error(json.error?.message ?? String(res.status)), { code: json.error?.code });
    return json;
  };

  // fetch, for the duration of `fn`, answered by `state`'s routes.
  const withServer = async <T>(state: AppState, fn: () => Promise<T>): Promise<T> => {
    const fetchWas = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => (await handleApi(new Request(input instanceof Request ? input : String(input), init), state))!) as typeof fetch;
    try { return await fn(); } finally { globalThis.fetch = fetchWas; }
  };

  // A project holding the unit as the runner places it: the application's defaults, nothing linked,
  // never programmed from this project. The demo project's device is turned into it.
  async function placed(spec: DeviceSpec, xml: string): Promise<{ state: AppState; pid: string; did: string }> {
    const dir = mkdtempSync(join(tmpdir(), "busforge-inservice-server-"));
    tmps.push(dir);
    const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
    const form = new FormData();
    form.set("file", new File([readFileSync(join(fixtures, "sample-config.knxproj"))], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    const pid = ((await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as { id: string }).id;
    const did = (await call<{ devices: { id: string }[] }>(state, "GET", `/api/projects/${pid}`)).devices[0].id;
    state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [xml, "M-TEST_A-1"]);
    for (const t of ["device_parameters", "device_param_base", "device_links", "device_link_base", "device_modules"]) state.db.run(`DELETE FROM ${t} WHERE project_id = ? AND device_id = ?`, [pid, did]);
    // A placed unit's project holds no group address of the installation: the demo's go.
    for (const t of ["device_links", "device_link_base", "group_addresses", "group_ranges"]) state.db.run(`DELETE FROM ${t} WHERE project_id = ?`, [pid]);
    state.db.run("UPDATE devices SET never_programmed = 1, link_base_gaps = 0 WHERE project_id = ? AND instance_id = ?", [pid, did]);
    await call(state, "PUT", `/api/projects/${pid}/devices/${encodeURIComponent(did)}/address`, { ia: spec.device.ia });
    const conn = await call<{ id: string }>(state, "POST", "/api/connections", { type: "ip", name: "GW", host: "198.51.100.10", port: 3671 });
    await call(state, "PUT", `/api/projects/${pid}/connection`, { connectionId: conn.id });
    await call(state, "PUT", `/api/projects/${pid}/devices/${encodeURIComponent(did)}/untested-ack`);
    return { state, pid, did };
  }

  // The run's view of the server, as runner.ts builds it for the api channel, over handleApi; a write
  // answers 202 with its task, whose end is polled.
  function io(state: AppState, pid: string, did: string, dev: CollectedUnit, cfg: AppConfig, log: string[], answer: string): InServiceIo {
    const d = `/api/projects/${pid}/devices/${encodeURIComponent(did)}`;
    const wait = async (path: string): Promise<FlashResult> => {
      const task = await call<{ id: string }>(state, "POST", path);
      for (;;) {
        await new Promise((r) => setTimeout(r, 20));
        const t = await call<{ state: string; result: FlashResult; error: string | null; errorCode: string | null }>(state, "GET", `/api/projects/${pid}/tasks/${task.id}`);
        if (t.state === "done" || (t.errorCode === "FLASH_UNVERIFIED" && t.result)) { log.push(path.split("/").pop()!); return t.result; }
        if (t.state !== "queued" && t.state !== "running") throw Object.assign(new Error(t.error ?? t.state), { code: t.errorCode });
      }
    };
    const readBack = async (assume?: { paramRefId: string; value: string }[]) => (await call<{ readback?: DeviceReadbackInfo }>(state, "POST", `${d}/read-back`, { lang: "de", ...(assume ? { assume } : {}) })).readback ?? null;
    // The runner's own client, its requests answered by this server.
    const ensureGa = (ga: string) => withServer(state, () => new Client("http://x").ensureGa(pid, ga));
    const gaRaw = (ga: string) => { const [M, m, s] = ga.split("/").map(Number); return (M << 11) | (m << 8) | s; };
    const written = (r: FlashResult) => ({ structural: r.structural === true, result: r });
    return {
      api: {
        readBack,
        revert: () => call(state, "POST", `${d}/revert`, { lang: "de" }),
        getConfig: () => call<ConfigView>(state, "GET", `${d}/config?lang=de`),
        setParam: (paramRefId, value) => call(state, "PUT", `${d}/params`, { paramRefId, value, lang: "de" }),
        ensureGa,
        setLinks: (comObjRefId, gaRaws) => call(state, "PUT", `${d}/links`, { comObjRefId, gaRaws, lang: "de" }),
        flashDry: () => call<FlashResult>(state, "POST", `${d}/flash?dry=1`),
        flashGaDry: () => call<FlashResult>(state, "POST", `${d}/flash-ga?dry=1`),
        downloadDry: () => call<FlashResult>(state, "POST", `${d}/download?dry=1`),
        flashReal: () => wait(`${d}/flash`),
        flashGaReal: () => wait(`${d}/flash-ga`),
      },
      chan: {
        name: "api",
        setParam: async (paramRefId, value) => { await call(state, "PUT", `${d}/params`, { paramRefId, value, lang: "de" }); },
        link: async (obj, ga) => { await ensureGa(ga); await call(state, "PUT", `${d}/links`, { comObjRefId: obj.refId, gaRaws: [gaRaw(ga)], lang: "de" }); },
        addLink: async (obj, ga, own) => { await ensureGa(ga); await call(state, "PUT", `${d}/links`, { comObjRefId: obj.refId, gaRaws: [...own, gaRaw(ga)], lang: "de" }); },
        flashParams: async () => written(await wait(`${d}/flash`)),
        flashLinks: async () => written(await wait(`${d}/flash-ga`)),
        fullDownload: async () => written(await wait(`${d}/download`)),
        readBack,
      },
      bus: {
        readProperty: (object, pidNo) => dev.propReadIfPresent(object, pidNo),
        // The emulated witness answers when the unit's own tables, decoded by the real read, associate
        // the address with an object, with the value the spec expects (else 00): what an emulator can
        // show, nothing about the device's behaviour.
        groupRead: async (ga) => ((await classify(cfg).readState(asDevice(dev), dev.mask, { liveParams: new Map() })).links.some((l) => l.gaRaws.includes(gaRaw(ga))) ? answer : null),
        listen: async () => null,
        reboot: async () => {
          const states = () => new Map([1, 2, 3, 4].map((o) => [o, dev.loadState(o) as number | null]));
          const before = states();
          await dev.restart();
          log.push("restart");
          return { reboot: { rebooted: true, detail: "emulated restart" }, before, after: states() };
        },
      },
      log: () => undefined,
      settle: async () => undefined,
    };
  }

  const OPTS: InServiceOptions = { fullDownload: false, testGa: "15/7/250" };
  const run = async (spec: DeviceSpec, opts = OPTS) => {
    const xml = catalogueXml(`${appOf(spec)}.xml.gz`);
    const { state, pid, did } = await placed(spec, xml);
    const dev = new CollectedUnit(JSON.parse(readFileSync(corpusPath(inServiceCollection(spec.id)), "utf8")) as Collection);
    const memory = new Map(dev.mem);
    const log: string[] = [];
    unit = dev;
    try { return { r: await runInService(spec, io(state, pid, did, dev, parseAppConfig(xml), log, spec.behaviours.flatMap((b) => (b.kind === "output" && b.expectValue ? [b.expectValue] : []))[0] ?? "00"), opts), log, dev, memory, state, pid, did }; }
    finally { unit = null; }
  };
  const writes = (spec: DeviceSpec, opts: InServiceOptions) => planInService(spec, opts).filter((p) => p.kind !== "read").map((p) => (p.kind === "restart" ? "restart" : ({ flashParams: "flash", structuralFlash: "flash", flashLinks: "flash-ga", fullDownload: "download" } as const)[p.op!]));

  // The bytes behind a System 7 unit's address and association tables that a link added and removed
  // again may leave, as ETS's group-address downloads leave them (docs/load-procedures.md, the table
  // residues): two entries behind each table's counted end. Every other byte must be as found.
  const residues = async (dev: CollectedUnit): Promise<Set<number>> => {
    const out = new Set<number>();
    if (classifyByMask(dev.mask).family !== "system-7") return out;
    for (const obj of [1, 2]) {
      const base = await dev.tableAddr(obj);
      const end = base + 1 + 2 * (await dev.memRead(base, 1))[0];
      for (let i = 0; i < 4; i++) out.add(end + i);
    }
    return out;
  };

  // What a run may leave different from the unit as found, by address, as the bits allowed to differ.
  // The bits of a constant parameter (constantParams: a download marker) holding the constant: a
  // download writes it and the real unit clears it once it has seen the download, the emulated one
  // keeps it. On a System B application that declares DownloadInvisibleParameters="None", the bits a
  // step's configuration owns and the final one does not, holding the step's value: a parameter a step activated keeps, once
  // the step is reverted, the value the step wrote, since neither ETS nor Busforge writes an inactive
  // one (docs/load-procedures.md, R14).
  const allowedDifferences = async (spec: DeviceSpec, dev: CollectedUnit, cfg: AppConfig, state: AppState, pid: string, did: string): Promise<Map<number, number>> => {
    const values = getDeviceParams(state.db, pid, did), moduleInstances = getDeviceModules(state.db, pid, did);
    const steps = [spec.inService!.param, spec.inService!.structural].flatMap((s) => (s ? [new Map(values).set(s.paramRefId, s.value)] : []));
    const out = new Map<number, number>();
    const allow = (at: number, bits: number) => { if (bits) out.set(at, (out.get(at) ?? 0) | bits); };
    if (classifyByMask(dev.mask).family === "system-b") {
      const build = (v: Map<string, string>) => buildRelativeSegmentTarget(cfg, v, 4, { moduleInstances, ownIdleUnionDefaults: true })!;
      const final = build(values), base = await dev.tableAddr(4);
      final.constant.forEach((c, i) => allow(base + i, ((dev.mem.get(base + i)! ^ final.bytes[i]) & c) === 0 ? c : 0));
      if (cfg.downloadInvisibleParameters === "None") for (const t of steps.map(build)) t.owned.forEach((own, i) => allow(base + i, own & ~final.owned[i] & ~(dev.mem.get(base + i)! ^ t.bytes[i])));
    } else {
      for (const t of buildAbsoluteSegmentTargets(cfg, values, { moduleInstances })) {
        t.constant.forEach((c, i) => allow(t.address + i, ((dev.mem.get(t.address + i)! ^ t.bytes[i]) & c) === 0 ? c : 0));
      }
    }
    return out;
  };

  test("an assumed value the unit cannot tell from another is taken and named: the DALI gateway's ECG groups", async () => {
    const spec = IN_SERVICE.find((s) => s.id === "theben-dali-gateway-in-service")!;
    const { r } = await run(spec);
    expect(r.found?.unprovenAssumptions).toEqual(spec.inService!.assumeParams!.map((a) => a.paramRefId));
    // Another assigned group in place of the unit's goes through the same way, named the same.
    const wrong: DeviceSpec = { ...spec, inService: { ...spec.inService!, assumeParams: spec.inService!.assumeParams!.map((a, i) => (i === 0 ? { ...a, value: a.value === "5" ? "4" : "5" } : a)) } };
    const w = await run(wrong);
    expect(w.r.ok).toBe(true);
    expect(w.r.found?.unprovenAssumptions?.[0]).toBe(spec.inService!.assumeParams![0].paramRefId);
  }, 240_000);

  for (const spec of IN_SERVICE.filter((s) => !NOT_EMULATED.has(s.id) && !STOPS_BEFORE_A_WRITE.has(s.id))) {
    test(`${spec.id}: the run makes the writes its plan lists, passes, and leaves the unit's memory as it found it`, async () => {
      const { r, log, dev, memory, state, pid, did } = await run(spec);
      // One comparison, so a failing run shows every part that failed.
      expect({ stopped: r.stopped, failed: r.capabilities.filter((c) => c.state === "fail"), behaviours: r.behaviours.filter((b) => b.state !== "pass"), persistence: r.persistence?.state, restore: r.restore?.state })
        .toEqual({ stopped: undefined, failed: [], behaviours: [], persistence: r.persistence ? "pass" : undefined, restore: "pass" });
      expect(r.ok).toBe(true);
      expect(log).toEqual(writes(spec, OPTS));
      const behind = await residues(dev);
      const allowed = await allowedDifferences(spec, dev, parseAppConfig(catalogueXml(`${appOf(spec)}.xml.gz`)), state, pid, did);
      expect([...memory].filter(([a, b]) => ((dev.mem.get(a)! ^ b) & ~(allowed.get(a) ?? 0)) !== 0 && !behind.has(a)).map(([a, b]) => `0x${a.toString(16)}: ${b.toString(16)} -> ${dev.mem.get(a)?.toString(16)}`)).toEqual([]);
    }, 120_000);
  }

  // A spec that a product gap keeps from taking its unit over: the run must stop where the gap shows,
  // before any write, and pass once the gap is closed (then the entry goes).
  for (const [id, gap] of STOPS_BEFORE_A_WRITE) {
    const spec = IN_SERVICE.find((s) => s.id === id)!;
    test(`${id}: the run stops before its first write, because ${gap.reason}`, async () => {
      const { r, log, dev, memory } = await run(spec);
      expect(r.stopped?.phase).toBe("adopt");
      expect(r.stopped?.detail).toContain(gap.stop);
      expect(log).toEqual([]);
      expect([...memory].filter(([a, b]) => dev.mem.get(a) !== b)).toEqual([]);
    }, 120_000);
  }
});

const IMAGE = "READBACK_ASSUMPTION_IMAGE_DIFFERS";
const STOPS_BEFORE_A_WRITE = new Map<string, { stop: string; reason: string }>([
  ["theben-hmg6t-in-service", { stop: IMAGE, reason: "the read-back does not read the com-object table, so read flags the unit's project sets are not taken over and a GA dry run finds them to write" }],
]);

// Specs whose unit cannot be emulated, with the reason.
const NOT_EMULATED = new Map<string, string>([
  ["openknx-raumcontroller-in-service", "its collection read none of the unit's memory (no table or application segment), and its application is not in the corpus catalogue"],
]);
