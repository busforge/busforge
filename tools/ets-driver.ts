#!/usr/bin/env bun
// ETS 6 on the bench host's display, driven from this machine over ssh, for one sweep row (tools/ets-sweep.ts):
// ETS downloads one application into a simulated unit (tools/sim-unit-serve.ts) served from this machine.
//
//   BUSFORGE_CORPUS=... bun run tools/ets-driver.ts row <unit> <variant> --order <order number> \
//     [--simulator <this host's ip>:3701] [--project "Busforge Sweep"] [--password-env <VAR>] [--configured] \
//     [--out <dir>] [--stop-sim-after <frames>] [--wrong-interface <host:port>] [--sim-override <object>/<PID>=<hex>]...
//   BUSFORGE_CORPUS=... bun run tools/ets-driver.ts same <ets.log> <ets.log> <unit>       two runs, frame by frame
//   BUSFORGE_CORPUS=... bun run tools/ets-driver.ts rerun-identity <row dir> <unit>       the identity loop
//   bun run tools/ets-driver.ts up | down | shot <png> | words [<png>] | xdo <args>... | type <text>
//
// THE ROW (runRow). On the bench host ETS runs maximised on the display, German UI, in its own project (no
// password; --project). From scratch (the default): line 1.1 of the project is emptied, the product is
// inserted from the online catalogue by order number (the catalogue row's application read from ETS's
// properties panel and matched to the unit's application id; two catalogue rows with the order number and
// version are refused), its address set to the unit's. --configured instead takes the device the project
// holds at the unit's address as it is configured there. Then the interface is set explicitly to the
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
// --stop-sim-after <n> stops the simulator once ETS sent it n frames (a download ETS aborts); --wrong-interface
// selects another configured connection than the simulator's: both exist to check the verdicts on real logs.
// --sim-override gives the simulator a wrong identity (tools/sim-unit-serve.ts --override), which ETS refuses with
// the properties it required in ETS6.log; rerun-identity reads them (tools/sim-unit-product.ts).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { numToIa } from "../packages/knx/src/index.ts";
import { appProgramId, loadKnxproj } from "../packages/project/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { catalogueXml } from "./corpus.ts";
import { deviceConfiguration, deviceRows, dialogue, dialogueDifferences } from "./etsdiff.ts";
import { ETS_TASK_FAILED, etsOutcome, ROW_FILES, ROW_FORMAT, simRefusals, type EtsOutcome, type RowConfiguration, type RowSpec } from "./ets-sweep.ts";
import { productUnit, rerunIdentity } from "./sim-unit-product.ts";
import { newSimUnit, simUnitSpec } from "./sim-units.ts";

const HOST = process.env.ETS_HOST ?? "tf@192.168.1.231";
const DISPLAY = ":5";
const ETS_BUILD = "ETS 6.4.1 Home (6.4.8718)";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Each step of a row on stderr, with the time: what a run that stalls was doing.
const step = (what: string) => console.error(`${new Date().toISOString().slice(11, 19)} ${what}`);

// ---- the bench host ----

// One ssh call: `command` as ssh's command line, `input` on its stdin; its stdout.
function ssh(command: string, input: string, opts: { timeoutMs?: number; allowFail?: boolean } = {}): Buffer {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST, command], { input, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`on ${HOST} (${r.status}): ${r.stderr.toString().trim()}\n${command === "bash -s" ? input : command}`);
  return r.stdout;
}
// A shell script on the bench host; its stdout.
const remote = (script: string, opts: { timeoutMs?: number; allowFail?: boolean } = {}) => ssh("bash -s", script, opts).toString();

// Where things are on the bench host: ETS's Wine prefix and its log, the driver's state (the PIDs it started,
// the exports; Wine's Z: is the host's root).
interface HostPaths { prefix: string; etsLog: string; state: string; exportDir: string; exportDirWin: string }
let hostPaths: HostPaths | null = null;
function host(): HostPaths {
  if (hostPaths) return hostPaths;
  const [home, user] = remote(`printf '%s\\n%s' "$HOME" "$(id -un)"`).split("\n");
  const prefix = `${home}/ets/prefix`, state = `${home}/ets/sweep-driver`;
  hostPaths = { prefix, etsLog: `${prefix}/drive_c/users/${user}/AppData/Local/KNX/ETS6/Log`, state, exportDir: `${state}/export`, exportDirWin: `Z:${state.replaceAll("/", "\\")}\\export` };
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
// line (psm 7), where sparse text loses its light grey buttons.
const OCR_SCALE = 2;
function tesseract(png: string, region: Region | undefined, scale: number, psm: number, tsv: boolean): string {
  const big = join(dirname(png), `.${basename(png, ".png")}-ocr.png`);
  execFileSync("magick", [png, ...(region ? crop(region) : []), "-resize", `${scale * 100}%`, big]);
  // Leptonica fails to open some absolute paths on macOS (/tmp through its symlink): read it by name from its directory.
  const out = execFileSync("tesseract", [basename(big), "-", "--psm", String(psm), ...(tsv ? ["tsv"] : [])], { cwd: dirname(big), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  rmSync(big, { force: true });
  return out;
}

// The words OCR reads, each with its box (scaled back to the screen) and the id of its OCR line.
function words(png: string, region?: Region, opts: { scale?: number; psm?: number } = {}): Word[] {
  const scale = opts.scale ?? OCR_SCALE;
  const ox = region?.x ?? 0, oy = region?.y ?? 0, s = (v: string) => Math.round(+v / scale);
  return tesseract(png, region, scale, opts.psm ?? 11, true).split("\n").slice(1).flatMap((row) => {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5" || !c[11].trim()) return [];
    return [{ text: c[11].trim(), x: ox + s(c[6]), y: oy + s(c[7]), w: s(c[8]), h: s(c[9]), line: `${c[2]}.${c[3]}.${c[4]}` }];
  });
}

// The text of a region read as one block, line by line.
function textLines(png: string, region: Region): string[] {
  return tesseract(png, region, OCR_SCALE, 6, false).split("\n").map((l) => l.trim()).filter(Boolean);
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
  look(region?: Region): { png: string; ws: Word[] } {
    const png = this.snap();
    return { png, ws: words(png, region) };
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
  clean(): void { for (const f of readdirSync(this.dir)) if (f.startsWith(".screen-")) rmSync(join(this.dir, f), { force: true }); }
}

// Fixed places of ETS 6.4.1 maximised on the 1920x1200 display, read off its screen; each step reads back what
// it changed before the next one relies on it.
const AT = {
  overviewTab: [100, 20], projectTab: [300, 20],
  panelSelector: [262, 93], toolbarInterface: [1716, 57],
  leftTree: { x: 0, y: 105, w: 315, h: 525 }, mainTabs: { x: 315, y: 80, w: 500, h: 28 },
  mainGrid: { x: 315, y: 108, w: 1255, h: 515 }, catalogueGrid: { x: 315, y: 695, w: 1255, h: 465 },
  properties: { x: 1575, y: 80, w: 345, h: 600 }, menuRight: { x: 1500, y: 70, w: 420, h: 300 },
  bottomBar: { x: 0, y: 1165, w: 1570, h: 35 },
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
while read -r n p t; do [ -n "$t" ] && [ "$(st "$p")" = "$t" ] && echo "$n $p $t"; done < "$f"`);
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

async function restartEts(): Promise<void> {
  if (!owned("ets.pids").length) fail("ETS needs a restart, but this driver did not start it");
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
  if (etsTitle() === want) return;
  click(AT.projectTab[0], AT.projectTab[1]);
  await sleep(1500);
  const title = etsTitle();
  if (title === want) return;
  if (title !== "ETS6 - Übersicht") fail(`ETS has another project open (${title || "no ETS window"}); close it first`);
  const card = await s.waitText(name, { x: 60, y: 600, w: 1800, h: 600 }, 20_000, "the project's card on ETS's overview");
  click(card.cx, card.cy);
  if (passwordEnv) {
    const pw = process.env[passwordEnv] ?? fail(`the project's password is not in $${passwordEnv}`);
    await s.waitText("Passwort", undefined, 20_000, "the project's password dialog");
    typeText(pw);
    key("Return");
  }
  // The title names the project exactly: a card of a project whose name only begins so is caught here.
  for (let i = 0; etsTitle() !== want; i++) {
    if (i === 30) fail(`ETS did not open the project ${name} within 60 s (its title: ${etsTitle()})`);
    await sleep(2000);
  }
  await sleep(3000);
}

// The box of the topology tree's row matching `pattern`.
async function treeRow(s: Screen, pattern: RegExp): Promise<Box | null> {
  const { ws } = s.look(AT.leftTree);
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
  if (!(await treeRow(s, LINE_11))) {
    const main = (await treeRow(s, /Haupt/)) ?? fail("the project has no 1.0 IP Hauptlinie in its topology");
    click(8, main.cy);
    await sleep(1500);
  }
}

// Tree rows as OCR reads them: icons come out as stray characters before the text ("{1.1.20 KNX-…"), and the
// project has one TP line, the only "Linie" row that is neither the backbone, the main line nor a search folder.
const iaRow = (ia: string) => new RegExp(`(?<![\\d.])${ia.replace(/\./g, "\\.")}(?![\\d.])`);
const ANY_DEVICE = /(?<![\d.])1\.1\.\d+(?![\d.])/;
const LINE_11 = /^(?!.*(Backbone|Haupt|Keiner|Programmieren)).*Linie\s*$/;

// The sidebar's properties section expanded (ETS opens "Laufende Operationen" instead after a download).
async function showProperties(s: Screen): Promise<void> {
  const { ws } = s.look({ x: 1575, y: 80, w: 345, h: 130 });
  if (findText(ws, "Gruppen").length) {
    const header = findText(ws, "Eigenschaften")[0] ?? fail("no 'Eigenschaften' in the sidebar");
    click(header.cx, header.cy);
    await sleep(1500);
  }
}

// The devices line 1.1 holds, as the main panel lists them with the line selected (its "Geräte" tab, whatever
// the tree shows collapsed): the rows under the list's header. OCR misreads the narrow address cell ("Lil"
// for 1.1.1), so a row counts by the text it carries, not by its address.
async function lineDevices(s: Screen): Promise<{ y: number; text: string }[]> {
  const line = (await treeRow(s, LINE_11)) ?? fail("no line 1.1 in the topology");
  click(line.cx, line.cy);
  await sleep(1500);
  const tab = findText(s.look(AT.mainTabs).ws, "Ger")[0] ?? fail("no 'Geräte' tab with line 1.1 selected");
  click(tab.cx, tab.cy);
  await sleep(1500);
  const { ws } = s.look(AT.mainGrid);
  const header = findText(ws, "Adress")[0] ?? fail("the device list of line 1.1 shows no address column");
  return rows(ws.filter(inside(AT.mainGrid))).filter((r) => r.y > header.y + header.h + 6 && r.words.filter((w) => /[A-Za-z]{3}/.test(w.text)).length >= 2).map((r) => ({ y: Math.round(r.y), text: r.text }));
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

interface CatalogueEntry { orderNumber: string; version: string; deviceType: string; fingerprint: string }

// The properties panel's reading of the selected catalogue row: the Katalog tab's order number, the
// Applikation tab's device type, program version and fingerprint.
async function readCatalogueEntry(s: Screen): Promise<CatalogueEntry> {
  await showProperties(s);
  const tab = async (name: string) => {
    const { ws } = s.look(AT.properties);
    const t = findText(ws, name).find((b) => b.y < 165) ?? fail(`the properties panel shows no ${name} tab for the catalogue row`);
    click(t.cx, t.cy);
    await sleep(1500);
    // The tab's label/value table, read as one block (word by word, OCR drops the dot in "1.1").
    return textLines(s.snap(), { x: AT.properties.x, y: t.y + 20, w: AT.properties.w, h: 200 });
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

// The unit's application as ETS's catalogue shows it: "$0004", "1.1", "F245" for M-0162_A-0004-11-F245.
function catalogueIdentity(applicationId: string): { deviceType: string; version: string; fingerprint: string } {
  const m = applicationId.match(/^M-[0-9A-F]{4}_A-([0-9A-F]{4})-([0-9A-F]{2})-([0-9A-F]{4})(?:-O[0-9A-F]+)?$/) ?? fail(`${applicationId} is no application id`);
  const v = parseInt(m[2], 16);
  return { deviceType: `$${m[1]}`, version: `${v >> 4}.${v & 15}`, fingerprint: m[3] };
}

// The product inserted into line 1.1 from the catalogue: the one catalogue row with the order number whose
// application is the unit's. Two rows with the order number and the unit's version are refused.
async function insertProduct(s: Screen, orderNumber: string, applicationId: string): Promise<void> {
  const want = catalogueIdentity(applicationId);
  const line = (await treeRow(s, LINE_11)) ?? fail("no line 1.1 in the topology");
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
  key("Escape");
  await sleep(1000);
  const grid = { x: AT.catalogueGrid.x, y: header.cy + 37, w: AT.catalogueGrid.w, h: 1160 - header.cy - 37 };
  // Product rows carry a medium cell; the manufacturers' group headers do not. A header ETS left collapsed is
  // opened by its arrow.
  const products = () => rows(s.look(grid).ws.filter(inside(grid))).filter((r) => r.words.some((w) => w.x >= 570 && w.x <= 605 && /^(TP|IP|RF|PL)$/.test(w.text)));
  let items = products();
  if (items.length === 0) {
    for (const h of rows(s.look(grid).ws.filter(inside(grid)))) { click(326, Math.round(h.y)); await sleep(1000); }
    items = products();
  }
  if (items.length === 0) fail(`the catalogue holds no product for order number ${orderNumber}`);
  const entries: (CatalogueEntry & { y: number })[] = [];
  for (const r of items) {
    click(500, Math.round(r.y));
    await sleep(1500);
    entries.push({ ...(await readCatalogueEntry(s)), y: Math.round(r.y) });
  }
  const atVersion = entries.filter((e) => e.orderNumber === orderNumber && e.version === want.version);
  if (atVersion.length > 1) fail(`refused: the catalogue holds ${atVersion.length} applications under order number ${orderNumber} and version ${want.version} (${atVersion.map((e) => `${e.deviceType} ${e.fingerprint}`).join(", ")})`);
  const hit = atVersion.find((e) => e.deviceType === want.deviceType && e.fingerprint === want.fingerprint)
    ?? fail(`no catalogue row with order number ${orderNumber} runs ${applicationId} (read: ${entries.map((e) => `${e.orderNumber} ${e.deviceType} ${e.version} ${e.fingerprint}`).join("; ")})`);
  click(500, hit.y);
  await sleep(1500);
  ({ ws } = s.look(AT.bottomBar));
  if (!findText(ws, "1.1 TP Linie").length) fail("the catalogue's insert target is not line 1.1");
  const add = findText(ws, "Hinzuf").at(-1) ?? fail("no 'Hinzufügen' under the catalogue");
  click(add.cx, add.cy);
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const devices = await lineDevices(s);
    if (devices.length > 1) fail(`line 1.1 holds ${devices.length} devices after the insert`);
    if (devices.length === 1) return;
  }
  fail("the product did not appear in line 1.1");
}

// The device's address set in the properties panel (line 1.1 only).
async function setAddress(s: Screen, ia: string): Promise<void> {
  if (!/^1\.1\.\d+$/.test(ia)) fail(`the driver places devices in line 1.1, not at ${ia}`);
  await showProperties(s);
  const dev = (await treeRow(s, ANY_DEVICE)) ?? fail("no device in line 1.1");
  click(dev.cx, dev.cy);
  await sleep(1500);
  const label = await s.waitText("Physikalische Adresse", AT.properties, 10_000, "the device's properties");
  click(label.x + 110, label.cy + 22);
  key("ctrl+a");
  typeText(ia.split(".")[2]);
  key("Tab");
  await sleep(2000);
  if (!(await treeRow(s, iaRow(ia)))) fail(`the device did not take the address ${ia}`);
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

// The project exported (no password) from ETS's overview into the row as export.knxproj; the export is checked
// to be of that project.
async function exportProject(s: Screen, project: string, dir: string): Promise<void> {
  const h = host();
  click(AT.overviewTab[0], AT.overviewTab[1]);
  const card = await s.waitText(project, { x: 60, y: 600, w: 1800, h: 120 }, 20_000, "the project's card");
  xdo("mousemove", String(card.cx), String(card.y - 80), "sleep", "1", "mousemove", String(card.cx), String(card.y + 84), "sleep", "1");
  const exp = findText(s.look({ x: card.x - 20, y: card.y + 70, w: 270, h: 30 }).ws, "Export")[0] ?? fail("no Export on the project's card");
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
  writeFileSync(join(dir, "export.knxproj"), ssh(`cat ${q(remoteFile)}`, ""));
  remote(`rm -f ${q(remoteFile)}`);
  const exported = loadKnxproj(readFileSync(join(dir, "export.knxproj")), undefined, "export").name;
  if (exported !== project) fail(`the export is of the project ${exported}, not ${project}`);
  click(AT.projectTab[0], AT.projectTab[1]);
  await sleep(2000);
}

// row.json, and configuration.json from the device's configuration in ETS's export.
function writeRow(dir: string, o: RowOptions, applicationId: string, ia: string): void {
  const spec: RowSpec = { format: ROW_FORMAT, unit: o.unit, etsBuild: ETS_BUILD, simulator: o.simulator, export: "export.knxproj" };
  writeFileSync(join(dir, ROW_FILES.row), JSON.stringify(spec, null, 2) + "\n");
  const proj = loadKnxproj(readFileSync(join(dir, "export.knxproj")), undefined, "export");
  const d = proj.devices.find((x) => x.ia === ia) ?? fail(`ETS's export holds no device ${ia}`);
  if (appProgramId(d.appRef) !== applicationId) fail(`ETS's export runs ${appProgramId(d.appRef)} at ${ia}, not ${applicationId}`);
  const c = deviceConfiguration(parseAppConfig(catalogueXml(`${applicationId}.xml.gz`)), deviceRows(proj, d.id));
  const conf: RowConfiguration = { ia, appRef: d.appRef, params: [...c.params], links: c.links, moduleInstances: c.instances, comObjectOverrides: [...c.comObjectOverrides] };
  writeFileSync(join(dir, ROW_FILES.configuration), JSON.stringify(conf, null, 1) + "\n");
}

// ---- the simulator on this machine ----

interface Sim { stop(): Promise<void> }

// The simulator serving `unit` on `port` (its proxy; the server one below), its output kept in <log>.serve.txt.
function startSim(unit: string, log: string, port: number, advertise: string, overrides: string[] = []): Promise<Sim> {
  const out = `${log}.serve.txt`;
  const child = spawn("bun", ["run", join(import.meta.dir, "sim-unit-serve.ts"), unit, "--tool", "ETS", "--log", log, "--port", String(port - 1), "--proxy-port", String(port), "--advertise", advertise, ...overrides.flatMap((o) => ["--override", o])], {
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
    writeFileSync(out, text);
  };
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (!text.includes(`connects to :${port}`)) return;
      clearTimeout(t); clearInterval(check);
      resolve({ stop });
    }, 200);
    const t = setTimeout(() => { clearInterval(check); void stop().then(() => reject(new Error(`the simulator did not start within 20 s: ${text}`))); }, 20_000);
    child.on("exit", () => { clearTimeout(t); clearInterval(check); reject(new Error(`the simulator ended: ${text}`)); });
  });
}

const frameCount = (log: string) => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes("ETS->BRIDGE TUNNELLING_REQ")).length : 0;

// ---- the row ----

interface RowOptions {
  unit: string; variant: string; orderNumber?: string; simulator: string; project: string; configured: boolean;
  passwordEnv?: string; out?: string; stopSimAfter?: number; wrongInterface?: string;
  // Properties the simulator answers otherwise than its unit (tools/sim-unit-serve.ts --override): a wrong identity.
  simOverrides: string[];
}

interface RowRun { dir: string; outcome: EtsOutcome; minutes: number }

async function runRow(o: RowOptions): Promise<RowRun> {
  const t0 = Date.now();
  const spec = simUnitSpec(o.unit);
  const applicationId = spec.catalogue.replace(/\.xml\.gz$/, "");
  const dir = o.out ?? join(tmpdir(), "ets-sweep-rows", applicationId, o.variant);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty: a row is written once`);
  mkdirSync(dir, { recursive: true });
  const [simHost, portText] = o.simulator.split(":");
  const ia = numToIa(newSimUnit(spec).deviceIa);
  const s = new Screen(dir);
  const since = etsClock();
  const log = join(dir, ROW_FILES.ets);
  let sim: Sim | null = null, wrong: Sim | null = null, ours = false;
  let outcome: EtsOutcome;
  try {
    if (remote(`lsusb | grep -c 147b || true`).trim() !== "0") console.log("note: the KNX-USB stick is plugged into the bench host; ETS6.log decides which interface ETS used");
    await up();
    ours = true;
    step("simulator");
    sim = await startSim(o.unit, log, Number(portText), simHost, o.simOverrides);
    if (o.wrongInterface) wrong = await startSim(o.unit, join(dir, "wrong-interface.log"), Number(o.wrongInterface.split(":")[1]), simHost);
    step("dialogs");
    await closeDialogs(s);
    step("project");
    await openProject(s, o.project, o.passwordEnv);
    step("topology");
    await showTopology(s);
    if (!o.configured) {
      step("empty line 1.1");
      await emptyLine(s);
      step("insert");
      await insertProduct(s, o.orderNumber ?? fail("--order is needed to insert the product from the catalogue"), applicationId);
      step("address");
      await setAddress(s, ia);
    } else if (!(await treeRow(s, iaRow(ia)))) fail(`the project holds no device at ${ia}`);
    step("interface");
    await selectInterface(s, o.wrongInterface ?? o.simulator);
    const dev = (await treeRow(s, iaRow(ia))) ?? fail(`no device ${ia} in the topology`);
    click(dev.cx, dev.cy);
    await sleep(1500);
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
      if (Date.now() > until) fail(`ETS did not end the download of ${ia} within 300 s`);
      await sleep(2000);
    }
    // ETS closes the tunnel after the task; the capture is whole then.
    for (let i = 0; i < 20 && sim && !readFileSync(`${log}.sim.txt`, "utf8").includes("closed by the client"); i++) await sleep(500);
    etsLogSince(since, join(dir, ROW_FILES.ets6log));
    outcome = etsOutcome(readFileSync(join(dir, ROW_FILES.ets6log), "latin1"), ia, o.simulator);
    if (outcome.kind !== "completed") { shot(join(dir, "failure.png")); await closeDialogs(s); }
    step("export");
    await exportProject(s, o.project, dir);
    writeRow(dir, o, applicationId, ia);
  } catch (e) {
    // Every failure of the row is the driver's: its reason first, then what evidence can still be taken.
    const why = e instanceof DriverFailure ? e.message : `the driver broke off: ${e instanceof Error ? e.message : String(e)}`;
    outcome = { kind: "driver-failed", why };
    writeFileSync(join(dir, "driver-failed.txt"), `${why}\n`);
    console.error(`driver-failed: ${why}`);
    const evidence = (what: string, take: () => void) => { try { take(); } catch (x) { writeFileSync(join(dir, "driver-failed.txt"), `no ${what}: ${x instanceof Error ? x.message : String(x)}\n`, { flag: "a" }); } };
    evidence("screenshot", () => shot(join(dir, "failure.png")));
    evidence("ETS6.log", () => {
      etsLogSince(since, join(dir, ROW_FILES.ets6log));
      writeFileSync(join(dir, "ets6.log.tail.txt"), readFileSync(join(dir, ROW_FILES.ets6log)).toString("latin1").split("\n").slice(-200).join("\n"), "latin1");
    });
    // Recovery only for an ETS this driver runs.
    if (ours) await closeDialogs(s).catch(() => restartEts()).catch((x: unknown) => console.error(`ETS not recovered: ${x instanceof Error ? x.message : String(x)}`));
  } finally {
    if (sim) await sim.stop();
    if (wrong) await wrong.stop();
    s.clean();
  }
  if (!existsSync(`${log}.sim.txt`)) writeFileSync(`${log}.sim.txt`, "");
  const refusals = simRefusals(readFileSync(`${log}.sim.txt`, "utf8"));
  if (refusals.length) console.log(`the simulator refused ${refusals.length}: ${refusals[0]}`);
  return { dir, outcome, minutes: (Date.now() - t0) / 60_000 };
}

// ---- the command line ----

// `row`'s options: those with a value (sim-override repeatable), and the one without; anything else is refused.
const VALUED = ["order", "simulator", "project", "password-env", "out", "stop-sim-after", "wrong-interface", "sim-override"];
function rowOptions(args: string[]): RowOptions {
  const [unit, variant] = args;
  if (!unit || !variant || unit.startsWith("--") || variant.startsWith("--")) throw new Error("usage: bun run tools/ets-driver.ts row <unit> <variant> --order <order number> [...] (see the file's head)");
  const values = new Map<string, string[]>();
  let configured = false;
  for (let i = 2; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if (args[i] === "--configured") { configured = true; continue; }
    if (!args[i].startsWith("--") || !VALUED.includes(name)) throw new Error(`unknown argument ${args[i]}`);
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (values.has(name) && name !== "sim-override") throw new Error(`--${name} given twice`);
    values.set(name, [...(values.get(name) ?? []), v]);
  }
  const one = (n: string) => values.get(n)?.[0];
  const endpoint = (n: string, v: string | undefined) => { if (v !== undefined && !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) throw new Error(`--${n} ${v} is not <ipv4>:<port>`); return v; };
  const stop = one("stop-sim-after");
  if (stop !== undefined && !/^[1-9]\d*$/.test(stop)) throw new Error(`--stop-sim-after ${stop} is no frame count`);
  return {
    unit, variant, configured, orderNumber: one("order"), simulator: endpoint("simulator", one("simulator")) ?? "192.168.1.105:3701",
    project: one("project") ?? "Busforge Sweep", passwordEnv: one("password-env"), out: one("out"),
    stopSimAfter: stop === undefined ? undefined : Number(stop), wrongInterface: endpoint("wrong-interface", one("wrong-interface")), simOverrides: values.get("sim-override") ?? [],
  };
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "up") { await up(); console.log(owned("display.pids").concat(owned("ets.pids")).map((p) => `${p.name} ${p.pid}`).join("\n")); return 0; }
  if (cmd === "down") { await down(); return 0; }
  if (cmd === "shot") { console.log(shot(rest[0] ?? join(tmpdir(), "ets.png"))); return 0; }
  if (cmd === "words") {
    const png = rest[0] ?? shot(join(tmpdir(), "ets.png"));
    for (const w of words(png)) console.log(`${w.x},${w.y} ${w.w}x${w.h} ${w.text}`);
    return 0;
  }
  if (cmd === "xdo") { process.stdout.write(xdo(...rest)); return 0; }
  if (cmd === "type") { typeText(rest.join(" ")); return 0; }
  if (cmd === "same") {
    const [a, b, unit] = rest;
    if (!a || !b || !unit) throw new Error("usage: bun run tools/ets-driver.ts same <ets.log> <ets.log> <unit>");
    const device = newSimUnit(simUnitSpec(unit)).deviceIa;
    const [x, y] = [readFileSync(a, "utf8"), readFileSync(b, "utf8")];
    const d = dialogueDifferences(x, y, device);
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
  if (cmd === "row") {
    const r = await runRow(rowOptions(rest));
    console.log(`${r.dir}: ${r.outcome.kind}${"why" in r.outcome ? `: ${r.outcome.why}` : ""} (${r.minutes.toFixed(1)} min)`);
    return r.outcome.kind === "completed" ? 0 : 1;
  }
  throw new Error("usage: bun run tools/ets-driver.ts row|same|rerun-identity|up|down|shot|words|xdo|type ... (see the file's head)");
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (e) { console.error(`ets-driver: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
}
