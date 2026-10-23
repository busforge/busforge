import { expect, mock, afterAll, describe, test, setDefaultTimeout } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnxDevice } from "../../packages/knx/src/index.ts";
import { buildAbsoluteSegmentTargets, buildRelativeSegmentTarget, classify, classifyByMask, parseAppConfig, type AppConfig, type DeviceReadbackInfo, type DiagnosticPackage } from "../../packages/product/src/index.ts";
import { getDeviceModules, getDeviceParams } from "../../apps/server/src/db/deviceparams.ts";
import { CollectedUnit, asDevice, type Collection } from "../../packages/product/test/collected-unit.ts";
import { captureText, catalogueXml, corpusPath, inServiceCollection, IN_SERVICE_COLLECTIONS } from "../corpus.ts";
import { iaToNum } from "../../packages/knx/src/index.ts";
import { memoryImage, parseCapture } from "../etsdiff.ts";
import { corpusDescribe } from "../corpus-test.ts";
import { runInService, planInService, memorySnapshot, type InServiceIo, type InServiceOptions } from "./inservice.ts";
import { Client, type FlashResult, type ConfigView } from "./client.ts";
import type { DeviceSpec } from "./spec.ts";
import { SPECS } from "./specs/index.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 58.8 s with the
// file alone (load 5-27) and up to 58.9 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(1180_000);

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

test("every spec whose hidden parameters take the installation project's values has those values here", () => {
  expect(IN_SERVICE.filter((s) => s.inService?.hiddenValuesFromProject).map((s) => s.id).sort()).toEqual([...INSTALLATION_VALUES.keys()].sort());
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
  // A spec whose hidden parameters take the installation project's values gets them as the import of
  // that project file holds them, live and baseline alike, on a unit ETS downloaded.
  async function placed(spec: DeviceSpec, xml: string, projectValues?: Map<string, string>): Promise<{ state: AppState; pid: string; did: string }> {
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
    state.db.run("UPDATE devices SET never_programmed = ?, link_base_gaps = 0 WHERE project_id = ? AND instance_id = ?", [projectValues ? 0 : 1, pid, did]);
    for (const [refId, value] of projectValues ?? []) for (const t of ["device_parameters", "device_param_base"]) state.db.run(`INSERT INTO ${t} (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)`, [pid, did, refId, value]);
    await call(state, "PUT", `/api/projects/${pid}/devices/${encodeURIComponent(did)}/address`, { ia: spec.device.ia });
    const conn = await call<{ id: string }>(state, "POST", "/api/connections", { type: "ip", name: "GW", host: "198.51.100.10", port: 3671 });
    await call(state, "PUT", `/api/projects/${pid}/connection`, { connectionId: conn.id });
    await call(state, "PUT", `/api/projects/${pid}/devices/${encodeURIComponent(did)}/untested-ack`);
    return { state, pid, did };
  }

  // The run's view of the server, as runner.ts builds it for the api channel, over handleApi; a write,
  // a dry run and a read-back answer 202 with their task, whose end is polled.
  // A weather station's guard, read from addresses no emulated unit uses, answered calm (wind 2 m/s,
  // every bit 0) by the emulated witness: the guard's reads go through the run, the weather is not emulated.
  const CALM_GUARD = "wind:31/7/240:9,rain:31/7/241,wind alarm:31/7/242";
  const CALM = new Map([["31/7/240", "00c8"], ["31/7/241", "00"], ["31/7/242", "00"]]);

  function io(state: AppState, pid: string, did: string, dev: CollectedUnit, collection: { records: DiagnosticPackage["records"] }, cfg: AppConfig, log: string[], answer: string): InServiceIo {
    const d = `/api/projects/${pid}/devices/${encodeURIComponent(did)}`;
    // `writes`: the operation is a write the run's log lists.
    const settle = async <T>(path: string, writes: boolean, body?: unknown): Promise<T> => {
      const task = await call<{ id: string }>(state, "POST", path, body);
      for (;;) {
        await new Promise((r) => setTimeout(r, 20));
        const t = await call<{ state: string; result: T; error: string | null; errorCode: string | null }>(state, "GET", `/api/projects/${pid}/tasks/${task.id}`);
        if (t.state === "done" || (t.errorCode === "FLASH_UNVERIFIED" && t.result)) { if (writes) log.push(path.split("/").pop()!); return t.result; }
        if (t.state !== "queued" && t.state !== "running") throw Object.assign(new Error(t.error ?? t.state), { code: t.errorCode });
      }
    };
    const wait = (path: string) => settle<FlashResult>(path, true);
    const readBack = (assume?: { paramRefId: string; value: string }[], compareHidden?: boolean) => settle<DeviceReadbackInfo | null>(`${d}/read-back`, false, { ...(assume ? { assume } : {}), ...(compareHidden ? { compareHidden } : {}) });
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
        hasGa: (ga) => withServer(state, () => new Client("http://x").hasGa(pid, ga)),
        setGaPlain: async (ga) => { await call(state, "PATCH", `/api/projects/${pid}/group-addresses/${gaRaw(ga)}`, { security: "off" }); },
        setLinks: (comObjRefId, gaRaws) => call(state, "PUT", `${d}/links`, { comObjRefId, gaRaws, lang: "de" }),
        flashDry: () => settle<FlashResult>(`${d}/flash?dry=1`, false),
        flashGaDry: () => settle<FlashResult>(`${d}/flash-ga?dry=1`, false),
        downloadDry: () => settle<FlashResult>(`${d}/download?dry=1`, false),
        flashReal: () => wait(`${d}/flash`),
        flashGaReal: () => wait(`${d}/flash-ga`),
        // The unit's collection with each memory record's bytes as the emulated unit holds them now, taken as
        // a collection of the server: the same records, gaps and refusals, read again over the same ranges
        // (a System B table the real collector would locate anew by its pointer and memory control block).
        memory: async () => memorySnapshot({ ...collection, error: null, records: collection.records.map((r) => (r.outcome === "bytes" && r.space.startsWith("memory") && typeof r.target.address === "number" && r.bytes ? { ...r, bytes: Buffer.from(Array.from({ length: r.bytes.length / 2 }, (_, i) => dev.mem.get((r.target.address as number) + i)!)).toString("hex") } : r)) } as unknown as DiagnosticPackage),
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
        readMemory: (address, length) => dev.memRead(address, length),
        // No interface stands between the emulated unit and the run.
        route: async () => ({ interfaceIa: "none, emulated", interfaceSerial: null, tunnelIa: "none" }),
        // The emulated witness answers when the unit's own tables, decoded by the real read, associate
        // the address with an object, with the value the spec expects (else 00): what an emulator can
        // show, nothing about the device's behaviour.
        groupRead: async (ga) => ((await classify(cfg).readState(asDevice(dev), dev.mask, { liveParams: new Map() })).links.some((l) => l.gaRaws.includes(gaRaw(ga))) ? answer : null),
        // An object answers a read of any of its addresses on its first association (findings.md §36).
        groupReadAnsweredOn: async (readGa, ownGas) => {
          const calm = CALM.get(readGa);
          if (calm !== undefined) return { value: calm, unattributable: false };
          const links = (await classify(cfg).readState(asDevice(dev), dev.mask, { liveParams: new Map() })).links;
          const holder = links.find((l) => l.gaRaws.includes(gaRaw(readGa)));
          return { value: holder && holder.gaRaws[0] === gaRaw(ownGas[0]) ? answer : null, unattributable: false };
        },
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
  // The operator's options a spec needs besides the given ones: the weather guard, and the installation's
  // project file, which the emulated run holds as its values (INSTALLATION_VALUES).
  const optsFor = (spec: DeviceSpec, given: InServiceOptions): InServiceOptions => ({
    ...given,
    ...(spec.inService?.weatherGuard ? { weatherGuard: CALM_GUARD } : {}),
    ...(spec.inService?.hiddenValuesFromProject ? { knxproj: "installation.knxproj" } : {}),
  });
  const installationValues = (spec: DeviceSpec) => {
    const file = INSTALLATION_VALUES.get(spec.id);
    return file ? new Map((JSON.parse(captureText(file)) as { params: [string, string][] }).params) : undefined;
  };
  // `edit` changes, before the run, the project's values and the emulated unit's memory.
  type Edit = { values?: (v: Map<string, string>) => void; memory?: (m: Map<number, number>) => void };
  const run = async (spec: DeviceSpec, given = OPTS, edit: Edit = {}) => {
    const opts = optsFor(spec, given);
    const xml = catalogueXml(`${appOf(spec)}.xml.gz`);
    const values = spec.inService?.hiddenValuesFromProject ? installationValues(spec) : undefined;
    if (values) edit.values?.(values);
    const { state, pid, did } = await placed(spec, xml, values);
    const collection = JSON.parse(readFileSync(corpusPath(inServiceCollection(spec.id)), "utf8")) as Collection & { records: DiagnosticPackage["records"] };
    const dev = new CollectedUnit(collection);
    edit.memory?.(dev.mem);
    const memory = new Map(dev.mem);
    const log: string[] = [];
    // The unit's memory after each parameter write the run makes, with whether it went out structural.
    const after: { structural: boolean; memory: Map<number, number> }[] = [];
    unit = dev;
    try {
      const ioOf = io(state, pid, did, dev, collection, parseAppConfig(xml), log, spec.behaviours.flatMap((b) => (b.kind === "output" && b.expectValue ? [b.expectValue] : []))[0] ?? "00");
      const chan = ioOf.chan;
      ioOf.chan = { ...chan, flashParams: async () => { const o = await chan.flashParams(); after.push({ structural: o.structural, memory: new Map(dev.mem) }); return o; } };
      return { r: await runInService(spec, ioOf, opts), log, dev, memory, state, pid, did, after };
    }
    finally { unit = null; }
  };
  const writes = (spec: DeviceSpec, opts: InServiceOptions) => planInService(spec, optsFor(spec, opts)).filter((p) => p.kind !== "read").map((p) => (p.kind === "restart" ? "restart" : ({ flashParams: "flash", structuralFlash: "flash", flashLinks: "flash-ga", fullDownload: "download" } as const)[p.op!]));

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
  }, 1180_000);

  test("theben-dali-gateway-in-service: with --full-download the run also downloads the configuration found and leaves the unit's memory as it found it", async () => {
    const spec = IN_SERVICE.find((s) => s.id === "theben-dali-gateway-in-service")!;
    const full: InServiceOptions = { ...OPTS, fullDownload: true };
    const { r, log, dev, memory, state, pid, did } = await run(spec, full);
    expect({ stopped: r.stopped, failed: r.capabilities.filter((c) => c.state === "fail"), fullDownload: r.capabilities.find((c) => c.capability === "fullDownload")?.state, behaviours: r.behaviours.filter((b) => b.state !== "pass"), persistence: r.persistence?.state, restore: r.restore?.state })
      .toEqual({ stopped: undefined, failed: [], fullDownload: "pass", behaviours: [], persistence: "pass", restore: "pass" });
    expect(r.ok).toBe(true);
    expect(log).toEqual(writes(spec, full));
    const allowed = await allowedDifferences(spec, dev, parseAppConfig(catalogueXml(`${appOf(spec)}.xml.gz`)), state, pid, did);
    expect([...memory].filter(([a, b]) => ((dev.mem.get(a)! ^ b) & ~(allowed.get(a) ?? 0)) !== 0).map(([a, b]) => `0x${a.toString(16)}: ${b.toString(16)} -> ${dev.mem.get(a)?.toString(16)}`)).toEqual([]);
  }, 890_000);

  // Without Logic 3's internal input (memoryless, 4 in the installation's ETS project) the configuration taken
  // over hides the logic's setting at 0x4616, which the unit holds as 01; the full download writes the
  // segment's <Data> 00 there, and every read-back and dry run after it compares the project with itself.
  // Only the unit's memory against the backup read before the first write shows it.
  test("mdt-be06001-in-service: a full download that changes a byte the configuration taken over hides fails the restore, naming the byte", async () => {
    const base = IN_SERVICE.find((s) => s.id === "mdt-be06001-in-service")!;
    const s = base.inService!;
    const spec: DeviceSpec = {
      ...base,
      inService: { ...s, assumeParams: s.assumeParams!.filter((a) => !a.paramRefId.endsWith("_MD-3_M-51_MI-1_P-46_R-64")), param: undefined, link: undefined, structural: undefined },
      behaviours: [],
      unsafe: ["flashParams", "flashLinks", "structuralFlash"].map((capability) => ({ capability, reason: "this test runs the full download alone" })),
    };
    const full: InServiceOptions = { ...OPTS, fullDownload: true };
    const { r, log, dev, memory } = await run(spec, full);
    expect(log).toEqual(writes(spec, full));
    expect([memory.get(0x4616), dev.mem.get(0x4616)]).toEqual([0x01, 0x00]);
    expect(r.capabilities.find((c) => c.capability === "fullDownload")?.state).toBe("pass");
    expect(r.restore?.state).toBe("fail");
    expect(r.restore?.detail).toContain("0x4616: 01 before the run, 00 after it");
    expect(r.ok).toBe(false);
  }, 1180_000);

  // The Meteodata's structural step switches threshold channel C14 on and off again, while the unit holds the
  // channel's parameters at the segment's <Data>. ETS's partial downloads of the same change from the
  // installation's project write the project's values of the channel (tools/etsdiff.test.ts); its writes,
  // read and compared, are the bytes that differed on the unit.
  describe("theben-meteodata-140s-in-service: the parameters the unit hides take the installation project's values", () => {
    const spec = IN_SERVICE.find((s) => s.id === "theben-meteodata-140s-in-service")!;
    const cfg = parseAppConfig(catalogueXml(`${appOf(spec)}.xml.gz`));
    const ia = iaToNum(spec.device.ia);
    const etsWrites = (f: string) => memoryImage(parseCapture(captureText(f), ia).writes);
    // The parameter segments and the com-object table, without the download marker at 0x4800 (a
    // constant parameter the real unit clears once it has seen a download).
    const comObj = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
    const compared = [comObj, ...cfg.absoluteSegments.filter((x) => x.address >= 0x4800)].flatMap((x) => Array.from({ length: x.size }, (_, i) => x.address + i)).filter((a) => a !== 0x4800);
    const differing = (got: Map<number, number>, want: (a: number) => number | undefined) =>
      compared.filter((a) => got.get(a) !== want(a)).map((a) => `0x${a.toString(16)}: ${want(a)?.toString(16)} wanted, ${got.get(a)?.toString(16)} held`);
    const C14 = "M-0048_A-140C-14-EB70_P-6571_R-6571";

    test("switching C14 on writes ETS's bytes, the project's values of the channel included; off returns to the unit as found", async () => {
      const { r, memory, after } = await run(spec);
      expect(r.stopped).toBeUndefined();
      expect(r.ok).toBe(true);
      const [on, off] = after.filter((a) => a.structural).map((a) => a.memory);
      const ets = etsWrites("meteodata-140s-ets-partial-c14-on.log");
      expect(differing(on, (a) => ets.get(a) ?? memory.get(a))).toEqual([]);
      // The channel's texts, telegram type and thresholds as 94 pins them, and object 84's type byte.
      expect(Array.from({ length: 13 }, (_, i) => on.get(0x49f0 + i))).toEqual([0x32, 0x30, 0x2c, 0x30, 0x00, 0x31, 0x2c, 0x30, 0x00, 0x00, 0xba, 0x65, 0xa1]);
      expect(on.get(0x4556)).toBe(0x08);
      expect(differing(off, (a) => memory.get(a))).toEqual([]);
    }, 1180_000);

    test("a project value of a parameter the unit shows that differs from the unit's is refused before any write", async () => {
      const { r, log } = await run(spec, OPTS, { values: (v) => v.set("M-0048_A-140C-14-EB70_P-2234_R-2234", "3") });
      expect(r.stopped?.phase).toBe("adopt");
      expect(r.stopped?.detail).toContain("the configuration found is not the installation project's");
      expect(r.stopped?.detail).toContain("P-2234_R-2234 project 3, unit 0");
      expect(log).toEqual([]);
    }, 1180_000);

    test("a project that shows the channel the unit hides is refused before any write", async () => {
      const { r, log } = await run(spec, OPTS, { values: (v) => v.set(C14, "1") });
      expect(r.stopped?.phase).toBe("adopt");
      expect(r.stopped?.detail).toContain("the configuration found is not the installation project's");
      expect(log).toEqual([]);
    }, 1180_000);

    // The dry runs compare only the bits the configuration places; the revert of C14 would write the <Data> over this one.
    test("a unit that holds other bytes than the segment's <Data> at a hidden parameter is refused before any write", async () => {
      const { r, log } = await run(spec, OPTS, { memory: (m) => m.set(0x49f5, m.get(0x49f5)! ^ 0x01) });
      expect(r.stopped?.phase).toBe("adopt");
      expect(r.stopped?.detail).toContain("at parameters its configuration hides the unit holds other bytes than the segment's <Data> (0x49F5)");
      expect(log).toEqual([]);
    }, 1180_000);
  });

  for (const spec of IN_SERVICE.filter((s) => !NOT_EMULATED.has(s.id) && !STOPS_BEFORE_A_WRITE.has(s.id))) {
    test(`${spec.id}: the run makes the writes its plan lists, passes, and leaves the unit's memory as it found it`, async () => {
      const opts = RESTORED_BY_FULL_DOWNLOAD.has(spec.id) ? { ...OPTS, fullDownload: true } : OPTS;
      const { r, log, dev, memory, state, pid, did } = await run(spec, opts);
      // One comparison, so a failing run shows every part that failed.
      expect({ stopped: r.stopped, failed: r.capabilities.filter((c) => c.state === "fail"), behaviours: r.behaviours.filter((b) => b.state !== "pass"), persistence: r.persistence?.state, restore: r.restore?.state })
        .toEqual({ stopped: undefined, failed: [], behaviours: [], persistence: r.persistence ? "pass" : undefined, restore: "pass" });
      expect(r.ok).toBe(true);
      expect(log).toEqual(writes(spec, opts));
      const behind = await residues(dev);
      const allowed = await allowedDifferences(spec, dev, parseAppConfig(catalogueXml(`${appOf(spec)}.xml.gz`)), state, pid, did);
      expect([...memory].filter(([a, b]) => ((dev.mem.get(a)! ^ b) & ~(allowed.get(a) ?? 0)) !== 0 && !behind.has(a)).map(([a, b]) => `0x${a.toString(16)}: ${b.toString(16)} -> ${dev.mem.get(a)?.toString(16)}`)).toEqual([]);
    }, 650_000);
  }

  // Without the full download a MIX 2 unit keeps, at the parameter its structural step showed and the revert
  // hides again, the value the step wrote (docs/load-procedures.md R14), and the restore names that byte.
  for (const [id, left] of RESTORED_BY_FULL_DOWNLOAD) {
    test(`${id}: without the full download the restore fails on the byte the structural step leaves, named`, async () => {
      const { r } = await run(IN_SERVICE.find((x) => x.id === id)!);
      expect(r.stopped).toBeUndefined();
      expect(r.restore?.state).toBe("fail");
      expect(r.restore?.detail).toContain(`the unit's memory differs from the backup read before the first write in 1 byte(s): ${left}`);
    }, 650_000);
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

const STOPS_BEFORE_A_WRITE = new Map<string, { stop: string; reason: string }>();

// The specs whose run leaves the unit's memory as found only with its full download: a MIX 2 unit's
// structural step shows a parameter the revert hides again, which keeps the step's value (docs/load-procedures.md
// R14) until the full download writes the segment's fill there. Each with the byte the run leaves without it.
const RESTORED_BY_FULL_DOWNLOAD = new Map<string, string>([
  ["theben-hmg6t-in-service", "0x3E7C: 00 before the run, 0a after it"],
  ["theben-jmg4t-in-service", "0x3CD3: 00 before the run, cb after it"],
  ["theben-rmg8t-in-service", "0x40CC: 00 before the run, 0a after it"],
]);

// The values the installation's ETS project holds for a spec's unit (hiddenValuesFromProject), as the
// private corpus captures them from that project's export: its ParameterInstanceRef values.
const INSTALLATION_VALUES = new Map<string, string>([
  ["theben-meteodata-140s-in-service", "meteodata-140s-config.json"],
]);

// Specs whose unit cannot be emulated, with the reason.
const NOT_EMULATED = new Map<string, string>([
  ["openknx-raumcontroller-in-service", "its collection read none of the unit's memory (no table or application segment), and its application is not in the corpus catalogue"],
  ["mdt-ip-router-in-service", "its secured collection read the association table only as far as its count, where the read-back reads the table further, and no collection reads the security object (object type 17), which its GA flash and that flash's dry run compare"],
  ["mdt-ip-secure-in-service", "its download reads and writes the KNXnet/IP parameter object (the MAC address, the friendly name, the tunnelling addresses), which no collection of the unit read, and takes its KNXnet/IP settings from the installation's project file"],
]);
