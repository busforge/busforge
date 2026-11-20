// Start, list and stop isolated UI instances: a Busforge server and a Vite dev server of this
// checkout on ports of their own, with an empty data directory, optionally with a project imported.
// The tool touches no bus; the server it starts is a full Busforge server (docs/testing.md, "An
// isolated UI instance"):
//
//   bun run tools/ui-instance.ts start [--project <file.knxproj> [--password-stdin] | --demo <name>]
//                                      [--port <server port>] [--web-port <web port>] [--stop-with <pid>]
//   bun run tools/ui-instance.ts status [--port <n>]
//   bun run tools/ui-instance.ts stop --port <n>
//
// Each instance lives in its own directory `busforge-ui-<server port>-*` under the system temp dir:
// `data/` (the server's data directory), the two logs and `instance.json`, which records the
// process groups the tool started. `stop` signals exactly those groups, after checking that each
// leader is still the process the tool started, and removes the directory. It never kills the
// server: a server still running after SIGTERM may be finishing a bus write (apps/server/src/shutdown.ts).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { corpusPath, corpusRoot, DEMO_PRODUCT_FILES, OPENKNX_DEMO_DIR } from "./corpus.ts";
import { apiCall, buildDemoProject, MANUFACTURER_DEMO, OPEN_DEMO, openKnxProductDbs, type DemoApi, type ProductDb } from "./demo-project.ts";
import { liveStat, PROC, processLives, signalZero } from "./process-state.ts";
import { droppedLinksDemo } from "./ui-demo-projects.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIR_PREFIX = "busforge-ui-";
// One deadline for the start up to the import. Measured: a start, import and stop take 0.7 s on an
// idle machine and up to 5.3 s while a full check runs; a start refused at the deadline and stopped
// (at most 20 s) ends within the test's 60 s. The import has no deadline (the open demo builds in up
// to a minute on a busy machine); a signal cancels it.
const START_TIMEOUT_MS = 30_000;
// Each request after the import, which a running server answers at once.
const REQUEST_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 15_000;
// Both are reached on 127.0.0.1: the server listens on every IPv4 address only, and `localhost` does
// not name one address everywhere (in the CI container Vite binds it as ::1 while fetch resolves it
// to 127.0.0.1), so Vite is told to listen on 127.0.0.1 too.
const HOST = "127.0.0.1";
const localUrl = (port: number) => `http://${HOST}:${port}`;

const DEMOS = {
  "dropped-links": "three devices whose import drops links: a dropped link per object, a device without application, a refused configuration",
  "dropped-links-many": "dropped-links with eight dropped links on the refused device, for a list that scrolls",
  openknx: "the open demo of docs/demo.md (OpenKNX release archives: from the corpus where BUSFORGE_CORPUS is set, else downloaded)",
  manufacturers: "the manufacturer demo of docs/demo.md (product databases from the private corpus; needs BUSFORGE_CORPUS)",
} as const;
type DemoName = keyof typeof DEMOS;

const USAGE = `usage:
  bun run tools/ui-instance.ts start [--project <file.knxproj> [--password-stdin] | --demo <name>] [--port <n>] [--web-port <n>] [--stop-with <pid>]
  bun run tools/ui-instance.ts status [--port <n>]
  bun run tools/ui-instance.ts stop --port <n>
  bun run tools/ui-instance.ts watch --owner <pid> --dir <instance dir>   (the watchdog --stop-with starts)
demos:
${Object.entries(DEMOS).map(([n, d]) => `  ${n.padEnd(19)} ${d}`).join("\n")}`;

export type Args =
  | { command: "start"; project: string | null; passwordStdin: boolean; demo: DemoName | null; port: number | null; webPort: number | null; stopWith: number | null }
  | { command: "status"; port: number | null }
  | { command: "stop"; port: number }
  | { command: "watch"; owner: number; dir: string };

const portOf = (flag: string, v: string): number => {
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) throw new Error(`${flag} must be a port number between 1 and 65535, got "${v}"\n${USAGE}`);
  return Number(v);
};

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (!f.startsWith("--") || flags.has(f)) throw new Error(`unexpected or repeated "${f}"\n${USAGE}`);
    if (f === "--password-stdin") { flags.set(f, true); continue; }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${f} needs a value\n${USAGE}`);
    flags.set(f, v);
    i++;
  }
  const allowed: Record<string, string[]> = {
    start: ["--project", "--password-stdin", "--demo", "--port", "--web-port", "--stop-with"],
    status: ["--port"],
    stop: ["--port"],
    watch: ["--owner", "--dir"],
  };
  if (!command || !(command in allowed)) throw new Error(USAGE);
  const unknown = [...flags.keys()].filter((f) => !allowed[command].includes(f));
  if (unknown.length) throw new Error(`${command} does not take ${unknown.join(", ")}\n${USAGE}`);
  const str = (f: string) => flags.get(f) as string | undefined;
  const pid = (f: string): number | null => {
    const v = str(f);
    if (v === undefined) return null;
    if (!/^[1-9]\d*$/.test(v)) throw new Error(`${f} must be a process id, got "${v}"\n${USAGE}`);
    return Number(v);
  };
  if (command === "watch") {
    const owner = pid("--owner");
    const dir = str("--dir");
    if (owner === null || dir === undefined) throw new Error(`watch needs --owner and --dir\n${USAGE}`);
    return { command: "watch", owner, dir: resolve(dir) };
  }
  const port = str("--port") === undefined ? null : portOf("--port", str("--port")!);
  if (command === "status") return { command: "status", port };
  if (command === "stop") {
    // No default: instances of other sessions live in the same temp dir.
    if (port === null) throw new Error(`stop needs --port, the server or web port of the instance (status lists them)\n${USAGE}`);
    return { command: "stop", port };
  }
  const project = str("--project") ?? null;
  const demo = str("--demo") ?? null;
  if (project !== null && demo !== null) throw new Error(`--project and --demo exclude each other\n${USAGE}`);
  if (demo !== null && !(demo in DEMOS)) throw new Error(`no demo named "${demo}"\n${USAGE}`);
  if (flags.has("--password-stdin") && project === null) throw new Error(`--password-stdin goes with --project\n${USAGE}`);
  const webPort = str("--web-port") === undefined ? null : portOf("--web-port", str("--web-port")!);
  if (port !== null && port === webPort) throw new Error(`--port and --web-port must differ\n${USAGE}`);
  const stopWith = pid("--stop-with");
  return {
    command: "start", project: project === null ? null : resolve(project), passwordStdin: flags.has("--password-stdin"),
    demo: demo as DemoName | null, port, webPort, stopWith,
  };
}

// A process the tool started: the leader of its own process group, and its start time (startTime),
// so a later stop can tell it from a process that took the same id afterwards.
interface Started { pid: number; startedAt: string }

interface Instance {
  dir: string;
  dataDir: string;
  serverPort: number;
  webPort: number;
  server: Started | null;
  web: Started | null;
  watchdog: Started | null;
  project: { id: string; name: string } | null;
}

// The start time of a living process, or null when there is none of that id. On macOS from `ps`, in
// one locale and zone, so a stop from another shell reads the same string. A living process whose
// start time cannot be read is refused: that tells neither whether it is the one started nor not.
// Linux reads /proc, since the CI container has no `ps`.
function startTime(pid: number): string | null {
  if (PROC) return liveStat(pid)?.start ?? null;
  if (!signalZero(pid)) return null;
  const t = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.toString().trim();
  if (t !== "") return t;
  if (!signalZero(pid)) return null;
  throw new Error(`ps reports no start time for the living process ${pid}, so whether it is the one started cannot be told; nothing more is stopped`);
}

// Whether a process group has a living member.
export function groupHasMembers(pgid: number): boolean {
  if (!PROC) return signalZero(-pgid);
  return readdirSync("/proc").some((n) => {
    if (!/^\d+$/.test(n)) return false;
    return liveStat(Number(n))?.pgrp === pgid;
  });
}

// Whether the group the tool started still has members. Its leader is checked first: alive with
// another start time means the id was taken again after the whole group ended (an id is not reused
// while a group of that id exists).
function groupAlive(p: Started): boolean {
  const t = startTime(p.pid);
  return t !== null ? t === p.startedAt : groupHasMembers(p.pid);
}

function save(inst: Instance): void {
  const tmp = join(inst.dir, "instance.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(inst, null, 2)}\n`);
  renameSync(tmp, join(inst.dir, "instance.json"));
}

const readInstance = (dir: string) => JSON.parse(readFileSync(join(dir, "instance.json"), "utf8")) as Instance;

// What the watchdog has taken over: the ids of the server and web groups of the record it last read.
const handoff = (inst: Instance) => `${inst.server?.pid ?? 0} ${inst.web?.pid ?? 0}`;
const ACK = "watchdog.ack";

// Wait until the watchdog holds the record just saved, so it can stop that group should the owner end
// and the directory go with it.
async function handedOver(inst: Instance, until: number, wanted: () => void): Promise<void> {
  if (inst.watchdog === null) return;
  const ack = join(inst.dir, ACK);
  while (!(existsSync(ack) && readFileSync(ack, "utf8") === handoff(inst))) {
    wanted();
    if (!groupAlive(inst.watchdog)) throw new Error("the watchdog ended");
    if (Date.now() > until) throw new Error(`the watchdog did not take over process groups ${handoff(inst)} within the start's ${START_TIMEOUT_MS / 1000} s`);
    await Bun.sleep(20);
  }
}

// The instances in the temp dir; one whose record cannot be read is named and left out.
function listInstances(): Instance[] {
  const base = tmpdir();
  return readdirSync(base)
    .filter((n) => n.startsWith(DIR_PREFIX) && existsSync(join(base, n, "instance.json")))
    .flatMap((n) => {
      try { return [readInstance(join(base, n))]; } catch (e) {
        console.error(`${join(base, n)}: instance.json unreadable (${e instanceof Error ? e.message : String(e)}), left out`);
        return [];
      }
    });
}

// Whether something answers on the port, or the port cannot be bound.
async function portTaken(port: number): Promise<boolean> {
  for (const hostname of ["127.0.0.1", "::1"]) {
    const answered = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 500);
      Bun.connect({ hostname, port, socket: { open(s) { clearTimeout(timer); s.end(); done(true); }, data() {}, connectError() { clearTimeout(timer); done(false); }, error() {} } })
        .catch(() => { clearTimeout(timer); done(false); });
    });
    if (answered) return true;
  }
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
    return false;
  } catch {
    return true;
  }
}

async function freePort(avoid: number[]): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const l = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
    const port = l.port;
    l.stop(true);
    if (!avoid.includes(port) && !(await portTaken(port))) return port;
  }
  throw new Error("found no free port in 20 tries");
}

function startGroup(cmd: string[], cwd: string, env: Record<string, string>, log: string): Started {
  const fd = openSync(log, "a");
  const child = spawn(cmd[0], cmd.slice(1), { cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${cmd.join(" ")} did not start`);
  // Without its start time no stop could tell the group from a later process of the same id, so a
  // group whose start time cannot be read is ended at once.
  const startedAt = (() => { try { return startTime(pid); } catch { return null; } })();
  if (startedAt === null) {
    signalGroup(pid, "SIGKILL");
    throw new Error(`no start time for process ${pid} (${cmd.join(" ")}); its group is killed`);
  }
  return { pid, startedAt };
}

// Wait for the line a process prints once it listens. Its own log, not a probe of the port, tells
// that it is this process and not another one that answers there.
// `failed`: a line the process prints when it cannot start and stays running.
async function waitForLine(p: Started, log: string, line: RegExp, failed: RegExp | null, what: string, wanted: () => void, until: number): Promise<void> {
  for (;;) {
    wanted();
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (line.test(text)) return;
    if (failed?.test(text)) throw new Error(`${what} failed to start; its log:\n${tail(text)}`);
    if (!groupAlive(p)) throw new Error(`${what} ended before it was ready; its log:\n${tail(text)}`);
    if (Date.now() > until) throw new Error(`${what} was not ready within the start's ${START_TIMEOUT_MS / 1000} s; its log:\n${tail(text)}`);
    await Bun.sleep(100);
  }
}

const tail = (text: string) => text.trimEnd().split("\n").slice(-20).map((l) => `  | ${l}`).join("\n");

async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");
}

type Load = (api: DemoApi) => Promise<{ id: string; name: string; note: string }>;

// The import of a .knxproj, with what it did not import beside the counts.
function importFile(name: string, bytes: Uint8Array<ArrayBuffer>, password: string | null): Load {
  return async (api) => {
    const form = new FormData();
    form.set("file", new File([bytes], name));
    if (password !== null) form.set("password", password);
    const r = await apiCall(api)<Record<string, unknown> & { id: string; name: string; deviceCount: number; gaCount: number }>("POST", "/api/projects/import", undefined, form);
    const gaps = Object.entries(r).filter(([k, v]) => !["id", "name", "deviceCount", "gaCount"].includes(k) && v !== 0 && v !== false && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : String(v)}`);
    return { id: r.id, name: r.name, note: `${r.deviceCount} devices, ${r.gaCount} group addresses${gaps.length ? `; not imported: ${gaps.join(", ")}` : ""}` };
  };
}

// What `start` imports, read before any process starts, so a missing file or corpus refuses first.
async function prepareLoad(a: Extract<Args, { command: "start" }>): Promise<Load | null> {
  if (a.project !== null) {
    if (!existsSync(a.project)) throw new Error(`${a.project} does not exist`);
    const password = a.passwordStdin ? await readStdin() : null;
    return importFile(basename(a.project), new Uint8Array(readFileSync(a.project)), password);
  }
  if (a.demo === null) return null;
  if (a.demo === "dropped-links" || a.demo === "dropped-links-many") {
    return importFile(`${a.demo}.knxproj`, new Uint8Array(droppedLinksDemo(a.demo === "dropped-links-many")), null);
  }
  const demo = a.demo === "openknx" ? OPEN_DEMO : MANUFACTURER_DEMO;
  const dbs: ProductDb[] = a.demo === "openknx"
    ? await openKnxProductDbs(corpusRoot() === null ? null : corpusPath(OPENKNX_DEMO_DIR))
    : DEMO_PRODUCT_FILES.map((f) => ({ name: basename(f), bytes: new Uint8Array(readFileSync(corpusPath(f))) }));
  return async (api) => {
    const s = await buildDemoProject(api, demo, dbs);
    return { id: s.projectId, name: s.name, note: `${s.devices.length} devices, ${s.groupAddresses} group addresses, ${s.links} linked objects` };
  };
}

// Signal a group; one that ended since it was checked needs no signal.
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
}

// Stop the groups of an instance and remove its directory. A group still alive keeps the directory.
// The process running this is skipped: that is the watchdog's own stop.
async function stopInstance(inst: Instance): Promise<string[]> {
  const said: string[] = [];
  const groups = ([["server", inst.server], ["web", inst.web], ["watchdog", inst.watchdog]] as [string, Started | null][])
    .filter((g): g is [string, Started] => g[1] !== null && g[1].pid !== process.pid);
  for (const [name, p] of groups) {
    const t = startTime(p.pid);
    if (t !== null && t !== p.startedAt) said.push(`${name}: process ${p.pid} is another process now, so its group has ended; not signalled`);
  }
  const alive = () => groups.filter(([, p]) => groupAlive(p));
  const settle = async (ms: number) => { const until = Date.now() + ms; while (alive().length && Date.now() < until) await Bun.sleep(100); };
  for (const [name, p] of alive()) {
    signalGroup(p.pid, "SIGTERM");
    said.push(`${name}: SIGTERM to process group ${p.pid}`);
  }
  await settle(STOP_TIMEOUT_MS);
  for (const [name, p] of alive().filter(([n]) => n !== "server")) {
    signalGroup(p.pid, "SIGKILL");
    said.push(`${name}: still running after ${STOP_TIMEOUT_MS / 1000} s, SIGKILL to process group ${p.pid}`);
  }
  await settle(5_000);
  const left = alive();
  if (left.length) {
    const server = left.some(([n]) => n === "server") ? "; a server may be finishing a bus write (its log says which), stop again once it has" : "";
    throw new Error(`${[...said, `${left.map(([n, p]) => `${n} (process group ${p.pid})`).join(", ")} still running${server}; ${inst.dir} is kept`].join("\n  ")}`);
  }
  if (!basename(inst.dir).startsWith(DIR_PREFIX) || resolve(inst.dir, "..") !== resolve(tmpdir())) throw new Error(`${inst.dir} is not an instance directory; not removed`);
  rmSync(inst.dir, { recursive: true, force: true });
  said.push(`removed ${inst.dir}`);
  return said;
}

async function start(a: Extract<Args, { command: "start" }>): Promise<void> {
  for (const p of [a.port, a.webPort]) {
    if (p !== null && await portTaken(p)) throw new Error(`port ${p} is taken (lsof -nP -iTCP:${p} -sTCP:LISTEN names the process)`);
  }
  if (a.stopWith !== null && startTime(a.stopWith) === null) throw new Error(`--stop-with ${a.stopWith}: no such process`);
  const load = await prepareLoad(a);
  const serverPort = a.port ?? await freePort([a.webPort ?? 0]);
  const webPort = a.webPort ?? await freePort([serverPort]);
  const dir = mkdtempSync(join(tmpdir(), `${DIR_PREFIX}${serverPort}-`));
  const inst: Instance = { dir, dataDir: join(dir, "data"), serverPort, webPort, server: null, web: null, watchdog: null, project: null };
  save(inst);
  // A Ctrl-C while starting would end the tool but not the detached groups. The signal stops the
  // start at its next step instead, and the refusal below stops what was started.
  // A signal also cancels a request under way (an import can take long).
  let signalled: NodeJS.Signals | null = null;
  const cancel = new AbortController();
  const abort = (sig: NodeJS.Signals) => { signalled = sig; cancel.abort(); };
  const until = Date.now() + START_TIMEOUT_MS;
  const wanted = () => { if (signalled) throw new Error(`${signalled} while starting`); };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, abort);
  try {
    if (a.stopWith !== null) {
      // Started first, so it covers the start too. It keeps the last record it read, so it can stop
      // the groups even after the instance directory is gone.
      inst.watchdog = startGroup([process.execPath, join(ROOT, "tools/ui-instance.ts"), "watch", "--owner", String(a.stopWith), "--dir", dir], ROOT, {}, "/dev/null");
      save(inst);
    }
    const serverLog = join(dir, "server.log");
    // `--watch` as `bun run dev:server`: a change to the server's code restarts it in place.
    inst.server = startGroup([process.execPath, "--watch", "src/index.ts"], join(ROOT, "apps/server"), { PORT: String(serverPort), BUSFORGE_DATA_DIR: inst.dataDir }, serverLog);
    save(inst);
    await handedOver(inst, until, wanted);
    wanted();
    await waitForLine(inst.server, serverLog, new RegExp(`Busforge server on http://localhost:${serverPort}\\b`),
      // The server's handlers keep it up after an uncaught error, so one before its ready line is a failed start.
      /UNCAUGHT EXCEPTION|UNHANDLED REJECTION/, "the server", wanted, until);

    const webLog = join(dir, "web.log");
    inst.web = startGroup([process.execPath, "run", "dev", "--host", HOST], join(ROOT, "apps/web"), {
      BUSFORGE_API: localUrl(serverPort), BUSFORGE_WEB: localUrl(webPort),
      // Plain text, so the ready line below matches whatever FORCE_COLOR says.
      NO_COLOR: "1",
    }, webLog);
    save(inst);
    await handedOver(inst, until, wanted);
    wanted();
    await waitForLine(inst.web, webLog, new RegExp(`Local:\\s+http://${HOST.replaceAll(".", "\\.")}:${webPort}/`), null, "the web dev server", wanted, until);

    const server = localUrl(serverPort);
    const web = localUrl(webPort);
    const via = (base: string, signal: () => AbortSignal): DemoApi => (path, init) => fetch(`${base}${path}`, { ...init, signal: signal() });
    const api = via(server, () => cancel.signal);
    let note = "";
    if (load) {
      const p = await load(api);
      inst.project = { id: p.id, name: p.name };
      note = p.note;
      save(inst);
      wanted();
    }
    // Vite's proxy reaches the API: through it the projects are the server's own.
    // Requests that check what the start made: cancelled by a signal or after their own time.
    const checked = () => AbortSignal.any([cancel.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const checkApi = via(server, checked);
    const direct = await apiCall(checkApi)<{ id: string }[]>("GET", "/api/projects");
    const proxied = await apiCall(via(web, checked))<{ id: string }[]>("GET", "/api/projects");
    if (JSON.stringify(direct.map((p) => p.id).sort()) !== JSON.stringify(proxied.map((p) => p.id).sort())) {
      throw new Error(`${web}/api/projects does not answer with this server's projects`);
    }
    const devices = inst.project
      ? (await apiCall(checkApi)<{ devices: { id: string; ia: string; name: string }[] }>("GET", `/api/projects/${inst.project.id}`)).devices
      : [];
    if (inst.watchdog && !groupAlive(inst.watchdog)) throw new Error("the watchdog ended");
    wanted();

    console.log(`instance: ${dir}`);
    console.log(`data directory: ${inst.dataDir}`);
    console.log(`server: ${server} (process group ${inst.server.pid}, log ${serverLog})`);
    console.log(`web: ${web} (process group ${inst.web.pid}, log ${webLog})`);
    if (inst.watchdog) console.log(`stops when process ${a.stopWith} ends (watchdog process group ${inst.watchdog.pid})`);
    if (inst.project) {
      console.log(`project: ${inst.project.id} ${inst.project.name} (${note})`);
      console.log(`  ${web}/projects/${inst.project.id}`);
      for (const d of devices) console.log(`device: ${d.id}  ${d.ia || "-"}  ${d.name}  ${web}/projects/${inst.project.id}/devices/${encodeURIComponent(d.id)}`);
    }
    console.log(`stop: bun run tools/ui-instance.ts stop --port ${serverPort}`);
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
    for (const line of await stopInstance(inst)) console.error(`  ${line}`);
    process.exit(signalled === null ? 1 : 128 + osConstants.signals[signalled]);
  } finally {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(sig, abort);
  }
}

// The watchdog of `--stop-with`: stops the instance once the owner has ended. It rereads the record,
// keeps the last one it read, for when the directory is removed with the owner, and acknowledges each
// new group (handedOver).
async function watch(owner: number, dir: string): Promise<void> {
  let inst = readInstance(dir);
  let acked = "";
  // A directory removed meanwhile ends neither: the record read last stays.
  const reread = () => {
    try {
      inst = readInstance(dir);
      if (handoff(inst) !== acked) {
        writeFileSync(join(dir, ACK), handoff(inst));
        acked = handoff(inst);
      }
    } catch {
      return;
    }
  };
  // A start time that cannot be read now (a `ps` that fails under load) is read again.
  const ownerStart = (): string | null | undefined => { try { return startTime(owner); } catch { return undefined; } };
  let ownerStarted = ownerStart();
  while (ownerStarted === undefined) { await Bun.sleep(1000); ownerStarted = ownerStart(); }
  // `ps` is a process of its own on macOS, so the start time is compared once a second only.
  const ownerLives = (tick: number) => {
    if (tick % 10 !== 0) { try { return processLives(owner); } catch { return true; } }
    const t = ownerStart();
    return t === undefined || t === ownerStarted;
  };
  for (let tick = 0; ownerStarted !== null && ownerLives(tick); tick++) {
    reread();
    await Bun.sleep(100);
  }
  reread();
  // A server still finishing a bus write refuses the stop; it is tried again for ten minutes.
  for (let attempt = 1; ; attempt++) {
    try {
      for (const line of await stopInstance(inst)) console.log(line);
      return;
    } catch (e) {
      if (attempt === 40) throw e;
      await Bun.sleep(15_000);
    }
  }
}

function describe(inst: Instance): string {
  const state = (p: Started | null) => (p === null ? "not started" : `process group ${p.pid} ${groupAlive(p) ? "running" : "gone"}`);
  return [
    `${inst.dir}`,
    `  server: ${localUrl(inst.serverPort)} (${state(inst.server)})`,
    `  web: ${localUrl(inst.webPort)} (${state(inst.web)})`,
    ...(inst.watchdog ? [`  watchdog: ${state(inst.watchdog)}`] : []),
    `  project: ${inst.project ? `${inst.project.id} ${inst.project.name}` : "none"}`,
  ].join("\n");
}

const byPort = (port: number) => listInstances().filter((i) => i.serverPort === port || i.webPort === port);

if (import.meta.main) {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  try {
    if (args.command === "start") {
      await start(args);
    } else if (args.command === "watch") {
      await watch(args.owner, args.dir);
    } else if (args.command === "status") {
      const found = args.port === null ? listInstances() : byPort(args.port);
      if (!found.length) {
        console.log(args.port === null ? "no instances" : `no instance on port ${args.port}`);
        if (args.port !== null) process.exit(1);
      }
      for (const i of found) console.log(describe(i));
    } else {
      const found = byPort(args.port);
      if (found.length !== 1) throw new Error(found.length ? `${found.length} instances use port ${args.port}: ${found.map((i) => i.dir).join(", ")}` : `no instance on port ${args.port}`);
      for (const line of await stopInstance(found[0])) console.log(line);
    }
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
