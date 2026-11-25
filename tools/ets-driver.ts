#!/usr/bin/env bun
// ETS 6 on the bench host's display, driven from this machine over ssh, for one sweep row (tools/ets-sweep.ts):
// ETS downloads one application into a simulated unit (tools/sim-unit-serve.ts) served from this machine.
//
//   BUSFORGE_CORPUS=... bun run tools/ets-driver.ts row <unit> <variant> --order <order number> \
//     [--simulator <this host's ip>:3701] [--project "Busforge Sweep"] [--password-env <VAR>] [--configured] \
//     [--out <dir>] [--stop-sim-after <frames>] [--wrong-interface <host:port>] [--sim-override <object>/<PID>=<hex>]... \
//     [--donor <unit>] [--learned-from <ETS6.log>]...       (the last two for an application without an own unit)
//   BUSFORGE_CORPUS=... bun run tools/ets-driver.ts same <ets.log> <ets.log> <unit> [<from>]   two runs, frame by frame
//   BUSFORGE_CORPUS=... bun run tools/ets-driver.ts rerun-identity <row dir> <unit>       the identity loop
//   bun run tools/ets-driver.ts import <project.knxproj> [--password-env <VAR>]   into ETS (as a copy where it
//                                                                                    holds the project); prints its name
//   bun run tools/ets-driver.ts delete <project name>                             a project `import` brought in
//   bun run tools/ets-driver.ts catalogue-download [--batch <rows>] [--from <row>] [--out <dir>]
//                                     the online catalogue's product data into ETS's product store (downloadCatalogue)
//   HA_TOKEN=... BUSFORGE_CORPUS=... bun run tools/ets-driver.ts batch <catalogue-list.json> --out <dir> \
//     [--only <file of application ids>] [--from <application>] [--count <rows>] [--rerun-failed] [--rerun <application>]... \
//     [--simulator <ip>:<port>] [--project <name>] [--inject-kill <application>] [--inject-dialog <application>]
//                                     the list's rows one after the other, unattended (runBatch, tools/ets-batch.ts)
//   bun run tools/ets-driver.ts up | down | shot <png> | words [<png>] | xdo <args>... | type <text>
//
// THE ROW (runRow). On the bench host ETS runs maximised on the display, German UI, in its own project (no
// password; --project). <unit> is an own unit (tools/sim-units.ts) or the id of an application without one, whose
// catalogue unit (tools/sim-unit-catalogue.ts) borrows the donor its mask's rule picks. From scratch (the default):
// line 1.1 of the project is emptied and the project compressed (ETS's "Jetzt komprimieren", which deletes the product
// data no device uses, so the row's export holds its own product only: checked on the export's entries), the product
// is inserted from the online catalogue by order number (every catalogue row the search lists read in ETS's
// properties panel: the one whose device type, version and fingerprint are the application's; several rows of one
// application under the order number are one application), its address set to the unit's. A catalogue unit's
// application program is read from an export of the project taken right after the insert. --configured instead takes
// the device the project holds at the unit's address as it is configured there. Then the interface is set explicitly to the
// simulator's configured connection in the toolbar (its check mark read back), the application download is
// started by its shortcut, the driver waits for ETS6.log's end of the load task or the exception that ended
// it, exports the project and writes the row (--out, by default under the system's temporary directory; a
// row goes into the corpus once its explained.json is written): row.json, configuration.json (the device's
// configuration in ETS's export), ets.log and ets.log.sim.txt (the simulator; ets.log.serve.txt its output),
// ets6.log.txt (ETS6.log from the row's start), export.knxproj.
//
// Every row is judged by ETS6.log (etsOutcome): a download that connected to anything but the simulator is
// driver-failed. A row the driver cannot finish gets driver-failed.txt first, then a full-resolution
// screenshot, the ETS6.log tail and the simulator's log; dialogs in ETS's window are closed (cancelling where
// they offer it), otherwise ETS is restarted: only the processes `up` started, each known by PID and start time.
//
// Between the steps of a row the driver checks that ETS's window is there and shows no dialog: a dialog it does not
// expect fails the row (UNKNOWN_DIALOG, with its text and a full-resolution screenshot), a window that is gone fails it
// as ETS gone.
//
// THE BATCH (runBatch). The rows of the catalogue list (tools/ets-catalogue.ts) in its order, each written as a row is
// under <out>/<application>/defaults/ with batch-result.json beside it (tools/ets-batch.ts: resume, failure classes,
// batch.log). Before it starts, the bench host must be kept awake: Home Assistant's switch.x390_wach on (HA_TOKEN; the
// host sleeps in the evening without it). Before each row ETS is up and in its layout (its project open, no dialog).
// A failure of a row is classified (classifyFailure): ETS gone or one of its internal errors restarts ETS and runs the
// row once more; an unknown dialog ends the row driver-failed with its screenshot and closes the dialog (or restarts
// ETS); a bench host that does not answer, a KNX-ID login ETS asks for, an online catalogue that does not answer or an
// ETS that cannot be started or brought back pauses the batch: it ends early (exit 3) and the row runs again on resume. A catalogue unit's row that ETS fails on
// a `Required data mismatch` runs again with what ETS required (the identity loop, learnIdentity), at most
// IDENTITY_ROUNDS times. A hardware whose second program is no PEI program is refused (no row of the list has one).
// --inject-kill and --inject-dialog kill ETS, or open its project details dialog, in that application's row once the
// project is compressed, before the insert: they exist to show the runner's recovery on a real run.
//
// --stop-sim-after <n> stops the simulator once ETS sent it n frames (a download ETS aborts); --wrong-interface
// selects another configured connection than the simulator's: both exist to check the verdicts on real logs.
// --sim-override gives the simulator a wrong identity (tools/sim-unit-serve.ts --override), which ETS refuses with
// the properties it required in ETS6.log; rerun-identity reads them (tools/sim-unit-product.ts).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { numToIa } from "../packages/knx/src/index.ts";
import { extractAppPrograms, loadKnxproj, readAppProgram } from "../packages/project/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { catalogueXml } from "./corpus.ts";
import { deviceConfiguration, deviceRows, dialogue, dialogueDifferences } from "./etsdiff.ts";
import { appendLog, BATCH_LOG, batchRows, CATALOGUE_LIST_FORMAT, classifyFailure, clearRowDir, heartbeatLine, loggedRows, moveAttempt, planBatch, RESULT_FORMAT, rowDirOf, rowLine, summary, UNKNOWN_DIALOG, VARIANT, writeResult, type Attempt, type FailureClass, type RowKind, type RowResult } from "./ets-batch.ts";
import type { CatalogueList, Row as ListRow } from "./ets-catalogue.ts";
import { reduceProjectExport } from "./ets-export-reduce.ts";
import { ETS_TASK_FAILED, etsOutcome, ROW_FILES, ROW_FORMAT, simRefusals, type EtsOutcome, type RowConfiguration, type RowSpec } from "./ets-sweep.ts";
import { catalogueUnit, catalogueUnitFrom, catalogueUnitRecord, learnIdentity, type CatalogueUnitSpec } from "./sim-unit-catalogue.ts";
import { productUnit, rerunIdentity } from "./sim-unit-product.ts";
import { newSimUnit, SIM_UNITS, simUnitSpec } from "./sim-units.ts";

const HOST = process.env.ETS_HOST ?? "tf@192.168.1.231";
const DISPLAY = ":5";
const ETS_BUILD = "ETS 6.4.1 Home (6.4.8718)";

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Each step of a row on stderr, with the time: what a run that stalls was doing (and what a batch's heartbeat names).
let currentStep = "";
const step = (what: string) => { currentStep = what; console.error(`${new Date().toISOString().slice(11, 19)} ${what}`); };

// ---- the bench host ----

// One ssh call: `command` as ssh's command line, `input` on its stdin; its stdout.
export function ssh(command: string, input: string | Buffer, opts: { timeoutMs?: number; allowFail?: boolean } = {}): Buffer {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST, command], { input, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`on ${HOST} (${r.status}): ${r.stderr.toString().trim()}\n${command === "bash -s" ? input.toString() : command}`);
  return r.stdout;
}
// A shell script on the bench host; its stdout.
const remote = (script: string, opts: { timeoutMs?: number; allowFail?: boolean } = {}) => ssh("bash -s", script, opts).toString();

// Where things are on the bench host: ETS's Wine prefix, its data (catalogue, product and project stores) and its log, the driver's state (the PIDs it started,
// the exports; Wine's Z: is the host's root).
interface HostPaths { prefix: string; data: string; etsLog: string; state: string; exportDir: string; exportDirWin: string }
let hostPaths: HostPaths | null = null;
export function host(): HostPaths {
  if (hostPaths) return hostPaths;
  const [home, user] = remote(`printf '%s\\n%s' "$HOME" "$(id -un)"`).split("\n");
  const prefix = `${home}/ets/prefix`, state = `${home}/ets/sweep-driver`;
  hostPaths = { prefix, data: `${prefix}/drive_c/ProgramData/KNX/ETS6`, etsLog: `${prefix}/drive_c/users/${user}/AppData/Local/KNX/ETS6/Log`, state, exportDir: `${state}/export`, exportDirWin: `Z:${state.replaceAll("/", "\\")}\\export` };
  return hostPaths;
}

// One xdotool invocation on the display (several commands chained in it keep a transient menu open).
function xdo(...args: string[]): string { return remote(`DISPLAY=${DISPLAY} xdotool ${args.map(q).join(" ")}`); }
// Types text into the focused field; xdotool reads it from stdin, so nothing after it is taken as text.
function typeText(text: string): void { ssh(`DISPLAY=${DISPLAY} xdotool type --delay 40 --file -`, text); }
function key(...keys: string[]): void { xdo("key", "--delay", "150", ...keys); }
function click(x: number, y: number): void { xdo("mousemove", "--sync", String(x), String(y), "sleep", "0.2", "click", "1"); }

// A full-resolution screenshot of the display, written to `png` here (coordinates 1:1 with xdotool's).
function shot(png: string): string {
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png, ssh(`DISPLAY=${DISPLAY} import -window root png:-`, ""));
  return png;
}

// ---- reading the screen ----

interface Word { text: string; x: number; y: number; w: number; h: number; line: string }
interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number; text: string }
interface Region { x: number; y: number; w: number; h: number }

const crop = (r: Region) => ["-crop", `${r.w}x${r.h}+${r.x}+${r.y}`, "+repage"];

// One number ImageMagick computes over a region of a screenshot (`ops` end in the -format that prints it).
function measure(png: string, r: Region, ops: string[]): number {
  return Number(execFileSync("magick", [png, ...crop(r), ...ops, "info:"], { encoding: "utf8" }).trim());
}

// ETS's 11-12 px UI text reads reliably only enlarged: tesseract runs on a copy at `scale`. Sparse text
// (psm 11) suits a screen; a label/value table reads cleaner as a block (psm 6), a dialog's button bar as one
// line (psm 7), where sparse text loses its light grey buttons. A region ETS's search highlights in yellow reads
// only in grey (`prep` "gray"), a selected row's blue text on its blue only in black and white ("binary").
const OCR_SCALE = 2;
type Prep = "gray" | "binary";
const PREP: Record<Prep, string[]> = { gray: ["-colorspace", "Gray"], binary: ["-colorspace", "Gray", "-threshold", "75%"] };
function tesseract(png: string, region: Region | undefined, scale: number, psm: number, tsv: boolean, prep?: Prep): string {
  const big = join(dirname(png), `.${basename(png, ".png")}-ocr.png`);
  execFileSync("magick", [png, ...(region ? crop(region) : []), "-resize", `${scale * 100}%`, ...(prep ? PREP[prep] : []), big]);
  // Leptonica fails to open some absolute paths on macOS (/tmp through its symlink): read it by name from its directory.
  const out = execFileSync("tesseract", [basename(big), "-", "--psm", String(psm), ...(tsv ? ["tsv"] : [])], { cwd: dirname(big), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  rmSync(big, { force: true });
  return out;
}

// The words OCR reads, each with its box (scaled back to the screen) and the id of its OCR line.
function words(png: string, region?: Region, opts: { scale?: number; psm?: number; prep?: Prep } = {}): Word[] {
  const scale = opts.scale ?? OCR_SCALE;
  const ox = region?.x ?? 0, oy = region?.y ?? 0, s = (v: string) => Math.round(+v / scale);
  return tesseract(png, region, scale, opts.psm ?? 11, true, opts.prep).split("\n").slice(1).flatMap((row) => {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5" || !c[11].trim()) return [];
    return [{ text: c[11].trim(), x: ox + s(c[6]), y: oy + s(c[7]), w: s(c[8]), h: s(c[9]), line: `${c[2]}.${c[3]}.${c[4]}` }];
  });
}

// The text of a region read as one block, line by line.
function textLines(png: string, region: Region, scale = OCR_SCALE): string[] {
  return tesseract(png, region, scale, 6, false).split("\n").map((l) => l.trim()).filter(Boolean);
}

// OCR reads umlauts unreliably ("hinzufiigen"); words are compared without them.
const norm = (s: string) => s.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: "a", ö: "o", ü: "u", ß: "ss" })[c] ?? c).replace(/[^a-z0-9.:$()/-]/g, "");

// Where a phrase stands: consecutive words of one OCR line, each phrase word a prefix of the word read.
function findText(ws: Word[], phrase: string): Box[] {
  const want = phrase.split(/\s+/).map(norm);
  const out: Box[] = [];
  for (let i = 0; i + want.length <= ws.length; i++) {
    const run = ws.slice(i, i + want.length);
    if (run.some((w) => w.line !== run[0].line)) continue;
    if (!run.every((w, k) => want[k].length > 0 && norm(w.text).startsWith(want[k]))) continue;
    const x = run[0].x, y = Math.min(...run.map((w) => w.y));
    const r = Math.max(...run.map((w) => w.x + w.w)), b = Math.max(...run.map((w) => w.y + w.h));
    out.push({ x, y, w: r - x, h: b - y, cx: Math.round((x + r) / 2), cy: Math.round((y + b) / 2), text: run.map((w) => w.text).join(" ") });
  }
  return out;
}

// The words of a screen grouped into rows by their vertical centre (OCR's own lines split table cells).
function rows(ws: Word[], tolerance = 5): { y: number; words: Word[]; text: string }[] {
  const sorted = [...ws].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const out: { y: number; words: Word[]; text: string }[] = [];
  for (const w of sorted) {
    const cy = w.y + w.h / 2;
    const row = out.find((r) => Math.abs(r.y - cy) <= tolerance);
    if (row) row.words.push(w); else out.push({ y: cy, words: [w], text: "" });
  }
  for (const r of out) { r.words.sort((a, b) => a.x - b.x); r.text = r.words.map((w) => w.text).join(" "); }
  return out;
}

const inside = (r: Region) => (w: Region) => w.x >= r.x && w.y >= r.y && w.x + w.w <= r.x + r.w && w.y + w.h <= r.y + r.h;

// How green the greenest pixel of a box is: green over both red and blue (ETS's check mark 0.36 measured; grey
// text, the blue panel icons and the yellow interface icons stay at or near 0).
const greenness = (png: string, r: Region) => measure(png, r, ["-fx", "min(g-r,g-b)", "-format", "%[fx:maxima]"]);

// ---- a failure the driver names ----

class DriverFailure extends Error {}
const fail = (why: string): never => { throw new DriverFailure(why); };

// ---- the screen of one row ----

class Screen {
  private n = 0;
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  // A fresh screenshot.
  snap(): string { return shot(join(this.dir, `.screen-${this.n++ % 2}.png`)); }
  // A fresh screenshot and its words.
  look(region?: Region, prep?: Prep): { png: string; ws: Word[] } {
    const png = this.snap();
    return { png, ws: words(png, region, { prep }) };
  }
  async waitText(phrase: string, region: Region | undefined, timeoutMs: number, what: string): Promise<Box> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const { ws } = this.look(region);
      const hit = findText(ws, phrase)[0];
      if (hit) return hit;
      if (Date.now() > until) return fail(`${what}: "${phrase}" did not appear within ${timeoutMs / 1000} s`);
      await sleep(1500);
    }
  }
  // The first word `test` accepts in `region`, looked for until `timeoutMs`.
  async waitWord(test: (w: Word) => boolean, region: Region, timeoutMs: number, what: string): Promise<Word> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.look(region).ws.find(test);
      if (hit) return hit;
      if (Date.now() > until) return fail(`${what} did not appear within ${timeoutMs / 1000} s`);
      await sleep(1500);
    }
  }
  clean(): void { for (const f of readdirSync(this.dir)) if (f.startsWith(".screen-")) rmSync(join(this.dir, f), { force: true }); }
}

// Fixed places of ETS 6.4.1 maximised on the 1920x1200 display, read off its screen; each step reads back what
// it changed before the next one relies on it.
const AT = {
  overviewTab: [100, 20], projectTab: [300, 20], projectTabText: { x: 205, y: 4, w: 170, h: 30 },
  // The overview's project search, and with it filtered: the one row it lists, its Export and its menu, and the
  // count of the projects it lists.
  projectSearch: [300, 64], overviewHome: [33, 64], searchedRow: [294, 162], searchedExport: [1450, 192], searchedMenu: [1510, 192],
  searchedCount: { x: 1590, y: 222, w: 270, h: 26 }, searchedName: { x: 230, y: 150, w: 570, h: 24 },
  panelSelector: [262, 93], toolbarInterface: [1716, 57], gridSearch: [1460, 92],
  leftTree: { x: 0, y: 105, w: 315, h: 525 }, mainTabs: { x: 315, y: 80, w: 500, h: 28 },
  mainGrid: { x: 315, y: 108, w: 1255, h: 515 }, catalogueGrid: { x: 315, y: 695, w: 1255, h: 465 },
  properties: { x: 1575, y: 80, w: 345, h: 600 }, menuRight: { x: 1500, y: 70, w: 420, h: 300 },
  bottomBar: { x: 0, y: 1165, w: 1570, h: 35 },
  // The project toolbar's info button: the project's details dialog (its size, "Jetzt komprimieren").
  projectInfo: [1747, 57],
} as const;

// ---- ETS's log ----

// The bench host's clock in ETS6.log's format, to cut the log at.
function etsClock(): string { return remote(`date '+%Y-%m-%d %H:%M:%S'`).trim(); }

// A shell pipeline that prints ETS6.log (`files`, in order) from `since` on, byte for byte (Latin-1).
const etsLogCut = (since: string, files: string) =>
  `cd ${q(host().etsLog)} && cat ${files} | LC_ALL=C awk -v s=${q(since)} '/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] / { p = (substr($0, 1, 19) >= s) } p'`;

// ETS6.log from `since` on (the rotated file before it too), copied to `to`.
function etsLogSince(since: string, to: string): void {
  writeFileSync(to, ssh("bash -s", etsLogCut(since, "$(ls -r ETS6.log.1 ETS6.log 2>/dev/null)")));
}

// Whether ETS6.log holds a line with `needle` from `since` on (and, where given, matching `pattern` too).
function etsLogHas(since: string, needle: string, pattern?: RegExp): boolean {
  const lines = ssh("bash -s", `${etsLogCut(since, "ETS6.log")} | grep -a -F ${q(needle)} || true`).toString("latin1");
  return lines.split("\n").some((l) => l.includes(needle) && (!pattern || pattern.test(l)));
}

// ---- processes on the bench host: only those `up` started, each by PID and start time ----

// A shell function: the start time of a process (field 22 of its stat, counted after its name).
const START = `st() { [ -r /proc/$1/stat ] && sed 's/.*) //' /proc/$1/stat | awk '{print $20}'; }`;

interface Owned { name: string; pid: number; start: string }

// The processes a state file names that still run as the ones started (same PID, same start time).
function owned(file: string): Owned[] {
  const out = remote(`${START}; f=${q(`${host().state}/${file}`)}; [ -r "$f" ] || exit 0
while read -r n p t; do [ -n "$t" ] && [ "$(st "$p")" = "$t" ] && echo "$n $p $t"; done < "$f"; true`);
  return out.split("\n").filter(Boolean).map((l) => { const [name, pid, start] = l.split(" "); return { name, pid: Number(pid), start }; });
}

function signal(ps: Owned[], sig: "TERM" | "KILL"): void {
  if (ps.length) remote(`${START}; ${ps.map((p) => `[ "$(st ${p.pid})" = ${q(p.start)} ] && kill -${sig} ${p.pid}`).join("; ")}; true`);
}

async function stopOwned(file: string): Promise<void> {
  signal(owned(file), "TERM");
  for (let i = 0; i < 20 && owned(file).length; i++) await sleep(1000);
  signal(owned(file), "KILL");
  remote(`rm -f ${q(`${host().state}/${file}`)}`);
}

// Starts what is not running: Xvfb, openbox and x11vnc (localhost:5905, password) on the display, then ETS;
// records each process it started with its start time. Refuses a display or an ETS it did not start.
async function up(): Promise<void> {
  const h = host();
  remote(`mkdir -p ${q(h.exportDir)}`);
  if (owned("display.pids").length === 0) {
    if (remote(`pgrep -f ${q(`^Xvfb ${DISPLAY}( |$)`)} || true`).trim()) fail(`another Xvfb serves ${DISPLAY}: not started by this driver, so not used`);
    remote(`${START}; cd ${q(h.state)}
setsid nohup Xvfb ${DISPLAY} -screen 0 1920x1200x24 -nolisten tcp > xvfb.log 2>&1 < /dev/null & echo "xvfb $! $(st $!)" > display.pids; sleep 2
DISPLAY=${DISPLAY} setsid nohup openbox > openbox.log 2>&1 < /dev/null & echo "openbox $! $(st $!)" >> display.pids; sleep 1
setsid nohup env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE x11vnc -display ${DISPLAY} -localhost -forever -shared -rfbauth "$HOME/.vnc/passwd" -rfbport 5905 > vnc.log 2>&1 < /dev/null & echo "x11vnc $! $(st $!)" >> display.pids; sleep 1`);
  }
  const ours = owned("ets.pids");
  const running = remote(`pgrep -f 'ETS6\\.exe' || true`).split("\n").filter(Boolean).map(Number);
  if (running.some((p) => !ours.some((o) => o.pid === p))) fail("an ETS this driver did not start runs on the bench host");
  if (ours.some((p) => p.name.startsWith("ETS6"))) return;
  remote(`cd ${q(h.state)}; ps -e -o pid= | tr -d ' ' | sort > wine-before.txt
WINEPREFIX=${q(h.prefix)} DISPLAY=${DISPLAY} setsid nohup wine 'C:\\Program Files (x86)\\ETS6\\ETS6N.exe' > ets-run.log 2>&1 < /dev/null &`);
  for (let i = 0; i < 90; i++) {
    if (remote(`DISPLAY=${DISPLAY} xdotool search --name '^ETS6 - ' 2>/dev/null || true`).trim()) break;
    await sleep(2000);
  }
  await sleep(5000);
  // ETS's processes are those that appeared since, run in its Wine prefix on this display, and are ETS or the
  // Wine desktop it opened.
  remote(`${START}; cd ${q(h.state)}; ps -e -o pid= | tr -d ' ' | sort > wine-after.txt
for p in $(comm -13 wine-before.txt wine-after.txt); do
  e=/proc/$p/environ; [ -r "$e" ] || continue
  tr '\\0' '\\n' < "$e" | grep -qx ${q(`WINEPREFIX=${h.prefix}`)} || continue
  tr '\\0' '\\n' < "$e" | grep -qx 'DISPLAY=${DISPLAY}' || continue
  n=$(ps -o comm= -p "$p"); case "$n" in ETS6*|explorer.exe) echo "$n $p $(st "$p")";; esac
done > ets.pids`);
  if (!owned("ets.pids").some((p) => p.name.startsWith("ETS6"))) fail("ETS did not start: no ETS6 process in its prefix after the launcher");
}

// Closes ETS (its window, then its processes) and stops the display, both only as far as `up` started them.
async function down(): Promise<void> {
  if (owned("ets.pids").some((p) => p.name.startsWith("ETS6"))) {
    remote(`DISPLAY=${DISPLAY} xdotool search --name '^ETS6 - ' windowclose 2>/dev/null || true`, { allowFail: true });
    for (let i = 0; i < 30 && owned("ets.pids").some((p) => p.name.startsWith("ETS6")); i++) await sleep(1000);
  }
  await stopOwned("ets.pids");
  await stopOwned("display.pids");
}

// ETS stopped (what of it `up` started and still runs) and started again; an ETS this driver did not start is
// refused by `up`, so is one that crashed without ever being this driver's.
async function restartEts(): Promise<void> {
  if (!owned("ets.pids").length && !remote(`f=${q(`${host().state}/ets.pids`)}; [ -s "$f" ] && echo yes || true`).trim()) fail("ETS needs a restart, but this driver did not start it");
  await stopOwned("ets.pids");
  await up();
}

// ---- ETS, step by step ----

// ETS's window title names the tab in front: "ETS6 - Übersicht" or "ETS6 - <project>".
function etsTitle(): string {
  return remote(`DISPLAY=${DISPLAY} xdotool search --name '^ETS6 - ' getwindowname %@ 2>/dev/null | head -1 || true`).trim();
}

// The project open in its tab, in front: opened from the overview where it is not (its password, where it
// has one, from the environment variable `passwordEnv`). Another open project is refused, not closed.
async function openProject(s: Screen, name: string, passwordEnv?: string): Promise<void> {
  const want = `ETS6 - ${name}`;
  // The overview's project search puts its term into the title too: a project is open where its tab stands.
  if (projectTabOpen(s)) {
    click(AT.projectTab[0], AT.projectTab[1]);
    await sleep(1500);
    if (etsTitle() !== want) fail(`ETS has another project open (${etsTitle() || "no ETS window"}); close it first`);
    await closeExtraProjectTabs(s, name);
    return;
  }
  await searchProject(s, name);
  click(AT.searchedRow[0], AT.searchedRow[1]);
  if (passwordEnv) {
    const pw = process.env[passwordEnv] ?? fail(`the project's password is not in $${passwordEnv}`);
    await s.waitText("Passwort", undefined, 20_000, "the project's password dialog");
    typeText(pw);
    key("Return");
  }
  // The title names the project exactly: a project whose name only contains `name` is caught here.
  for (let i = 0; !(etsTitle() === want && projectTabOpen(s)); i++) {
    if (i === 30) fail(`ETS did not open the project ${name} within 60 s (its title: ${etsTitle()})`);
    await sleep(2000);
  }
  await sleep(3000);
  await closeExtraProjectTabs(s, name);
}

// The project's tabs beyond the first closed. On the first open of a project after ETS crashed, ETS restores the views it
// had open as a second tab of the project (seen after an ETS kill); two views of one project are no layout the driver
// works in. A tab in front is white with its close mark 18 px left of its end, where the title bar's green begins.
async function closeExtraProjectTabs(s: Screen, name: string): Promise<void> {
  const first = name.split(/\s+/)[0];
  const tabs = () => findText(s.look({ x: 200, y: 0, w: 1100, h: 36 }).ws, first).filter((b) => b.y < 30).sort((a, b) => a.x - b.x);
  for (let i = 0; ; i++) {
    const t = tabs();
    if (t.length <= 1) break;
    if (i === 3) fail(`ETS shows ${t.length} tabs of the project ${name}, and the extra ones do not close`);
    const extra = t[t.length - 1];
    click(extra.cx, extra.cy);
    xdo("mousemove", "1000", "600");
    await sleep(1500);
    const row = execFileSync("magick", [s.snap(), ...crop({ x: extra.x, y: 19, w: 400, h: 1 }), "-depth", "8", "txt:-"], { encoding: "utf8" });
    const end = row.split("\n").slice(1).map((l) => l.match(/^(\d+),0: \((\d+),(\d+),(\d+)/)).find((m) => m && Number(m[3]) - Number(m[2]) > 40)
      ?? fail(`the tab of the project ${name} at ${extra.x} shows no end`);
    console.log(`closing an extra tab of the project ${name}`);
    click(extra.x + Number(end[1]) - 18, 19);
    await sleep(2000);
  }
  click(AT.projectTab[0], AT.projectTab[1]);
  await sleep(1000);
}

// Whether a project's tab stands beside the overview's tab (its name in it).
const projectTabOpen = (s: Screen) => s.look(AT.projectTabText).ws.some((w) => /\w{2}/.test(w.text));

// A project's name as OCR compares it: OCR reads an l as i now and then ("Fohimeister"), so those letters are one.
const nameKey = (v: string) => norm(v.replaceAll("|", "l")).replace(/[i1]/g, "l");

// The overview's project search set to `name`, listing exactly one project (OCR reads a copy's "(2)" on a card
// unreliably; the search matches names that contain `name`, so a name another one contains is refused).
async function searchProject(s: Screen, name: string): Promise<void> {
  click(AT.overviewTab[0], AT.overviewTab[1]);
  await sleep(1500);
  click(AT.projectSearch[0], AT.projectSearch[1]);
  key("ctrl+a");
  typeText(name);
  // The list follows the search late: its one row must read as `name` and the device count beside it, its last word
  // (compared as findText compares), and the count row ("Alle 1", read as one line: sparse OCR drops its lone
  // digit) say one.
  let count: number | undefined, shown = "";
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    const png = s.snap();
    const line = textLines(png, AT.searchedCount, 3).join(" ").match(/Alle\s+(\d+)\s*$/);
    count = line ? Number(line[1]) : undefined;
    shown = textLines(png, AT.searchedName, 3).join(" ");
    if (count === 1 && nameKey(shown.split(/\s+/).slice(0, -1).join(" ")) === nameKey(name)) return;
  }
  fail(`ETS's project search for "${name}" lists ${count ?? "no readable number of"} projects, the first read as "${shown}"`);
}

// The box of the topology tree's row matching `pattern` (`prep`: how the tree is read, as Screen.look takes it).
async function treeRow(s: Screen, pattern: RegExp, prep?: Prep): Promise<Box | null> {
  const { ws } = s.look(AT.leftTree, prep);
  for (const r of rows(ws.filter(inside(AT.leftTree)))) {
    if (pattern.test(r.text)) {
      const x = r.words[0].x, last = r.words[r.words.length - 1];
      return { x, y: r.y - 6, w: last.x + last.w - x, h: 12, cx: x + 30, cy: Math.round(r.y), text: r.text };
    }
  }
  return null;
}

// The topology view in the left panel, with line 1.1 visible.
async function showTopology(s: Screen): Promise<void> {
  const { ws } = s.look({ x: 0, y: 80, w: 315, h: 26 });
  if (!findText(ws, "Topologie").length) {
    click(AT.panelSelector[0], AT.panelSelector[1]);
    const entry = await s.waitText("Topologie", { x: 0, y: 100, w: 315, h: 200 }, 10_000, "the panel list");
    click(entry.cx, entry.cy);
    await sleep(2000);
  }
  if (!(await findLine11(s))) {
    const main = (await treeRow(s, /Haupt/)) ?? fail("the project has no 1.0 IP Hauptlinie in its topology");
    // The click toggles the main line: it is clicked only where nothing stands below it (collapsed), so a line 1.1
    // OCR misread is never folded away.
    if (!rows(s.look(AT.leftTree).ws.filter(inside(AT.leftTree))).some((r) => r.y > main.cy + 8)) {
      click(8, main.cy);
      await sleep(1500);
    }
  }
}

// Line 1.1's row of the topology tree, or null. OCR reads the row worse while it is selected ("111P Line" for
// "1.1 TP Linie"): a second look reads the tree in grey.
async function findLine11(s: Screen): Promise<Box | null> {
  return (await treeRow(s, LINE_11)) ?? (await treeRow(s, LINE_11, "gray"));
}
const line11 = async (s: Screen): Promise<Box> => (await findLine11(s)) ?? fail("no line 1.1 in the topology");

// Tree rows as OCR reads them: icons come out as stray characters before the text ("{1.1.20 KNX-…"), and the
// project has one TP line, the only "Linie" row that is neither the backbone, the main line nor a search folder.
// OCR loses a dot of an address now and then ("1.151" for 1.1.51 in a selected row): the dots are optional, so the
// address is looked for only in a row's first word with a dot (a device's name may hold "1.12").
const iaRow = (ia: string) => new RegExp(`^[^.]*?(?<![\\d.])${ia.replace(/\./g, "\\.?")}(?![\\d.])`);
const ANY_DEVICE = /(?<![\d.])1\.1\.\d+(?![\d.])/;
// A selected line's "Linie" reads as "Line" now and then; a device's row (its address) whose name ends so is none.
export const LINE_11 = /^(?!.*(Backbone|Haupt|Keiner|Programmieren|zugewiesen|\d\.\d+\.\d)).*L[il1]n(?:[il1]e|e)\s*$/;

// The sidebar's properties section expanded (ETS opens "Laufende Operationen" instead after a download).
async function showProperties(s: Screen): Promise<void> {
  const { ws } = s.look({ x: 1575, y: 80, w: 345, h: 130 });
  if (findText(ws, "Gruppen").length) {
    const header = findText(ws, "Eigenschaften")[0] ?? fail("no 'Eigenschaften' in the sidebar");
    click(header.cx, header.cy);
    await sleep(1500);
  }
}

// Line 1.1 selected in the tree and its "Geräte" tab in front (whatever the tree shows collapsed).
async function showLineDevices(s: Screen): Promise<void> {
  const line = await line11(s);
  click(line.cx, line.cy);
  await sleep(1500);
  const tab = findText(s.look(AT.mainTabs).ws, "Ger")[0] ?? fail("no 'Geräte' tab with line 1.1 selected");
  click(tab.cx, tab.cy);
  await sleep(1500);
}

// The devices line 1.1 holds, as the main panel lists them with the line selected: the rows under the list's
// header. OCR misreads the narrow address cell ("Lil" for 1.1.1), so a row counts by the text it carries, not
// by its address.
async function lineDevices(s: Screen): Promise<{ y: number; text: string }[]> {
  await showLineDevices(s);
  return gridRows(s);
}
function gridRows(s: Screen, prep?: Prep): { y: number; text: string }[] {
  const { ws } = s.look(AT.mainGrid, prep);
  // A search highlights the header row, whose address cell then reads unreliably: any column header marks it.
  const header = findText(ws, "Adress")[0] ?? findText(ws, "Hersteller")[0] ?? fail("the device list of line 1.1 shows no header");
  return rows(ws.filter(inside(AT.mainGrid))).filter((r) => r.y > header.y + header.h + 6 && r.words.filter((w) => /[A-Za-z]{3}/.test(w.text)).length >= 2).map((r) => ({ y: Math.round(r.y), text: r.text }));
}

// The device at `ia` of a configured project selected, and its address read back from the properties'
// "Physikalische Adresse" (line and device in two fields). Where line 1.1's tree, opened, shows the device, its row
// there; otherwise line 1.1's device list filtered by ETS's search to the address (a house project's tree holds
// more devices than the panel shows). A device number up to 25 is never searched for: it begins other addresses
// (1.1.1 begins 1.1.10 to 1.1.19 and 1.1.100 to 1.1.199), and ETS's highlighting of the overlapping matches throws
// (an ArgumentOutOfRangeException dialog).
async function selectByAddress(s: Screen, ia: string): Promise<void> {
  const line = await line11(s);
  if (!(await treeRow(s, ANY_DEVICE))) { click(15, line.cy); await sleep(2000); }
  const dev = await treeRow(s, iaRow(ia));
  if (dev) {
    click(dev.cx, dev.cy);
    await sleep(1500);
  } else {
    // A device number up to 25 begins three-digit ones (1.1.2 and 1.1.20 to 1.1.25).
    if (Number(ia.split(".")[2]) <= 25) fail(`line 1.1's tree shows no ${ia}, and ETS's search for it would also match the addresses it begins`);
    await showLineDevices(s);
    click(AT.gridSearch[0], AT.gridSearch[1]);
    key("ctrl+a");
    typeText(ia);
    await sleep(2500);
    const found = gridRows(s, "gray");
    if (found.length !== 1) fail(`ETS's search for ${ia} in line 1.1 lists ${found.length} devices, not one`);
    // The room, application and manufacturer cells are links that leave the list; the description cell is not.
    click(560, found[0].y);
    await sleep(1500);
  }
  await checkAddress(s, ia);
}

// The selected device's address read from the properties' "Physikalische Adresse" (line and device in two
// fields): OCR reads them reliably where it misreads a tree row ("{711.204" for 1.1.204).
async function checkAddress(s: Screen, ia: string): Promise<void> {
  await showProperties(s);
  const label = await s.waitText("Physikalische Adresse", AT.properties, 10_000, "the selected device's properties");
  const values = s.look(AT.properties).ws.filter((w) => w.y > label.y + 8 && w.y < label.y + 40).map((w) => w.text.replace(/[^\d.]/g, "")).filter(Boolean);
  const [area, lineNo, device] = ia.split(".");
  // OCR loses the dot of the line field now and then ("11" for 1.1).
  if (!values.some((v) => v.replaceAll(".", "") === `${area}${lineNo}`) || !values.includes(device)) fail(`the selected device is not ${ia} (its address fields read ${values.join(" ")})`);
}

// The tree row right under line 1.1: its one device, in a project the driver filled from the catalogue.
async function lineDeviceRow(s: Screen): Promise<Box> {
  const line = await line11(s);
  const below = rows(s.look(AT.leftTree).ws.filter(inside(AT.leftTree))).find((r) => r.y > line.cy + 8) ?? fail("line 1.1 shows no device in the tree");
  return { x: below.words[0].x, y: below.y - 6, w: 200, h: 12, cx: below.words[0].x + 30, cy: Math.round(below.y), text: below.text };
}

// ETS's search of the device list emptied again, so that a later row of the project lists every device.
async function clearSearch(): Promise<void> {
  click(AT.gridSearch[0], AT.gridSearch[1]);
  key("ctrl+a", "BackSpace");
  await sleep(1500);
}

// Every device of line 1.1 deleted; the deletion's confirmation, where ETS asks, given.
async function emptyLine(s: Screen): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const devices = await lineDevices(s);
    if (devices.length === 0 && !(await treeRow(s, ANY_DEVICE))) return;
    if (attempt === 5) fail(`line 1.1 still holds ${devices[0]?.text ?? "a device in the tree"} after deleting`);
    if (devices.length) click(400, devices[0].y);
    else { const dev = (await treeRow(s, ANY_DEVICE))!; click(dev.cx, dev.cy); }
    await sleep(1000);
    key("Delete");
    await sleep(2500);
    const png = s.snap();
    const box = dialogBox(png);
    if (box) {
      const yes = ["Ja", "Löschen", "OK"].map((b) => findText(dialogButtons(png, box), b)[0]).find(Boolean) ?? fail("ETS asks something on deleting a device that the driver does not know");
      click(yes.cx, yes.cy);
      await sleep(2000);
    }
  }
}

export interface CatalogueEntry { orderNumber: string; version: string; deviceType: string; fingerprint: string }

// The properties panel's reading of the selected catalogue row: the Katalog tab's order number, the
// Applikation tab's device type, program version and fingerprint.
async function readCatalogueEntry(s: Screen): Promise<CatalogueEntry> {
  await showProperties(s);
  const tab = async (name: string) => {
    const { ws } = s.look(AT.properties);
    // A product picture beside the tabs cuts OCR's reading of their names short ("Katal"): found by their start.
    const t = findText(ws, name.slice(0, 5)).find((b) => b.y < 165) ?? fail(`the properties panel shows no ${name} tab for the catalogue row`);
    click(t.cx, t.cy);
    await sleep(1500);
    // The tab's label/value table, read as one block (word by word, OCR drops the dot in "1.1"), at three times
    // its size: at two OCR reads "$493B" as "3493B" and "B471" as "B4a71".
    return textLines(s.snap(), { x: AT.properties.x, y: t.y + 20, w: AT.properties.w, h: 200 }, 3);
  };
  const value = (lines: string[], label: string) => {
    const l = lines.find((x) => norm(x).startsWith(norm(label)));
    return l ? l.split(/\s+/).slice(label.split(/\s+/).length).join(" ") : fail(`the properties panel shows no ${label} for the catalogue row`);
  };
  const cat = await tab("Katalog");
  const orderNumber = value(cat, "Bestellnummer");
  const app = await tab("Applikation");
  return { orderNumber, deviceType: value(app, "Gerätetyp"), version: value(app, "Programmversion"), fingerprint: value(app, "Fingerprint") };
}

// An order number as the sweep's list compares the catalogue's rows by it (tools/ets-catalogue.ts): without spaces and
// with O and 0, I, L and 1 taken as one, as OCR of ETS's catalogue breaks a long one into words ("OpenKnxRau
// mController") and confuses those letters ("RO111"), so rows whose numbers differ only so are flagged as sharing one.
export const orderNumberKey = (n: string) => n.replace(/\s+/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");

// An application's version as ETS's catalogue shows it: 0x11 is "1.1".
export const catalogueVersion = (v: number) => `${v >> 4}.${v & 15}`;

// The unit's application as ETS's catalogue shows it: "$0004", "1.1", "F245" for M-0162_A-0004-11-F245.
function catalogueIdentity(applicationId: string): { deviceType: string; version: string; fingerprint: string } {
  const m = applicationId.match(/^M-[0-9A-F]{4}_A-([0-9A-F]{4})-([0-9A-F]{2})-([0-9A-F]{4})(?:-O[0-9A-F]+)?$/) ?? fail(`${applicationId} is no application id`);
  return { deviceType: `$${m[1]}`, version: catalogueVersion(parseInt(m[2], 16)), fingerprint: m[3] };
}

// Whether a catalogue group's expander shows it open ("^") or closed ("v"), from magick's txt: output of the glyph's
// 20 px square in grey: of its dark pixels, the top row spans narrow and the bottom row wide where it points up (the
// arrow of ETS 6.4.1: 6 px apart at the wide end, one pixel at the tip); null where it shows no arrow.
export function expanderOpen(txt: string): boolean | null {
  const dark = txt.split("\n").slice(1).flatMap((l) => {
    const m = l.match(/^(\d+),(\d+):.*#([0-9A-Fa-f]{2})/);
    return m && parseInt(m[3], 16) < 0x80 ? [{ x: Number(m[1]), y: Number(m[2]) }] : [];
  });
  if (dark.length < 3) return null;
  const span = (y: number) => { const xs = dark.filter((p) => p.y === y).map((p) => p.x); return Math.max(...xs) - Math.min(...xs); };
  const top = span(Math.min(...dark.map((p) => p.y))), bottom = span(Math.max(...dark.map((p) => p.y)));
  return top === bottom ? null : top < bottom;
}

// Of the catalogue rows ETS's search lists for an order number (in the grid's order), the one to insert for
// `applicationId`: at the application's version and device type, and of those the one whose fingerprint reads as the
// application's; the first of several such rows (one application in several catalogue items), and how many there
// were. The order number each row reads is not compared: the search lists only rows that hold it, and OCR reads it as
// unreliably as a fingerprint ("Gws308s3" for GW90883, O for 0); rows under other order numbers that hold it
// (TB/U12.7 for TB/U1) are told apart by the application they run. Where no fingerprint reads exactly ("DC390" for
// DC90, "1634" for 163A), the rows whose fingerprint reads closest are taken, where no other reading is as close
// (rows that read alike count as one application). What a catalogue unit's row inserted is checked exactly on the
// project's export right after the insert (runRow); an own unit's in writeRow, which takes another build only where
// it parses as the unit's.
export function pickCatalogueRow<E extends CatalogueEntry>(entries: E[], orderNumber: string, applicationId: string): { hit: E; rows: number; exact: boolean } | { refused: string } {
  const want = catalogueIdentity(applicationId);
  // A device type reads with its "$" as "S" or "3" and an O for a 0 ("SOOB6" for $00B6); a fingerprint the same.
  const hexKey = (v: string) => v.toUpperCase().replace(/^[$S3](?=[0-9A-FO]{4}$)/, "").replace(/O/g, "0");
  const candidates = entries.filter((e) => e.version === want.version && hexKey(e.deviceType) === hexKey(want.deviceType));
  const read = () => entries.map((e) => `${e.orderNumber} ${e.deviceType} ${e.version} ${e.fingerprint}`).join("; ");
  const hits = candidates.filter((e) => hexKey(e.fingerprint) === hexKey(want.fingerprint));
  if (hits.length) return { hit: hits[0], rows: hits.length, exact: true };
  if (candidates.length === 0) return { refused: `no catalogue row with order number ${orderNumber} runs ${applicationId} (read: ${read()})` };
  // Rows that read one fingerprint alike are taken as one application (OCR misreads its text the same way each time).
  const readings = [...new Set(candidates.map((e) => hexKey(e.fingerprint)))];
  const distance = readings.map((f) => editDistance(f, hexKey(want.fingerprint)));
  const best = Math.min(...distance);
  if (distance.filter((d) => d === best).length > 1) return { refused: `${candidates.length} catalogue rows with order number ${orderNumber} at ${want.deviceType} ${want.version} read no fingerprint closest to ${want.fingerprint} alone (read: ${read()})` };
  const rows = candidates.filter((e) => hexKey(e.fingerprint) === readings[distance.indexOf(best)]);
  return { hit: rows[0], rows: rows.length, exact: false };
}

// The Levenshtein distance of two strings.
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// The product inserted into line 1.1 from the catalogue: a catalogue row listed for the order number whose
// application is `applicationId`, by its device type, version and fingerprint as ETS's properties panel shows them
// (the fingerprint of the id ETS's product store holds, which tools/ets-catalogue.ts gives a row as its
// application). The search lists every row whose text holds the order number, other manufacturers' and other
// versions' too, each read, and one picked (pickCatalogueRow). The one row at the order number, device type and
// version may run another build of an own unit's application (an OpenKNX release ETS took from an imported project;
// writeRow takes it only where it parses as the unit's); a catalogue unit's row is checked to run its application
// exactly once the project is exported after the insert (runRow).
async function insertProduct(s: Screen, orderNumber: string, applicationId: string): Promise<void> {
  const line = await line11(s);
  click(line.cx, line.cy);
  await sleep(1500);
  // The catalogue panel's header in the lower left; its toolbar (search field at the right) on the same row.
  const cataloguePanel = { x: 0, y: 600, w: 315, h: 120 };
  let { ws } = s.look();
  let header = findText(ws, "Katalog").find(inside(cataloguePanel));
  if (!header) {
    const add = findText(ws, "Hinzuf").find((b) => b.y < 70) ?? fail("no 'Hinzufügen' in the toolbar with line 1.1 selected");
    click(add.cx, add.cy);
    header = await s.waitText("Katalog", cataloguePanel, 20_000, "the catalogue panel");
  }
  click(1460, header.cy);
  key("ctrl+a");
  typeText(orderNumber);
  key("Return");
  await sleep(6000);
  // A dialog now (a KNX-ID login, the online catalogue failing) is read before Escape, which closes the search's
  // suggestions, could close it unread.
  { const png = s.snap(), box = dialogBox(png); if (box) fail(`${UNKNOWN_DIALOG} (after the catalogue search): ${words(png, box).map((w) => w.text).join(" ").slice(0, 300)}`); }
  key("Escape");
  await sleep(1000);
  const grid = { x: AT.catalogueGrid.x, y: header.cy + 37, w: AT.catalogueGrid.w, h: 1160 - header.cy - 37 };
  // Product rows fill the name and application columns (from x 450; an application's name can be digits but for one
  // letter, "S85166100"); a manufacturer's group header holds its name at the left only. (OCR misreads the narrow
  // medium and version cells: "4930...TP", "TRIP" for "TP,IP", "T", a version glued to the application's name.)
  const PRODUCT_TEXT_X = 450;
  const products = () => rows(s.look(grid, "binary").ws.filter(inside(grid))).filter((r) => r.words.some((w) => w.x >= PRODUCT_TEXT_X && /[A-Za-z0-9]{3}/.test(w.text)));
  let items = products();
  // Every manufacturer's group the search lists is opened where it stands closed (ETS keeps a group closed from one
  // search to the next): its expander's arrow is read, never toggled blind, one group at a time (opening one moves
  // the groups below it). The online catalogue lists the rows late. A group still closed after that is refused.
  const closedGroups = () => {
    const png = s.snap();
    const headers = rows(words(png, grid).filter(inside(grid))).filter((r) => !r.words.some((w) => w.x >= PRODUCT_TEXT_X) && r.words[0].x < 360);
    return { headers, closed: headers.filter((h) => expanderOpen(execFileSync("magick", [png, ...crop({ x: 316, y: Math.round(h.y) - 10, w: 20, h: 20 }), "-colorspace", "Gray", "-depth", "8", "txt:-"], { encoding: "utf8" })) === false) };
  };
  let groups = closedGroups();
  if (groups.headers.length === 0 && items.length === 0) fail(`the catalogue lists nothing for order number ${orderNumber}`);
  for (let opened = 0; groups.closed.length; opened++) {
    if (opened === 10) fail(`the catalogue's groups for order number ${orderNumber} stay closed: ${groups.closed.map((h) => h.text).join(", ")}`);
    click(326, Math.round(groups.closed[0].y));
    await sleep(3000);
    groups = closedGroups();
  }
  // The rows of a group just opened may still come in: read until two readings agree (at most 5).
  for (let i = 0, before = -1; i < 5 && (items = products()).length !== before; i++) { before = items.length; await sleep(2000); }
  if (items.length === 0) fail(`the catalogue holds no product for order number ${orderNumber}`);
  // A list that reaches the grid's last row may go on below it, where the driver does not scroll.
  if (Math.max(...items.map((r) => r.y)) > grid.y + grid.h - 30) fail(`the catalogue lists more rows for order number ${orderNumber} than its grid shows at once`);
  const entries: (CatalogueEntry & { y: number })[] = [];
  for (const r of items) {
    click(500, Math.round(r.y));
    await sleep(1500);
    entries.push({ ...(await readCatalogueEntry(s)), y: Math.round(r.y) });
  }
  const picked = pickCatalogueRow(entries, orderNumber, applicationId);
  if ("refused" in picked) return fail(picked.refused);
  if (picked.rows > 1) console.log(`${picked.rows} catalogue rows under order number ${orderNumber} run ${applicationId}: the first inserted`);
  if (!picked.exact) console.log(`the catalogue row inserted reads its fingerprint as ${picked.hit.fingerprint}, not ${catalogueIdentity(applicationId).fingerprint}: what it runs is checked after the insert`);
  const hit = picked.hit;
  click(500, hit.y);
  await sleep(1500);
  ({ ws } = s.look(AT.bottomBar));
  if (!findText(ws, "1.1 TP Linie").length) fail("the catalogue's insert target is not line 1.1");
  const add = findText(ws, "Hinzuf").at(-1) ?? fail("no 'Hinzufügen' under the catalogue");
  click(add.cx, add.cy);
  let importing = false;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    // A product that can run Data Secure makes ETS ask for a project password; cancelling inserts it plain.
    const png = s.snap(), box = dialogBox(png);
    if (box) {
      const ws = words(png, box);
      // ETS imports the product's data first, behind a progress dialog.
      importing = findText(ws, "Importiere Daten").length > 0;
      if (importing) continue;
      // A product whose plug-ins need ETS's compatibility mode: ETS asks to restart in it, and inserts nothing
      // without. The driver runs ETS in its normal mode only; cancelled, the row is refused.
      const compatibility = findText(ws, "Kompatibilit").length > 0;
      if (!compatibility && !findText(ws, "Projektpasswort setzen").length) fail(`ETS shows a dialog after the insert: ${ws.map((w) => w.text).join(" ").slice(0, 160)}`);
      if (compatibility) {
        // Its buttons ("Im Kompatibilitätsmodus neu starten", "Abbrechen") read unreliably; Escape cancels it.
        key("Escape");
        await sleep(1500);
        if (dialogBox(s.snap())) fail("ETS's compatibility warning stays open after Escape");
        fail("refused: the product's plug-ins need ETS's compatibility mode (ETS asks to restart in it after the insert); the driver runs ETS in its normal mode");
      }
      const cancel = findText(dialogButtons(png, box), "Abbrechen")[0] ?? fail("no Abbrechen under ETS's project password dialog");
      click(cancel.cx, cancel.cy);
      continue;
    }
    importing = false;
    const devices = await lineDevices(s);
    if (devices.length > 1) fail(`line 1.1 holds ${devices.length} devices after the insert`);
    if (devices.length === 1) return;
  }
  fail(importing ? "ETS's import of the product's data did not end within 60 s" : "the product did not appear in line 1.1");
}

// The device's address set in the properties panel (line 1.1 only).
async function setAddress(s: Screen, ia: string): Promise<void> {
  if (!/^1\.1\.\d+$/.test(ia)) fail(`the driver places devices in line 1.1, not at ${ia}`);
  await showProperties(s);
  const dev = await lineDeviceRow(s);
  click(dev.cx, dev.cy);
  await sleep(1500);
  const label = await s.waitText("Physikalische Adresse", AT.properties, 10_000, "the device's properties");
  click(label.x + 110, label.cy + 22);
  key("ctrl+a");
  typeText(ia.split(".")[2]);
  key("Tab");
  await sleep(2000);
  await checkAddress(s, ia);
}

// Dialogs ETS shows inside its window dim the rest of it: the window's margins turn grey, and the dialog is
// the one bright box left.
function dialogBox(png: string): Region | null {
  const lightest = (r: Region) => measure(png, r, ["-colorspace", "Gray", "-format", "%[fx:maxima]"]);
  if (![{ x: 2, y: 1185, w: 300, h: 12 }, { x: 1580, y: 1185, w: 300, h: 12 }].every((r) => lightest(r) < 0.7)) return null;
  const m = execFileSync("magick", [png, "-colorspace", "Gray", "-threshold", "80%", "-format", "%@", "info:"], { encoding: "utf8" }).trim().match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
  return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
}

// The buttons in a dialog's bottom bar, which ETS aligns right: read as one line, without the dialog's frames
// and lists to its left (a wider strip reads the frames as text).
function dialogButtons(png: string, box: Region): Word[] {
  const w = Math.min(box.w, 420);
  return words(png, { x: box.x + box.w - w, y: box.y + box.h - 40, w, h: 40 }, { scale: 2, psm: 7 });
}

// Dialogs in ETS's window closed, cancelling where they offer it (closing a result, cancelling a question,
// confirming only what offers nothing else), else by Escape; one still open after that fails.
async function closeDialogs(s: Screen): Promise<void> {
  for (let i = 0; ; i++) {
    const png = s.snap();
    const box = dialogBox(png);
    if (!box) break;
    if (i === 4) fail("a dialog in ETS's window stays open");
    const buttons = dialogButtons(png, box);
    const button = ["Schlie", "Abbrechen", "Nein", "OK"].map((b) => findText(buttons, b)[0]).find(Boolean);
    if (!button) { key("Escape"); await sleep(1000); }
    else { click(button.cx, button.cy); await sleep(1500); }
  }
  if (!etsTitle()) fail("ETS's window is gone");
}

// Between two steps of a row: ETS's window is there and shows no dialog. A dialog here is none the driver expects:
// its text read and the screen kept as dialog.png in `dir` before the row fails.
function settled(s: Screen, dir: string, before: string): void {
  if (!etsTitle()) fail(`ETS's window is gone (before "${before}")`);
  const png = s.snap(), box = dialogBox(png);
  if (!box) return;
  copyFileSync(png, join(dir, "dialog.png"));
  fail(`${UNKNOWN_DIALOG} (before "${before}"): ${words(png, box).map((w) => w.text).join(" ").slice(0, 300)}`);
}

// The project compressed: ETS's "Jetzt komprimieren" in its details dialog deletes the product data no device of the
// project uses (ETS6.log: "Deleting folder of unreferenced manufacturer …"). ETS closes the project for it; it is
// opened again. Checked on ETS's store: the project's directory holds no manufacturer's data a device does not use,
// which for a project without devices is none.
async function compressProject(s: Screen, project: string, passwordEnv?: string): Promise<void> {
  click(AT.projectInfo[0], AT.projectInfo[1]);
  const compress = await s.waitText("komprimieren", undefined, 20_000, "the project's details dialog");
  click(compress.cx, compress.cy);
  await sleep(2500);
  const png = s.snap(), box = dialogBox(png) ?? fail("ETS asked nothing before compressing the project");
  const asked = words(png, box).map((w) => w.text).join(" ");
  if (!/geschlossen/.test(asked)) fail(`${UNKNOWN_DIALOG} (asked to compress the project): ${asked.slice(0, 300)}`);
  // OCR reads neither of its buttons reliably (the bar under its yellow rule reads empty); Ja is the default button,
  // taken by Return. What follows shows it was Ja: the project closes and its store holds no product data after it.
  key("Return");
  for (let i = 0; projectTabOpen(s); i++) {
    if (i === 30) fail("ETS did not close the project to compress it within 60 s");
    await sleep(2000);
  }
  // The details dialog stays open over the overview once the compression ended.
  await s.waitText("komprimieren", undefined, 60_000, "the details dialog after the compression");
  const dir = [...storedProjects()].find(([, n]) => n === project)?.[0] ?? fail(`ETS's store holds no project ${project}`);
  const left = remote(`cd ${q(`${host().data}/ProjectStore/${dir}`)} && ls -d M-* 2>/dev/null || true`).split("\n").filter(Boolean);
  if (left.length) fail(`the compressed project ${project} still holds the product data of ${left.join(", ")}`);
  key("Escape");
  await sleep(1500);
  await closeDialogs(s);
  await openProject(s, project, passwordEnv);
}

// ETS's own processes (those `up` started) killed: an ETS crash, made on purpose (--inject-kill).
function killEts(): void {
  const ets = owned("ets.pids").filter((p) => p.name.startsWith("ETS6"));
  if (!ets.length) fail("no ETS this driver started runs");
  signal(ets, "KILL");
}

// The toolbar's interface set to the configured connection at `endpoint` ("host:port"), its check mark read
// back. Where the toolbar does not offer it, it is made the project's connection first.
async function selectInterface(s: Screen, endpoint: string): Promise<void> {
  // OCR reads "(192.168. 1.105:3701 Tcp)": compared without spaces, the port ending where its digits do.
  const names = new RegExp(`\\(${endpoint.replace(/\./g, "\\.")}(?!\\d)`);
  const at = (text: string) => names.test(text.replace(/\s+/g, "").replace(/,/g, "."));
  const entryIn = (ws: Word[]) => rows(ws.filter(inside(AT.menuRight))).find((r) => at(r.text));
  const open = () => { key("Escape"); click(AT.toolbarInterface[0], AT.toolbarInterface[1]); };
  open();
  await sleep(2000);
  let entry = entryIn(s.look(AT.menuRight).ws);
  if (!entry) {
    // The toolbar offers the project's connection only: starred in the configured connections' dialog, whose OK
    // also refreshes the toolbar's list.
    const manage = findText(s.look(AT.menuRight).ws, "Konfigurierte")[0] ?? fail("no 'Konfigurierte Verbindungen verwalten' under the toolbar's interface");
    click(manage.cx, manage.cy);
    await sleep(3000);
    let png = s.snap();
    const box = dialogBox(png) ?? fail("the configured connections' dialog did not open");
    const listed = rows(words(png, box)).find((r) => at(r.text)) ?? fail(`ETS has no configured connection to ${endpoint}: add one under 'Konfigurierte Verbindungen verwalten'`);
    click(box.x + 250, Math.round(listed.y));
    await sleep(1500);
    // The project's connection carries a yellow star left of its row (blue minimum 0.19 measured, 0.95 without);
    // the button toggles it, so it is pressed only where the star is missing.
    const starred = (p: string) => measure(p, { x: box.x + 55, y: Math.round(listed.y) - 8, w: 18, h: 16 }, ["-format", "%[fx:minima.b]"]) < 0.6;
    if (!starred(s.snap())) {
      const star = findText(s.look(box).ws, "dieses Projekt")[0] ?? fail("no 'Für dieses Projekt verwenden' for the selected connection");
      click(star.cx, star.cy);
      await sleep(1500);
      if (!starred(s.snap())) fail(`the connection to ${endpoint} did not become the project's`);
    }
    png = s.snap();
    const ok = findText(dialogButtons(png, box), "OK")[0] ?? fail("no OK in the configured connections' dialog");
    click(ok.cx, ok.cy);
    await sleep(2000);
    open();
    await sleep(2000);
    entry = entryIn(s.look(AT.menuRight).ws) ?? fail(`the toolbar does not list the connection to ${endpoint} after setting it as the project's`);
  }
  click(1760, Math.round(entry.y));
  await sleep(2000);
  open();
  await sleep(2000);
  const look = s.look(AT.menuRight);
  entry = entryIn(look.ws) ?? fail(`the toolbar's interface list lost the connection to ${endpoint}`);
  const auto = findText(look.ws, "Automatisch").find(inside(AT.menuRight));
  // The menu is aligned right, so its check marks move with its width: a row's mark is looked for in the band
  // left of the connection's name.
  const mark = (y: number) => greenness(look.png, { x: 1540, y: Math.round(y) - 9, w: 160, h: 18 });
  key("Escape");
  if (mark(entry.y) < 0.2) fail(`the interface's check mark is not on the connection to ${endpoint}`);
  if (auto && mark(auto.cy) >= 0.2) fail("the interface's check mark is still on 'Automatisch'");
}

// The project exported from ETS's overview to `to` (a project with a password keeps it in its export: `password`
// opens it); the export is checked to be of that project.
async function exportProject(s: Screen, project: string, to: string, password: string | undefined): Promise<void> {
  const h = host();
  await searchProject(s, project);
  xdo("mousemove", "800", String(AT.searchedRow[1] + 14), "sleep", "1");
  const exp = findText(s.look({ x: AT.searchedExport[0] - 40, y: AT.searchedExport[1] - 12, w: 90, h: 24 }).ws, "Export")[0] ?? fail("no Export on the project's row");
  click(exp.cx, exp.cy);
  const name = await s.waitText("File name", undefined, 20_000, "the export's file dialog");
  const file = `${Date.now()}.knxproj`;
  click(name.x + 180, name.cy);
  key("ctrl+a");
  typeText(`${h.exportDirWin}\\${file}`);
  key("Return");
  await s.waitText("Export erfolgreich", undefined, 120_000, "the export");
  const png = s.snap();
  const box = dialogBox(png) ?? fail("the export's result is no dialog");
  const close = findText(dialogButtons(png, box), "Schlie")[0] ?? fail("no Schließen under the export's result");
  click(close.cx, close.cy);
  const remoteFile = `${h.exportDir}/${file}`;
  writeFileSync(to, ssh(`cat ${q(remoteFile)}`, ""));
  remote(`rm -f ${q(remoteFile)}`);
  const exported = loadKnxproj(readFileSync(to), password, "export").name;
  if (exported !== project) fail(`the export is of the project ${exported}, not ${project}`);
  click(AT.projectTab[0], AT.projectTab[1]);
  await sleep(2000);
}

// An application program's parse, with its id replaced by `as`: what Busforge plans a download from.
const parsedAs = (xml: string, id: string, as: string) => JSON.stringify(parseAppConfig(xml.replaceAll(id, as)), (_, v: unknown) => v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);

// row.json, and configuration.json from the device's configuration in ETS's export. A project can hold the
// unit's application under another build's id (same manufacturer, number and version, another content hash;
// an OpenKNX application ETS imported from its release): taken only where the project's application parses as
// the unit's does, its ids then written as the unit's and the project's named in row.json (exportApplication).
// The row is read from the export reduced to its devices' product data (tools/ets-export-reduce.ts), which
// replaces ETS's export once the row is written. A row from scratch (`ownProductOnly`) is refused where ETS's export
// holds product data its device does not use (an application program or a manufacturer the reduction drops): the
// project was not cleared of an earlier row's product. A catalogue unit's row takes no other build: its application
// program is the export's.
function writeRow(dir: string, unit: RowSpec["unit"], simulator: string, applicationId: string, ia: string, password: string | undefined, ownProductOnly: boolean): void {
  const reduced = reduceProjectExport(readFileSync(join(dir, "export.knxproj")), password);
  const foreign = reduced.dropped.filter((n) => /^M-[0-9A-F]{4}\/$/i.test(n) || /^M-[0-9A-F]{4}\/M-[0-9A-F]{4}_A-[^/]*\.xml$/i.test(n));
  if (ownProductOnly && foreign.length) fail(`ETS's export holds product data the row's device does not use: ${foreign.join(", ")}`);
  const bytes = reduced.bytes;
  const proj = loadKnxproj(bytes, password, "export");
  const d = proj.devices.find((x) => x.ia === ia) ?? fail(`ETS's export holds no device ${ia}`);
  const exported = deviceApplication(d);
  const own = typeof unit === "string";
  if (!own && exported !== applicationId) fail(`ETS's export runs ${exported} at ${ia}, not ${applicationId}`);
  const unitXml = own ? catalogueXml(`${applicationId}.xml.gz`) : extractAppPrograms(bytes, [exported]).get(exported) ?? fail(`ETS's export holds no application ${exported}`);
  let xml = unitXml;
  if (exported !== applicationId) {
    const versionOf = (id: string) => id.replace(/^(M-[0-9A-F]{4}_A-[0-9A-F]{4}-[0-9A-F]{2})-[0-9A-F]{4}((?:-O[0-9A-F]+)?)$/, "$1$2");
    if (versionOf(exported) !== versionOf(applicationId)) fail(`ETS's export runs ${exported} at ${ia}, not ${applicationId}`);
    xml = readAppProgram(bytes, d.appRef) ?? fail(`ETS's export holds no application ${exported}`);
    if (parsedAs(xml, exported, applicationId) !== parsedAs(unitXml, applicationId, applicationId)) fail(`ETS's export runs ${exported} at ${ia}, another build of ${applicationId} that parses otherwise`);
  }
  const spec: RowSpec = { format: ROW_FORMAT, unit, etsBuild: ETS_BUILD, simulator, export: "export.knxproj", ...(exported === applicationId ? {} : { exportApplication: exported }) };
  writeFileSync(join(dir, ROW_FILES.row), JSON.stringify(spec, null, 2) + "\n");
  const c = deviceConfiguration(parseAppConfig(xml), deviceRows(proj, d.id));
  // The unit's ids for the project's build: the parameters' and module instances' ids begin with the
  // application id and "_" (links and com-object overrides name objects by number); values stay as they are.
  const id = (v: string) => v.startsWith(`${exported}_`) ? `${applicationId}${v.slice(exported.length)}` : v;
  const conf: RowConfiguration = {
    ia, appRef: d.appRef, params: [...c.params].map(([ref, value]) => [id(ref), value]), links: c.links,
    moduleInstances: c.instances.map((m) => ({ id: id(m.id), refId: id(m.refId), args: m.args.map((a) => ({ refId: id(a.refId), value: a.value })) })),
    comObjectOverrides: [...c.comObjectOverrides],
  };
  writeFileSync(join(dir, ROW_FILES.configuration), JSON.stringify(conf, null, 1) + "\n");
  writeFileSync(join(dir, "export.knxproj"), bytes);
}

// ---- projects the driver imports ----

// ETS's local projects, each by its store directory (ProjectStore/P-xxxx) with its name as ETS keeps it.
function storedProjects(): Map<string, string> {
  const store = `${host().data}/ProjectStore`;
  const out = remote(`cd ${q(store)} && for d in P-*/; do d=\${d%/}; n=$(grep -ao 'ProjInfo Name="[^"]*"' "$d/P" | head -1 | sed 's/^ProjInfo Name="//; s/"$//'); printf '%s\\t%s\\n' "$d" "$n"; done`);
  // ETS keeps the name as an XML attribute.
  return new Map(out.split("\n").filter(Boolean).map((l) => { const [d, n] = l.split("\t"); return [d, xmlUnescape(n ?? "")]; }));
}

// An XML attribute's value with its entities decoded.
export const xmlUnescape = (v: string) => v.replace(/&(?:(lt|gt|quot|apos|amp)|#(\d+)|#x([0-9a-fA-F]+));/g, (all, e: string | undefined, dec: string | undefined, hex: string | undefined) => {
  if (e) return ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e] ?? all;
  const n = dec ? Number(dec) : parseInt(hex!, 16);
  return n <= 0x10ffff ? String.fromCodePoint(n) : all;
});

// The projects this driver imported (and may delete), from its state on the bench host: store directory, name.
function importedProjects(): Map<string, string> {
  const out = remote(`f=${q(`${host().state}/imported.txt`)}; [ -r "$f" ] && cat "$f" || true`);
  return new Map(out.split("\n").filter(Boolean).map((l) => l.split("\t") as [string, string]));
}
function writeImported(m: Map<string, string>): void {
  ssh(`cat > ${q(`${host().state}/imported.txt`)}`, [...m].map(([d, n]) => `${d}\t${n}\n`).join(""));
}

// A project file imported into ETS as a new project: where ETS holds one with its id, as a copy ("Kopie
// importieren", never over the one it holds). Its name is read from ETS's store, the one directory the import
// added, and recorded as the driver's own.
async function importProject(file: string, passwordEnv?: string): Promise<string> {
  await up();
  const h = host();
  const s = new Screen(join(tmpdir(), "ets-driver-import"));
  const pw = passwordEnv === undefined ? undefined : process.env[passwordEnv] ?? fail(`the project's password is not in $${passwordEnv}`);
  const before = storedProjects();
  const remoteFile = `${h.state}/import/${basename(file)}`;
  ssh(`mkdir -p ${q(`${h.state}/import`)} && cat > ${q(remoteFile)}`, readFileSync(file));
  try {
    await closeDialogs(s);
    // The overview as it starts, its project search emptied (a search shows a list without the import).
    click(AT.overviewTab[0], AT.overviewTab[1]);
    await sleep(1000);
    click(AT.projectSearch[0], AT.projectSearch[1]);
    key("ctrl+a", "BackSpace");
    click(AT.overviewHome[0], AT.overviewHome[1]);
    const imp = await s.waitText("Projekt importieren", { x: 1300, y: 380, w: 620, h: 50 }, 20_000, "the overview's 'Projekt importieren'");
    click(imp.cx, imp.cy);
    const field = await s.waitText("File name", undefined, 20_000, "the import's file dialog");
    click(field.x + 180, field.cy);
    key("ctrl+a");
    typeText(`Z:${remoteFile.replaceAll("/", "\\")}`);
    key("Return");
    if (pw !== undefined) {
      await s.waitText("Passwort", undefined, 30_000, "the project's password dialog");
      typeText(pw);
      key("Return");
    }
    let asked = 0;
    for (let i = 0; ; i++) {
      if (i === 90) fail("ETS did not report the import within 180 s");
      await sleep(2000);
      const png = s.snap(), box = dialogBox(png);
      if (!box) continue;
      const ws = words(png, box);
      if (findText(ws, "Import erfolgreich").length) {
        const ok = findText(dialogButtons(png, box), "OK")[0] ?? fail("no OK under ETS's import result");
        click(ok.cx, ok.cy);
        break;
      }
      if (findText(ws, "Import-Konflikt").length) {
        const bar = words(png, { x: box.x, y: box.y + box.h - 45, w: box.w, h: 45 }, { psm: 7 });
        const copy = findText(bar, "Kopie importieren")[0] ?? fail("no 'Kopie importieren' in ETS's import conflict");
        click(copy.cx, copy.cy);
        continue;
      }
      if (findText(ws, "Importiere").length) continue;
      // The password dialog stays only where the password is missing or wrong (it closes on the right one).
      if (findText(ws, "Passwort").length && ++asked > 2) fail(pw === undefined ? "the project asks for a password: give its variable with --password-env" : "ETS asks for the project's password again: it is not this project's");
      if (findText(ws, "Passwort").length) continue;
      fail(`ETS shows a dialog during the import: ${ws.map((w) => w.text).join(" ").slice(0, 160)}`);
    }
  } finally {
    remote(`rm -f ${q(remoteFile)}`);
    s.clean();
  }
  await sleep(2000);
  const added = [...storedProjects()].filter(([d]) => !before.has(d));
  if (added.length !== 1) fail(`the import added ${added.length} projects to ETS's store, not one`);
  if (!added[0][1]) fail(`ETS's store holds no name for the imported project ${added[0][0]}`);
  const mine = importedProjects();
  mine.set(added[0][0], added[0][1]);
  writeImported(mine);
  return added[0][1];
}

// A project this driver imported deleted from ETS (its project menu, "Löschen", confirmed); any other refused.
async function deleteProject(name: string): Promise<void> {
  await up();
  const mine = importedProjects(), stored = storedProjects();
  const dir = [...mine].find(([d, n]) => n === name && stored.get(d) === name)?.[0] ?? fail(`"${name}" is no project this driver imported (${host().state}/imported.txt)`);
  const s = new Screen(join(tmpdir(), "ets-driver-delete"));
  try {
    if (projectTabOpen(s)) fail(`a project is open in ETS (${etsTitle()}); close it first`);
    await searchProject(s, name);
    xdo("mousemove", "800", String(AT.searchedRow[1] + 14), "sleep", "1", "mousemove", String(AT.searchedMenu[0]), String(AT.searchedMenu[1]), "sleep", "0.5", "click", "1");
    // OCR reads the menu's ö as é or a ("Léschen"): the entry is found by the rest of the word.
    const item = await s.waitWord((w) => /^L.schen$/i.test(w.text), { x: 1200, y: 190, w: 600, h: 250 }, 10_000, "the project menu's 'Löschen'");
    click(item.x + item.w / 2, item.y + item.h / 2);
    await sleep(2000);
    const png = s.snap(), box = dialogBox(png) ?? fail("ETS asked nothing before deleting");
    // The question must name the project: the search's one row is OCR's reading, the question confirms it.
    const asked = words(png, box).map((w) => w.text).join(" ");
    if (!nameKey(asked).includes(nameKey(name))) fail(`ETS's delete question names no "${name}" (it reads: ${asked.slice(0, 160)}); nothing deleted`);
    // Its OK, framed beside Abbrechen, reads only alone and enlarged ("[oK |"): the box ends 10 px left of the
    // word "Abbrechen" and holds the OK's 75 px frame (ETS 6.4.1's question at 1920x1200).
    const cancel = findText(dialogButtons(png, box), "Abbrechen")[0] ?? fail("no Abbrechen in ETS's delete question");
    const ok = words(png, { x: cancel.x - 95, y: cancel.cy - 13, w: 85, h: 26 }, { scale: 4, psm: 8 }).find((w) => /ok/i.test(w.text)) ?? fail("no OK beside Abbrechen in ETS's delete question");
    click(ok.x + ok.w / 2, ok.y + ok.h / 2);
    for (let i = 0; storedProjects().has(dir); i++) {
      if (i === 30) fail(`ETS still holds ${dir} after the delete`);
      await sleep(2000);
    }
    const gone = [...stored.keys()].filter((d) => d !== dir && !storedProjects().has(d));
    if (gone.length) fail(`the delete also removed ${gone.map((d) => `${d} (${stored.get(d)})`).join(", ")} from ETS's store`);
  } finally { s.clean(); }
  mine.delete(dir);
  writeImported(mine);
}

// ---- ETS's online catalogue into its product store ----

// The catalogue's index on disk (tools/ets-catalogue.ts reads it) names each product's application but not its
// mask; the mask is in the product data, which ETS keeps only for products it loaded. The catalogue panel's
// Herunterladen loads the selected rows' product data without inserting anything. The catalogue server refuses
// a selection with "(400) Bad Request" by the product data it holds, not by its rows (60 rows with 390 MB loaded,
// 24 rows of an application with 73 MB did not, one of them alone did): the grid is walked in batches from its
// first row, their size set by nextBatchSize, and one row that fails alone is written down and passed. Rows
// already loaded leave Herunterladen disabled and pass at once, so a run started again from the first row
// resumes where the last one ended.

const CATALOGUE = {
  download: [470, 659], downloadText: { x: 440, y: 652, w: 80, h: 14 }, firstRow: [700, 731],
  header: { x: 0, y: 645, w: 315, h: 30 }, search: { x: 1375, y: 648, w: 170, h: 22 },
  // The grid's rows right of its last column (background only), and a place for the mouse outside the grid: a
  // row under the mouse turns grey over its selection's blue.
  rowBackground: { x: 900, y: 698, w: 600, h: 462 }, mouseAside: [1700, 1000],
} as const;

// Which parts of the grid are selected, every 5 px down its rows: a selected row's background is blue (blue over
// red 0.14 measured), an unselected one white or grey (0).
export function selectionPattern(png: string, r: Region = CATALOGUE.rowBackground): string {
  const samples = Math.floor(r.h / 5);
  return selectedSamples(execFileSync("magick", [png, ...crop(r), "-scale", `1x${samples}!`, "-colorspace", "sRGB", "-type", "TrueColor", "-depth", "8", "txt:-"], { encoding: "utf8" }));
}

// The samples of magick's txt: output, one per pixel line: "1" where blue stands 18 of 255 over red.
export function selectedSamples(txt: string): string {
  return txt.split("\n").slice(1).filter(Boolean).map((l) => {
    const [red, , blue] = (l.match(/\((\d+),(\d+),(\d+)/) ?? fail(`no pixel in magick's line ${l}`)).slice(1).map(Number);
    return blue - red > 18 ? "1" : "0";
  }).join("");
}

// Whether a selection pattern holds one row: one run of selected samples, a row (20 px) at most (5 px samples),
// clear of the grid's top and bottom edges, where a longer selection could stand cut off.
export const oneRowSelected = (pattern: string) => /^0+1{1,5}0+$/.test(pattern);

const mouseAside = () => xdo("mousemove", String(CATALOGUE.mouseAside[0]), String(CATALOGUE.mouseAside[1]));

interface CatalogueFailure { row: number; dialog: string; screenshot: string }

// The size of the next batch after one of `size` rows `loaded`, was `refused` or held only loaded rows
// (`skipped`): half after a refusal; after a load a quarter more (at least one row more), up to `max`. Each refusal
// costs a download refused and its dialog, so the size grows from the last one that loaded instead of starting over
// at `max`.
export function nextBatchSize(size: number, outcome: "loaded" | "refused" | "skipped", max: number): number {
  if (outcome === "refused") return Math.max(1, Math.ceil(size / 2));
  if (outcome === "loaded") return Math.min(max, Math.ceil(size * 1.25));
  return size;
}

// Whether the toolbar's Herunterladen is enabled: its dark label (darkest pixel 0.19 measured) against the grey
// of a disabled one (0.58).
const downloadEnabled = (png: string) => measure(png, CATALOGUE.downloadText, ["-colorspace", "Gray", "-format", "%[fx:minima]"]) < 0.4;

// The catalogue grid once it holds still (the keys sent to it worked off): a screenshot and the grid's pixels as
// one hash. ETS works off the keys of a walk down thousands of rows for minutes: `timeoutMs` grows with them.
async function settledGrid(s: Screen, timeoutMs = 60_000): Promise<{ png: string; hash: string }> {
  const until = Date.now() + timeoutMs;
  let before = "";
  for (;;) {
    await sleep(500);
    const png = s.snap();
    const hash = execFileSync("magick", [png, ...crop(AT.catalogueGrid), "-format", "%#", "info:"], { encoding: "utf8" }).trim();
    if (hash === before) return { png, hash };
    if (Date.now() > until) fail(`the catalogue grid does not hold still within ${timeoutMs / 1000} s`);
    before = hash;
  }
}

// The selection set to `size` rows from row `from` (counted from 0 down the grid). `moved` false: Down left the
// grid's pixels as they were, as at its last row, or with the keyboard focus outside it; `atEnd`: the batch's last
// shift+Down left the grid as it was, as at the grid's end (or where that key did not arrive): a refused batch at its
// end is selected again from the grid's first row; the walk itself ends only where Down moves nothing. Where the keyboard focus is: "top", nowhere known (the walk starts
// at the grid's first row); "before", on the row before `from` (it stays in the grid while the toolbar is clicked,
// and through a refusal); "selected", the selection already holds the batch.
type Focus = "top" | "before" | "selected";
async function selectRows(s: Screen, from: number, size: number, focus: Focus): Promise<{ moved: boolean; atEnd: boolean }> {
  if (focus === "selected") return { moved: true, atEnd: false };
  const fresh = focus === "top";
  if (fresh) {
    // Scrolled to the top, the first catalogue row stands under the first manufacturer's header.
    const g = AT.catalogueGrid;
    xdo("mousemove", "--sync", String(CATALOGUE.firstRow[0]), String(g.y + Math.round(g.h / 2)), "click", "--repeat", "3000", "--delay", "1", "4");
    click(CATALOGUE.firstRow[0], CATALOGUE.firstRow[1]);
    key("ctrl+Home");
    if (from > 1) xdo("key", "--delay", "4", "--repeat", String(from - 1), "Down");
  }
  if (!fresh || from > 0) {
    // 4,500 rows took ETS over two minutes; a minute and 50 ms per row leaves room.
    const before = (await settledGrid(s, fresh ? 60_000 + from * 50 : 60_000)).hash;
    key("Down");
    if ((await settledGrid(s)).hash === before) return { moved: false, atEnd: false };
  }
  if (size === 1) return { moved: true, atEnd: false };
  if (size > 2) xdo("key", "--delay", "30", "--repeat", String(size - 2), "shift+Down");
  // The last row of the batch selected on its own: where it leaves the grid as it was, the grid ended before it.
  const short = (await settledGrid(s)).hash;
  key("shift+Down");
  return { moved: true, atEnd: (await settledGrid(s)).hash === short };
}

// How one download ended: ETS6.log's end of the import, or its refusal (ETS's dialog, kept as a screenshot before
// it is confirmed); ETS's dialogs after it (the manufacturers' data merged) waited out.
async function downloadOutcome(s: Screen, since: string): Promise<{ ok: true } | { ok: false; dialog: string; png: string }> {
  const until = Date.now() + 15 * 60_000;
  let logged = 0;
  for (;;) {
    await sleep(3000);
    if (etsLogHas(since, "Import products took")) break;
    const png = s.snap(), box = dialogBox(png);
    const text = box ? words(png, box).map((w) => w.text).join(" ") : "";
    if (box && !/fehlgeschlagen|Importiere|Zusammenf|Download aus/i.test(text)) fail(`ETS shows a dialog during the catalogue download: ${text.slice(0, 200)}`);
    if (box && /fehlgeschlagen/i.test(text)) {
      const kept = png.replace(/\.png$/, "-refused.png");
      copyFileSync(png, kept);
      const ok = findText(dialogButtons(png, box), "OK")[0] ?? fail(`no OK under ETS's refusal: ${text.slice(0, 160)}`);
      click(ok.cx, ok.cy);
      await waitNoDialog(s);
      return { ok: false, dialog: text, png: kept };
    }
    // ETS6.log can name the refusal before its dialog shows: the dialog is waited for.
    if (!logged && etsLogHas(since, "WebException", /ObjectModel\.Operation/)) logged = Date.now();
    if (logged && Date.now() - logged > 60_000) fail("ETS6.log names a refused catalogue download, but ETS shows no dialog for it");
    if (Date.now() > until) fail("a catalogue download did not end within 15 min");
  }
  await waitNoDialog(s);
  return { ok: true };
}

// ETS's progress dialogs ("Importiere Daten") waited out; any other dialog fails.
async function waitNoDialog(s: Screen): Promise<void> {
  const until = Date.now() + 15 * 60_000;
  for (let clear = 0; clear < 2;) {
    await sleep(2000);
    const png = s.snap(), box = dialogBox(png);
    if (!box) { clear++; continue; }
    clear = 0;
    const text = words(png, box).map((w) => w.text).join(" ");
    if (!/Importiere|Zusammenf|Download aus/i.test(text)) fail(`ETS shows a dialog during the catalogue download: ${text.slice(0, 200)}`);
    if (Date.now() > until) fail("ETS's import dialog did not end within 15 min");
  }
}

// The whole catalogue grid loaded in batches of at most `batch` rows, from row `from`. Needs a project open with the
// catalogue panel showing the whole catalogue (its search empty). Refused rows and their screenshots go to `out`;
// <out>/progress.json holds the next row, the batch size and every refused row, an earlier run's too, after every
// batch.
async function downloadCatalogue(batch: number, out: string, from: number): Promise<CatalogueFailure[]> {
  mkdirSync(out, { recursive: true });
  const s = new Screen(out);
  if (!projectTabOpen(s) || /bersicht$/.test(etsTitle())) fail(`no project in front in ETS (${etsTitle() || "no window"})`);
  if (!findText(s.look(CATALOGUE.header).ws, "Katalog").length) fail("ETS shows no catalogue panel");
  if (!findText(s.look(CATALOGUE.search).ws, "Suchen").length) fail("the catalogue's search is not empty: the grid would not show the whole catalogue");
  const progress = join(out, "progress.json");
  const before = existsSync(progress) ? JSON.parse(readFileSync(progress, "utf8")) as { row: number; size?: number; failures: CatalogueFailure[] } : null;
  let failures = before?.failures ?? [];
  // A run resumed where the last one stopped starts at the last one's batch size.
  let row = from, size = before?.row === from && before.size ? Math.min(before.size, batch) : batch;
  let focus: Focus = "top";
  const save = (done: boolean) => writeFileSync(progress, `${JSON.stringify({ row, size, ...(done ? { done } : {}), failures }, null, 1)}\n`);
  try {
    for (;;) {
      let sel = await selectRows(s, row, size, focus);
      // Down that moves nothing ends the walk only from the grid's first row: the keyboard focus may have left it.
      if (!sel.moved && focus !== "top") { focus = "top"; sel = await selectRows(s, row, size, focus); }
      if (!sel.moved) break;
      focus = "before";
      mouseAside();
      const selected = await settledGrid(s);
      if (!downloadEnabled(selected.png)) { row += size; size = nextBatchSize(size, "skipped", batch); save(false); continue; }
      const pattern = selectionPattern(selected.png);
      const since = etsClock();
      click(CATALOGUE.download[0], CATALOGUE.download[1]);
      const r = await downloadOutcome(s, since);
      // A refused download keeps the selection, its anchor on the batch's first row and the keyboard focus on its
      // last. Where the grid shows another selection after it, or the batch ran into the grid's end (its last row
      // is not `size` rows down), the next batch is selected from the grid's first row.
      let kept = false;
      if (!r.ok) {
        mouseAside();
        kept = !sel.atEnd && pattern.includes("1") && selectionPattern((await settledGrid(s)).png) === pattern;
      }
      if (r.ok) step(`rows ${row}-${sel.atEnd ? "the grid's end" : row + size - 1} loaded`);
      else if (size > 1) {
        renameSync(r.png, join(out, `refused-rows-${row}-${row + size - 1}.png`));
        const half = nextBatchSize(size, "refused", batch);
        if (kept) {
          // The selection shrunk from its end to the half batch: it stays anchored on the batch's first row, so a
          // key that does not arrive leaves the batch larger, never elsewhere. One that moves nothing at all went
          // elsewhere.
          const full = (await settledGrid(s)).hash;
          xdo("key", "--delay", "30", "--repeat", String(size - half), "shift+Up");
          mouseAside();
          kept = (await settledGrid(s)).hash !== full;
        }
        step(`rows ${row}-${row + size - 1} refused, again by ${half}${kept ? "" : " from the grid's first row"}`);
        focus = kept ? "selected" : "top";
        size = half;
        save(false);
        continue;
      } else if (!oneRowSelected(pattern)) {
        // A selection that kept more rows than one, as shift keys that did not arrive leave it, is selected again
        // from the grid's first row.
        step(`row ${row} refused, but more than one row was selected: again from the grid's first row`);
        focus = "top";
        continue;
      } else {
        const screenshot = join(out, `failed-row-${row}.png`);
        renameSync(r.png, screenshot);
        failures = [...failures.filter((f) => f.row !== row), { row, dialog: r.dialog, screenshot }];
        step(`row ${row} refused alone: ${r.dialog.slice(0, 120)}`);
        focus = kept ? "before" : "top";
      }
      row += size;
      size = nextBatchSize(size, r.ok ? "loaded" : "refused", batch);
      save(false);
    }
  } catch (e) {
    try { shot(join(out, `driver-failed-row-${row}.png`)); } catch { /* the failure stays the one thrown */ }
    throw e;
  } finally { s.clean(); }
  save(true);
  return failures;
}

// ---- the simulator on this machine ----

interface Sim { stop(): Promise<void> }

// The simulators running, each by its stop: a batch stopped by a signal stops them, so none keeps the port.
const runningSims = new Set<() => Promise<void>>();
const stopAllSims = () => Promise.allSettled([...runningSims].map((stop) => stop()));

// The simulator serving a unit on `port` (its proxy; the server one below), its output kept in <log>.serve.txt.
// `unit`: tools/sim-unit-serve.ts's arguments that name it (an own unit, or an application with --product, --donor
// and --learned-from).
function startSim(unit: string[], log: string, port: number, advertise: string, overrides: string[] = []): Promise<Sim> {
  const out = `${log}.serve.txt`;
  const child = spawn("bun", ["run", join(import.meta.dir, "sim-unit-serve.ts"), ...unit, "--tool", "ETS", "--log", log, "--port", String(port - 1), "--proxy-port", String(port), "--advertise", advertise, ...overrides.flatMap((o) => ["--override", o])], {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  let text = "";
  child.stdout.on("data", (d: Buffer) => { text += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { text += d.toString(); });
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  // SIGINT makes it print its refusals; one that does not end within 10 s is killed.
  const stop = async () => {
    child.kill("SIGINT");
    const t = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(t);
    runningSims.delete(stop);
    // The row's directory may be gone (moved aside) by the time a signal stops a simulator that ended long before.
    if (existsSync(dirname(out))) writeFileSync(out, text);
  };
  runningSims.add(stop);
  // A catalogue unit takes its time to build (5 to 6 s each on the driver's machine), and one with what the identity
  // loop learned is built once per ETS6.log and once more to serve.
  const startMs = 90_000;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const check = setInterval(() => {
      if (!text.includes(`connects to :${port}`)) return;
      clearTimeout(t); clearInterval(check);
      resolve({ stop });
    }, 200);
    const t = setTimeout(() => { timedOut = true; clearInterval(check); void stop().finally(() => reject(new Error(`the simulator did not start within ${startMs / 1000} s: ${text}`))); }, startMs);
    child.on("exit", (code, sig) => { runningSims.delete(stop); if (timedOut) return; clearTimeout(t); clearInterval(check); reject(new Error(`the simulator ended (${sig ?? `exit ${code}`}): ${text}`)); });
  });
}

const frameCount = (log: string) => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes("ETS->BRIDGE TUNNELLING_REQ")).length : 0;

// ---- the row ----

interface RowOptions {
  // An own unit's id (tools/sim-units.ts), or the id of an application without one (its catalogue unit).
  unit: string; variant: string; orderNumber?: string; simulator: string; project: string; configured: boolean;
  passwordEnv?: string; out?: string; stopSimAfter?: number; wrongInterface?: string;
  // Properties the simulator answers otherwise than its unit (tools/sim-unit-serve.ts --override): a wrong identity.
  simOverrides: string[];
  // A catalogue unit's donor where not its rule's, and the ETS6.log files of the earlier runs the identity loop
  // learns from, in order.
  donor?: string; learnedFrom: string[];
  // A failure made on purpose once the project is compressed (batch --inject-kill, --inject-dialog).
  inject?: "kill" | "dialog";
}

// How a row ended: ETS's outcome, or no unit for it (sim-refused); a driver failure with its class.
interface RowRun {
  dir: string; outcome: EtsOutcome | { kind: "sim-refused"; why: string }; minutes: number;
  // recovered: ETS was brought back after a driver failure (its dialogs closed, or restarted).
  failure?: FailureClass; recovered: boolean; unit?: RowSpec["unit"]; catalogueSpec?: CatalogueUnitSpec; simRefusals: string[];
}

// No catalogue unit for the row (no donor of its mask, a product identity the donor cannot carry).
class NoUnit extends Error {}

const isOwnUnit = (id: string) => SIM_UNITS.some((u) => u.id === id);
// Where a catalogue row's project export right after the insert lies while the row runs.
const productFile = (application: string) => join(tmpdir(), "ets-driver-product", `${application}-${process.pid}.knxproj`);

// The application of the one device of an exported project (deviceApplication).
function insertedApplication(bytes: Buffer, password: string | undefined): string {
  const devices = loadKnxproj(bytes, password, "export").devices;
  if (devices.length !== 1) fail(`the project holds ${devices.length} devices after the insert, not one`);
  return deviceApplication(devices[0]);
}

// A device's application as the project's product data name it (Device.appProgramId: on hardware with a PEI program
// its Hardware2Program's id carries both programs' numbers, which appProgramId alone would read as one). Refused
// where they name none Busforge can tell apart from a PEI program.
function deviceApplication(d: { ia: string; appRef: string; appProgramId: string }): string {
  return d.appProgramId || fail(`the product data name no one application of the device ${d.ia} (${d.appRef})`);
}

// Whether ETS's window is gone; a bench host that does not answer says nothing about it.
const etsGone = () => { try { return !etsTitle(); } catch { return false; } };

async function runRow(o: RowOptions): Promise<RowRun> {
  const t0 = Date.now();
  const ownSpec = isOwnUnit(o.unit) ? simUnitSpec(o.unit) : null;
  if (!ownSpec && !/^M-[0-9A-F]{4}_A-[0-9A-F]{4}-[0-9A-F]{2}-[0-9A-F]{4}(?:-O[0-9A-F]+)?$/.test(o.unit)) throw new Error(`${o.unit} is neither an own unit nor an application id`);
  if (!ownSpec && o.configured) throw new Error("--configured takes an own unit: the project's device runs its application");
  if (!ownSpec && o.simOverrides.length) throw new Error("--sim-override is for an own unit; a catalogue unit takes what ETS required from --learned-from");
  if (ownSpec && (o.donor !== undefined || o.learnedFrom.length)) throw new Error("--donor and --learned-from are for an application without an own unit");
  const applicationId = ownSpec ? ownSpec.catalogue.replace(/\.xml\.gz$/, "") : o.unit;
  const dir = o.out ?? join(tmpdir(), "ets-sweep-rows", applicationId, o.variant);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty: a row is written once`);
  mkdirSync(dir, { recursive: true });
  const [simHost, portText] = o.simulator.split(":");
  const password = o.passwordEnv === undefined ? undefined : process.env[o.passwordEnv];
  let ia = ownSpec ? numToIa(newSimUnit(ownSpec).deviceIa) : "";
  let unit: RowSpec["unit"] | undefined = ownSpec?.id, catalogueSpec: CatalogueUnitSpec | undefined;
  let simArgs = [o.unit];
  // A catalogue unit's application program, from the project exported right after the insert.
  const product = productFile(applicationId);
  const s = new Screen(dir);
  const log = join(dir, ROW_FILES.ets);
  let since: string | null = null;
  let sim: Sim | null = null, wrong: Sim | null = null, ours = false;
  let outcome: RowRun["outcome"], failure: FailureClass | undefined, recovered = false;
  try {
    since = etsClock();
    if (remote(`lsusb | grep -c 147b || true`).trim() !== "0") console.log("note: the KNX-USB stick is plugged into the bench host; ETS6.log decides which interface ETS used");
    await up();
    ours = true;
    step("dialogs");
    await closeDialogs(s);
    step("project");
    await openProject(s, o.project, o.passwordEnv);
    step("topology");
    await showTopology(s);
    if (!o.configured) {
      step("empty line 1.1");
      await emptyLine(s);
      step("compress");
      await compressProject(s, o.project, o.passwordEnv);
      await showTopology(s);
      if (o.inject === "kill") { step("injected: ETS killed"); killEts(); await sleep(3000); }
      if (o.inject === "dialog") { step("injected: ETS's project details dialog"); click(AT.projectInfo[0], AT.projectInfo[1]); await sleep(3000); }
      settled(s, dir, "insert");
      step("insert");
      await insertProduct(s, o.orderNumber ?? fail("--order is needed to insert the product from the catalogue"), applicationId);
      if (!ownSpec) {
        settled(s, dir, "the product's export");
        step("the product's export");
        mkdirSync(dirname(product), { recursive: true });
        await exportProject(s, o.project, product, password);
        // OCR picked the catalogue row; the export says exactly what it runs.
        const inserted = insertedApplication(readFileSync(product), password);
        if (inserted !== applicationId) fail(`the catalogue row inserted runs ${inserted}, not ${applicationId}`);
        // Only the unit's own refusals (the product's identity, the donor's) end the row sim-refused; anything else (a
        // corpus that does not read) is the driver's.
        const unitRefusal = (e: unknown) => e instanceof Error && /^no (?:catalogue|product) unit:/.test(e.message) ? new NoUnit(e.message) : e;
        let u, cu;
        try {
          u = catalogueUnitFrom(applicationId, readFileSync(product), { donor: o.donor, learnedFrom: o.learnedFrom.map((name) => ({ name, log: readFileSync(name) })) });
          if ("refused" in u) throw new NoUnit(u.refused);
          cu = catalogueUnit(u);
        } catch (e) { throw unitRefusal(e); }
        catalogueSpec = u;
        unit = catalogueUnitRecord(cu);
        ia = numToIa(cu.make().deviceIa);
        simArgs = [applicationId, "--product", product, "--donor", u.donor.id, ...o.learnedFrom.flatMap((f) => ["--learned-from", f])];
        console.log(`catalogue unit of ${applicationId} on donor ${u.donor.id}${o.learnedFrom.length ? `, learned from ${o.learnedFrom.length} runs` : ""}`);
      }
      settled(s, dir, "address");
      step("address");
      await setAddress(s, ia);
    }
    settled(s, dir, "simulator");
    step("simulator");
    sim = await startSim(simArgs, log, Number(portText), simHost, o.simOverrides);
    if (o.wrongInterface) wrong = await startSim(simArgs, join(dir, "wrong-interface.log"), Number(o.wrongInterface.split(":")[1]), simHost);
    step("interface");
    await selectInterface(s, o.wrongInterface ?? o.simulator);
    if (o.configured) await selectByAddress(s, ia);
    else {
      const dev = await lineDeviceRow(s);
      click(dev.cx, dev.cy);
      await sleep(1500);
      await checkAddress(s, ia);
    }
    settled(s, dir, "download");
    step("download");
    const started = etsClock();
    key("ctrl+alt+shift+d");
    for (let i = 0; !etsLogHas(started, `StartLoadDevice(Application) ${ia} `); i++) {
      if (i === 15) fail(`ETS did not start the application download of ${ia} within 30 s of its shortcut`);
      await sleep(2000);
    }
    const until = Date.now() + 300_000;
    for (;;) {
      if (o.stopSimAfter !== undefined && sim && frameCount(log) >= o.stopSimAfter) { await sim.stop(); sim = null; console.log(`stopped the simulator after ${o.stopSimAfter} frames of ETS`); }
      // The task's end, or the exception that ended it (tools/ets-sweep.ts etsOutcome).
      if (etsLogHas(started, `End LoadApplicationProgram ${ia} `) || etsLogHas(started, "Knx.Ets.Hawk.LoadDeviceTask - ", ETS_TASK_FAILED)) break;
      // ETS shows no dialog while it downloads; one before the task's end ("Verbindung auswählen": the simulator's
      // connection not available) ends the row with its text at once.
      settled(s, dir, "the download's end");
      if (Date.now() > until) fail(`ETS did not end the download of ${ia} within 300 s`);
      await sleep(2000);
    }
    // ETS closes the tunnel after the task; the capture is whole then.
    for (let i = 0; i < 20 && sim && !readFileSync(`${log}.sim.txt`, "utf8").includes("closed by the client"); i++) await sleep(500);
    etsLogSince(since, join(dir, ROW_FILES.ets6log));
    outcome = etsOutcome(readFileSync(join(dir, ROW_FILES.ets6log), "latin1"), ia, o.simulator);
    if (outcome.kind !== "completed") { shot(join(dir, "failure.png")); await closeDialogs(s); }
    if (o.configured) await clearSearch();
    settled(s, dir, "export");
    step("export");
    await exportProject(s, o.project, join(dir, "export.knxproj"), password);
    writeRow(dir, unit!, o.simulator, applicationId, ia, password, !o.configured);
  } catch (e) {
    if (e instanceof NoUnit) {
      // No unit, no download: ETS keeps the inserted device until the next row empties the line.
      outcome = { kind: "sim-refused", why: e.message };
      writeFileSync(join(dir, "sim-refused.txt"), `${e.message}\n`);
      console.error(`sim-refused: ${e.message}`);
    } else {
      // Every other failure of the row is the driver's: its reason first, then what evidence can still be taken.
      let why = e instanceof DriverFailure ? e.message : `the driver broke off: ${e instanceof Error ? e.message : String(e)}`;
      // ETS gone under a step fails it with whatever that step met.
      if (ours && etsGone() && !why.startsWith("ETS's window is gone")) why = `ETS's window is gone: ${why}`;
      failure = classifyFailure(why);
      outcome = { kind: "driver-failed", why };
      writeFileSync(join(dir, "driver-failed.txt"), `${why}\n`);
      console.error(`driver-failed (${failure.kind}${"reason" in failure ? ` ${failure.reason}` : ""}): ${why}`);
      const evidence = (what: string, take: () => void) => { try { take(); } catch (x) { writeFileSync(join(dir, "driver-failed.txt"), `no ${what}: ${x instanceof Error ? x.message : String(x)}\n`, { flag: "a" }); } };
      evidence("screenshot", () => shot(join(dir, "failure.png")));
      if (since !== null) {
        const from = since;
        evidence("ETS6.log", () => {
          etsLogSince(from, join(dir, ROW_FILES.ets6log));
          writeFileSync(join(dir, "ets6.log.tail.txt"), readFileSync(join(dir, ROW_FILES.ets6log)).toString("latin1").split("\n").slice(-200).join("\n"), "latin1");
        });
      }
      // Recovery only for an ETS this driver runs, and not where the batch pauses (the host does not answer, a login
      // or the catalogue waits with its dialog). ETS not brought back pauses the batch: no later row could run.
      const recover = failure.kind === "restart" ? () => restartEts() : () => closeDialogs(s).catch(() => restartEts());
      if (failure.kind !== "pause") {
        try {
          if (!ours) throw new Error("this driver did not start ETS for the row");
          await recover();
          recovered = true;
        } catch (x) {
          const not = `ETS not recovered: ${x instanceof Error ? x.message : String(x)}`;
          console.error(not);
          failure = classifyFailure(`${not} (after: ${why})`);
          if (failure.kind !== "pause") failure = { kind: "pause", reason: "ets", why: `${not} (after: ${why})` };
        }
      }
    }
  } finally {
    if (sim) await sim.stop();
    if (wrong) await wrong.stop();
    s.clean();
    rmSync(product, { force: true });
  }
  if (!existsSync(`${log}.sim.txt`)) writeFileSync(`${log}.sim.txt`, "");
  const refusals = simRefusals(readFileSync(`${log}.sim.txt`, "utf8"));
  if (refusals.length) console.log(`the simulator refused ${refusals.length}: ${refusals[0]}`);
  return { dir, outcome, minutes: (Date.now() - t0) / 60_000, failure, recovered, unit, catalogueSpec, simRefusals: refusals };
}

// ---- the batch ----

const IDENTITY_ROUNDS = 3;
const HEARTBEAT_MS = 3 * 60_000;
const HA_URL = process.env.HA_URL ?? "http://192.168.1.18:8123";

// The bench host kept awake: Home Assistant's switch.x390_wach on (without it the host sleeps in the evening).
async function hostKeptAwake(): Promise<void> {
  const token = process.env.HA_TOKEN ?? fail("HA_TOKEN is not set: the batch reads Home Assistant's switch.x390_wach before it starts");
  const r = await fetch(`${HA_URL}/api/states/switch.x390_wach`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) fail(`Home Assistant answers ${r.status} for switch.x390_wach`);
  const state = ((await r.json()) as { state?: unknown }).state;
  if (state !== "on") fail(`switch.x390_wach is ${String(state)}: the bench host would sleep in the evening; switch it on first`);
}

interface BatchOptions {
  list: string; out: string; only?: string[]; from?: string; count?: number; rerunFailed: boolean; rerun: string[];
  simulator: string; project: string; injectKill?: string; injectDialog?: string;
}

// One row of the batch, run until it has a result: once more after ETS was restarted under it, again for each round
// of the identity loop. A pause returns without a result.
async function batchRow(row: ListRow, b: BatchOptions, inject: RowOptions["inject"]): Promise<RowResult | { pause: FailureClass }> {
  const t0 = Date.now(), startedAt = new Date().toISOString();
  const dir = rowDirOf(b.out, row.application);
  const attempts: Attempt[] = [];
  const own = SIM_UNITS.find((u) => u.catalogue === `${row.application}.xml.gz`)?.id;
  const result = (kind: RowKind, why: string | undefined, extra: Partial<RowResult> = {}): RowResult => ({
    format: RESULT_FORMAT, application: row.application, manufacturer: row.manufacturer, mask: row.mask, orderNumber: row.orderNumber,
    kind, ...(why === undefined ? {} : { why }), minutes: (Date.now() - t0) / 60_000, startedAt, endedAt: new Date().toISOString(), attempts, ...extra,
  });
  // The driver downloads one application into one unit; a second program that is an application of its own it does
  // not drive (ETS's PEI programs it does: ETS downloads them with the application).
  const second = (row.secondProgram ?? []).filter((p) => p.programType !== "PeiProgram");
  if (second.length) {
    mkdirSync(dir, { recursive: true });
    return result("driver-failed", `refused: the hardware's second program ${second.map((p) => `${p.application} (${p.programType ?? "not loaded"})`).join(", ")} is no PEI program; a row downloads one application`);
  }
  const learned: string[] = [];
  let restarted = false;
  for (;;) {
    const r = await runRow({ unit: own ?? row.application, variant: VARIANT, orderNumber: row.orderNumber, simulator: b.simulator, project: b.project, configured: false, out: dir, simOverrides: [], learnedFrom: [...learned], inject });
    inject = undefined;
    const why = "why" in r.outcome ? r.outcome.why : undefined;
    if (r.failure?.kind === "pause") return { pause: r.failure };
    // Once more after ETS was brought back (a failed recovery pauses the batch: runRow).
    if (r.failure?.kind === "restart" && r.recovered && !restarted) {
      restarted = true;
      attempts.push({ kind: "restarted", why, minutes: r.minutes, dir: moveAttempt(b.out, row.application) });
      appendLog(b.out, `${row.application}: ETS restarted (${r.failure.reason}), the row runs again: ${why}`);
      continue;
    }
    const kind: RowKind = r.outcome.kind;
    // What the unit refused is named; whether it counts against the row tools/ets-sweep.ts judges (a refusal after the
    // unit's last restart may not).
    let more = r.simRefusals.length ? `; the simulator refused ${r.simRefusals.length}: ${r.simRefusals[0]}` : "";
    // The identity loop: what ETS required of the catalogue unit, learned from this run's ETS6.log, for the next run.
    if (kind === "ets-failed" && r.catalogueSpec && !r.simRefusals.length) {
      const ets6log = join(dir, ROW_FILES.ets6log);
      const l = learned.length >= IDENTITY_ROUNDS ? { refused: `${IDENTITY_ROUNDS} rounds of the identity loop ran` } : learnIdentity(r.catalogueSpec, readFileSync(ets6log));
      if (!("refused" in l)) {
        const moved = moveAttempt(b.out, row.application);
        attempts.push({ kind: "identity", why: l.learned.map((m) => m.line).join("; "), minutes: r.minutes, dir: moved });
        learned.push(join(moved, ROW_FILES.ets6log));
        appendLog(b.out, `${row.application}: the identity loop learned ${l.learned.map((m) => `${m.object}/${m.pid}`).join(", ")}, the row runs again`);
        continue;
      }
      more += `; identity loop: ${l.refused}`;
    }
    if (r.failure?.kind === "restart" && restarted) more += "; ETS was gone or failed under the row again after its restart";
    attempts.push({ kind, why, minutes: r.minutes });
    const screenshot = ["dialog.png", "failure.png"].find((f) => existsSync(join(dir, f)));
    const unitName = r.unit === undefined ? undefined : typeof r.unit === "string" ? r.unit : `donor ${r.unit.donor}`;
    return result(kind, why === undefined && !more ? undefined : `${why ?? ""}${more}`.replace(/^; /, ""), { ...(unitName ? { unit: unitName } : {}), ...(screenshot && kind !== "completed" ? { screenshot } : {}) });
  }
}

async function runBatch(b: BatchOptions): Promise<number> {
  const list = JSON.parse(readFileSync(b.list, "utf8")) as CatalogueList;
  const format: unknown = list.format;
  if (format !== CATALOGUE_LIST_FORMAT) throw new Error(`${b.list} is of format ${String(format)}, not ${CATALOGUE_LIST_FORMAT}`);
  const rows = batchRows(list, { only: b.only, from: b.from, count: b.count });
  for (const a of b.rerun) if (!rows.some((r) => r.application === a)) throw new Error(`--rerun ${a} is no row of the batch`);
  mkdirSync(b.out, { recursive: true });
  await hostKeptAwake();
  const plan = planBatch(b.out, rows, { kinds: b.rerunFailed ? ["driver-failed"] : [], applications: b.rerun });
  // A failure on purpose needs a row that runs.
  for (const a of [b.injectKill, b.injectDialog]) if (a !== undefined && !plan.run.some((r) => r.application === a)) throw new Error(`${a} is no row this batch runs (not in it, or it has a result)`);
  const say = (text: string) => { appendLog(b.out, text); console.error(text); };
  say(`batch of ${rows.length} rows of ${b.list}: ${plan.finished.length} with a result, ${plan.run.length} to run`);
  let at = { n: 0, application: "", t0: Date.now() };
  const heartbeat = setInterval(() => say(heartbeatLine(at.n, rows.length, at.application, currentStep, (Date.now() - at.t0) / 60_000)), HEARTBEAT_MS);
  // A batch stopped by a signal stops its simulator and writes no result after it; the row it ran runs again on resume.
  let stopping: string | null = null;
  const stopped = (sig: "SIGINT" | "SIGTERM") => {
    if (stopping) return;
    stopping = sig;
    void stopAllSims().finally(() => {
      rmSync(productFile(at.application), { force: true });
      say(`stopped by ${sig} at row ${at.n}/${rows.length} ${at.application}`);
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGINT", () => stopped("SIGINT"));
  process.on("SIGTERM", () => stopped("SIGTERM"));
  try {
    for (const row of plan.run) {
      if (stopping) return 1;
      at = { n: rows.indexOf(row) + 1, application: row.application, t0: Date.now() };
      const aside = clearRowDir(b.out, row.application, new Date().toISOString().replace(/[:.]/g, "-"));
      if (aside) say(`${row.application}: what an earlier run left is moved to ${aside}`);
      const inject = row.application === b.injectKill ? "kill" : row.application === b.injectDialog ? "dialog" : undefined;
      const r = await batchRow(row, b, inject);
      if (stopping) return 1;
      if ("pause" in r) {
        say(`paused at row ${at.n}/${rows.length} ${row.application} (${"reason" in r.pause ? r.pause.reason : r.pause.kind}): ${r.pause.why}`);
        return 3;
      }
      writeResult(b.out, r);
      say(rowLine(at.n, rows.length, r));
    }
  } catch (e) {
    // Whatever breaks the batch itself is in its log, the row without a result.
    say(`stopped at row ${at.n}/${rows.length} ${at.application} by an error of the batch: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally { clearInterval(heartbeat); }
  say(`batch done: ${summary(loggedRows(readFileSync(join(b.out, BATCH_LOG), "utf8")).filter((l) => rows.some((r) => r.application === l.application)))}`);
  return 0;
}

// ---- the command line ----

// Options from `args` on: those with a value (each once, `repeatable` ones as often as given) and the `flags`
// without one; anything else is refused.
function parseOptions(args: string[], valued: string[], repeatable: string[], flags: string[]): { one: (n: string) => string | undefined; all: (n: string) => string[]; flag: (n: string) => boolean } {
  const values = new Map<string, string[]>(), set = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if (args[i].startsWith("--") && flags.includes(name)) { set.add(name); continue; }
    if (!args[i].startsWith("--") || !(valued.includes(name) || repeatable.includes(name))) throw new Error(`unknown argument ${args[i]}`);
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (values.has(name) && !repeatable.includes(name)) throw new Error(`--${name} given twice`);
    values.set(name, [...(values.get(name) ?? []), v]);
  }
  return { one: (n) => values.get(n)?.[0], all: (n) => values.get(n) ?? [], flag: (n) => set.has(n) };
}
const endpoint = (n: string, v: string | undefined) => { if (v !== undefined && !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) throw new Error(`--${n} ${v} is not <ipv4>:<port>`); return v; };
const DEFAULT_SIMULATOR = "192.168.1.105:3701", DEFAULT_PROJECT = "Busforge Sweep";

function rowOptions(args: string[]): RowOptions {
  const [unit, variant] = args;
  if (!unit || !variant || unit.startsWith("--") || variant.startsWith("--")) throw new Error("usage: bun run tools/ets-driver.ts row <unit> <variant> --order <order number> [...] (see the file's head)");
  const o = parseOptions(args.slice(2), ["order", "simulator", "project", "password-env", "out", "stop-sim-after", "wrong-interface", "donor"], ["sim-override", "learned-from"], ["configured"]);
  const stop = o.one("stop-sim-after");
  if (stop !== undefined && !/^[1-9]\d*$/.test(stop)) throw new Error(`--stop-sim-after ${stop} is no frame count`);
  return {
    unit, variant, configured: o.flag("configured"), orderNumber: o.one("order"), simulator: endpoint("simulator", o.one("simulator")) ?? DEFAULT_SIMULATOR,
    project: o.one("project") ?? DEFAULT_PROJECT, passwordEnv: o.one("password-env"), out: o.one("out"),
    stopSimAfter: stop === undefined ? undefined : Number(stop), wrongInterface: endpoint("wrong-interface", o.one("wrong-interface")), simOverrides: o.all("sim-override"),
    donor: o.one("donor"), learnedFrom: o.all("learned-from"),
  };
}

function batchOptions(args: string[]): BatchOptions {
  const [list] = args;
  if (!list || list.startsWith("--")) throw new Error("usage: bun run tools/ets-driver.ts batch <catalogue-list.json> --out <dir> [...] (see the file's head)");
  const o = parseOptions(args.slice(1), ["out", "only", "from", "count", "simulator", "project", "inject-kill", "inject-dialog"], ["rerun"], ["rerun-failed"]);
  const out = o.one("out") ?? fail("--out <dir> is needed: the batch's rows and its log go there");
  const count = o.one("count");
  if (count !== undefined && !/^[1-9]\d*$/.test(count)) throw new Error(`--count ${count} is no number of rows`);
  const only = o.one("only");
  return {
    list, out, only: only === undefined ? undefined : readFileSync(only, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
    from: o.one("from"), count: count === undefined ? undefined : Number(count), rerunFailed: o.flag("rerun-failed"), rerun: o.all("rerun"),
    simulator: endpoint("simulator", o.one("simulator")) ?? DEFAULT_SIMULATOR, project: o.one("project") ?? DEFAULT_PROJECT,
    injectKill: o.one("inject-kill"), injectDialog: o.one("inject-dialog"),
  };
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "up") { await up(); console.log(owned("display.pids").concat(owned("ets.pids")).map((p) => `${p.name} ${p.pid}`).join("\n")); return 0; }
  if (cmd === "down") { await down(); return 0; }
  if (cmd === "import") {
    const [file, flag, env] = rest;
    if (!file || (flag !== undefined && (flag !== "--password-env" || !env)) || rest.length > 3) throw new Error("usage: bun run tools/ets-driver.ts import <project.knxproj> [--password-env <VAR>]");
    console.log(await importProject(file, env));
    return 0;
  }
  if (cmd === "delete") {
    if (rest.length !== 1) throw new Error("usage: bun run tools/ets-driver.ts delete <project name>");
    await deleteProject(rest[0]);
    return 0;
  }
  if (cmd === "shot") { console.log(shot(rest[0] ?? join(tmpdir(), "ets.png"))); return 0; }
  if (cmd === "words") {
    const png = rest[0] ?? shot(join(tmpdir(), "ets.png"));
    for (const w of words(png)) console.log(`${w.x},${w.y} ${w.w}x${w.h} ${w.text}`);
    return 0;
  }
  if (cmd === "xdo") { process.stdout.write(xdo(...rest)); return 0; }
  if (cmd === "type") { typeText(rest.join(" ")); return 0; }
  if (cmd === "same") {
    const [a, b, unit, from] = rest;
    if (!a || !b || !unit || (from !== undefined && !/^\d+$/.test(from))) throw new Error("usage: bun run tools/ets-driver.ts same <ets.log> <ets.log> <unit> [<position in the first to compare from>]");
    const device = newSimUnit(simUnitSpec(unit)).deviceIa;
    const [x, y] = [readFileSync(a, "utf8"), readFileSync(b, "utf8")];
    const d = dialogueDifferences(x, y, device, "ETS", from === undefined ? 0 : Number(from));
    console.log(`${dialogue(x, device).length} and ${dialogue(y, device).length} frames with ${numToIa(device)}, ${d.length} positions differ`);
    for (const l of d.slice(0, 20)) console.log(`  ${l}`);
    return d.length ? 1 : 0;
  }
  if (cmd === "rerun-identity") {
    // The identity loop's rerun step (tools/sim-unit-product.ts) on a row ETS failed: the overrides to run again with.
    const [dir, unit] = rest;
    if (!dir || !unit) throw new Error("usage: bun run tools/ets-driver.ts rerun-identity <row dir> <unit>");
    const r = rerunIdentity(productUnit(catalogueXml(simUnitSpec(unit).catalogue)), readFileSync(join(dir, ROW_FILES.ets6log)));
    if ("refused" in r) { console.log(`refused: ${r.refused}`); return 1; }
    for (const m of r.learned) console.log(`--sim-override ${m.object}/${m.pid}=${m.required.toString("hex")}    (${m.line})`);
    return 0;
  }
  if (cmd === "catalogue-download") {
    const opts = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      const [flag, value] = [rest[i], rest[i + 1]];
      if (!/^--(batch|from|out)$/.test(flag) || value === undefined || value.startsWith("--") || opts.has(flag.slice(2))) throw new Error("usage: bun run tools/ets-driver.ts catalogue-download [--batch <rows>] [--from <row>] [--out <dir>], each once");
      opts.set(flag.slice(2), value);
    }
    const count = (name: string, d: number, min: number) => {
      const v = opts.get(name);
      if (v !== undefined && !/^\d+$/.test(v)) throw new Error(`--${name} takes a whole number from ${min}`);
      const n = v === undefined ? d : Number(v);
      if (n < min) throw new Error(`--${name} takes a whole number from ${min}`);
      return n;
    };
    const out = opts.get("out") ?? join(tmpdir(), "ets-catalogue-download");
    const failures = await downloadCatalogue(count("batch", 40, 1), out, count("from", 0, 0));
    console.log(`${out}: ${failures.length} rows refused${failures.map((f) => `\n  row ${f.row}: ${f.dialog.slice(0, 160)}`).join("")}`);
    return failures.length ? 1 : 0;
  }
  if (cmd === "row") {
    const r = await runRow(rowOptions(rest));
    console.log(`${r.dir}: ${r.outcome.kind}${"why" in r.outcome ? `: ${r.outcome.why}` : ""} (${r.minutes.toFixed(1)} min)`);
    return r.outcome.kind === "completed" ? 0 : 1;
  }
  if (cmd === "batch") return await runBatch(batchOptions(rest));
  throw new Error("usage: bun run tools/ets-driver.ts row|batch|same|rerun-identity|import|delete|catalogue-download|up|down|shot|words|xdo|type ... (see the file's head)");
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (e) { console.error(`ets-driver: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
}
