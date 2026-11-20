#!/usr/bin/env bun
// ETS 6 on the bench host's display, driven from this machine over ssh, for one sweep row (tools/ets-sweep.ts):
// ETS downloads one application into a simulated unit (tools/sim-unit-serve.ts) served from this machine.
//
//   BUSFORGE_CORPUS=... bun run tools/ets-driver.ts row <unit> <variant> --order <order number> \
//     [--simulator <this host's ip>:3701] [--project "Busforge Sweep"] [--configured] [--out <dir>] \
//     [--stop-sim-after <frames>] [--wrong-interface <host:port>] [--sim-override <object>/<PID>=<hex>]...
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
// started by its shortcut, the driver waits for ETS6.log's end of the load task, exports the project and
// writes the row: row.json, configuration.json (the device's configuration in ETS's export), ets.log and
// ets.log.sim.txt (the simulator), ets6.log.txt (ETS6.log from the row's start), the export.
//
// Every row is judged by ETS6.log (etsOutcome): a download that connected to anything but the simulator is
// driver-failed. A failed row keeps a full-resolution screenshot, the ETS6.log tail and the simulator's log;
// dialogs the driver knows are closed, otherwise ETS is restarted (only processes `up` started, by PID).
//
// --stop-sim-after <n> stops the simulator once ETS sent it n frames (a download ETS aborts); --wrong-interface
// selects another configured connection than the simulator's: both exist to check the verdicts on real logs.
// --sim-override gives the simulator a wrong identity (tools/sim-unit-serve.ts --override), which ETS refuses with
// the properties it required in ETS6.log; rerun-identity reads them (tools/sim-unit-product.ts).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appProgramId, loadKnxproj } from "../packages/project/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";
import { catalogueXml, corpusUnlistedPath } from "./corpus.ts";
import { captureLData, deviceConfiguration, deviceRows } from "./etsdiff.ts";
import { etsOutcome, ROW_FILES, ROW_FORMAT, simRefusals, SWEEP_DIR, type EtsOutcome, type RowConfiguration, type RowSpec } from "./ets-sweep.ts";
import { numToIa } from "../packages/knx/src/index.ts";
import { productUnit, rerunIdentity } from "./sim-unit-product.ts";
import { newSimUnit, simUnitSpec } from "./sim-units.ts";

export const HOST = process.env.ETS_HOST ?? "tf@192.168.1.231";
export const DISPLAY = ":5";
const PREFIX = "$HOME/ets/prefix";
const ETS_LOG_DIR = `${PREFIX}/drive_c/users/tf/AppData/Local/KNX/ETS6/Log`;
// What `up` started, by PID, and where exports land (Wine's Z: is the host's root).
const STATE = "$HOME/ets/sweep-driver";
const EXPORT_DIR_WIN = "Z:\\home\\tf\\ets\\sweep-driver\\export";
const EXPORT_DIR = `${STATE}/export`;
export const ETS_BUILD = "ETS 6.4.1 Home (6.4.8718)";

// ---- the bench host ----

// One shell script on the bench host, fed to bash on its stdin; its stdout.
export function remote(script: string, opts: { timeoutMs?: number; allowFail?: boolean } = {}): string {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST, "bash", "-s"], { input: script, encoding: "utf8", timeout: opts.timeoutMs ?? 120_000 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`remote script failed (${r.status}): ${r.stderr.trim()}\n${script}`);
  return r.stdout;
}

// A command whose stdin is `input` (text to type): the command goes as ssh's own command line.
function remoteWithInput(command: string, input: string): string {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST, command], { input, encoding: "utf8", timeout: 120_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`remote command failed (${r.status}): ${r.stderr.trim()}\n${command}`);
  return r.stdout;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One xdotool invocation on the display (several commands chained in it keep a transient menu open).
export function xdo(...args: string[]): string { return remote(`DISPLAY=${DISPLAY} xdotool ${args.map(q).join(" ")}`); }
// Types text into the focused field; xdotool reads it from stdin, so nothing after it is taken as text.
export function typeText(text: string): void { remoteWithInput(`DISPLAY=${DISPLAY} xdotool type --delay 40 --file -`, text); }
export function key(...keys: string[]): void { xdo("key", "--delay", "150", ...keys); }
export function click(x: number, y: number): void { xdo("mousemove", "--sync", String(x), String(y), "sleep", "0.2", "click", "1"); }

// A full-resolution screenshot of the display, copied to `png` here (coordinates 1:1 with xdotool's).
export function shot(png: string): string {
  const tmp = `/tmp/ets-driver-${process.pid}.png`;
  remote(`DISPLAY=${DISPLAY} import -window root ${tmp}`);
  mkdirSync(dirname(png), { recursive: true });
  execFileSync("scp", ["-q", `${HOST}:${tmp}`, png]);
  remote(`rm -f ${tmp}`);
  return png;
}

// ---- reading the screen ----

export interface Word { text: string; x: number; y: number; w: number; h: number; line: string }
export interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number; text: string }
export interface Region { x: number; y: number; w: number; h: number }

// ETS's 11-12 px UI text reads reliably only enlarged: OCR runs on a copy at `scale`, the boxes are scaled
// back. Sparse text (psm 11) suits a screen; a single row such as a dialog's button bar reads better as a
// block (psm 6), where sparse text loses its light grey buttons.
const OCR_SCALE = 2;
export function words(png: string, region?: Region, opts: { scale?: number; psm?: number } = {}): Word[] {
  const scale = opts.scale ?? OCR_SCALE;
  const big = join(dirname(png), `.${basename(png, ".png")}-ocr.png`);
  execFileSync("magick", [png, ...(region ? ["-crop", `${region.w}x${region.h}+${region.x}+${region.y}`, "+repage"] : []), "-resize", `${scale * 100}%`, big]);
  // Leptonica fails to open some absolute paths on macOS (/tmp through its symlink): read it by name from its directory.
  const tsv = execFileSync("tesseract", [basename(big), "-", "--psm", String(opts.psm ?? 11), "tsv"], { cwd: dirname(big), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  rmSync(big, { force: true });
  const ox = region?.x ?? 0, oy = region?.y ?? 0, s = (v: string) => Math.round(+v / scale);
  return tsv.split("\n").slice(1).flatMap((row) => {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5" || !c[11].trim()) return [];
    return [{ text: c[11].trim(), x: ox + s(c[6]), y: oy + s(c[7]), w: s(c[8]), h: s(c[9]), line: `${c[2]}.${c[3]}.${c[4]}` }];
  });
}

// The text of a region read as one block, line by line: a label/value table reads cleaner so than word by word.
export function textLines(png: string, region: Region): string[] {
  const big = join(dirname(png), `.${basename(png, ".png")}-block.png`);
  execFileSync("magick", [png, "-crop", `${region.w}x${region.h}+${region.x}+${region.y}`, "+repage", "-resize", `${OCR_SCALE * 100}%`, big]);
  const text = execFileSync("tesseract", [basename(big), "-", "--psm", "6"], { cwd: dirname(big), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  rmSync(big, { force: true });
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

// OCR reads umlauts unreliably ("hinzufiigen"); words are compared without them.
const norm = (s: string) => s.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: "a", ö: "o", ü: "u", ß: "ss" })[c] ?? c).replace(/[^a-z0-9.:$()/-]/g, "");

// Where a phrase stands: consecutive words of one OCR line, each phrase word a prefix of the word read.
export function findText(ws: Word[], phrase: string): Box[] {
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
export function rows(ws: Word[], tolerance = 5): { y: number; words: Word[]; text: string }[] {
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
function greenness(png: string, r: Region): number {
  const out = execFileSync("magick", [png, "-crop", `${r.w}x${r.h}+${r.x}+${r.y}`, "+repage", "-fx", "min(g-r,g-b)", "-format", "%[fx:maxima]", "info:"], { encoding: "utf8" });
  return Number(out.trim());
}

// ---- a failure the driver names ----

export class DriverFailure extends Error {}
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
  leftTree: { x: 0, y: 105, w: 315, h: 525 }, catalogueGrid: { x: 315, y: 695, w: 1255, h: 465 },
  properties: { x: 1575, y: 80, w: 345, h: 600 }, menuRight: { x: 1500, y: 70, w: 420, h: 300 },
  bottomBar: { x: 0, y: 1165, w: 1570, h: 35 },
} as const;

// ---- ETS's log ----

// The bench host's clock in ETS6.log's format, to cut the log at.
function etsClock(): string { return remote(`date '+%Y-%m-%d %H:%M:%S'`).trim(); }

// ETS6.log from `since` on (the rotated file before it too), byte for byte (Latin-1), copied to `to`.
function etsLogSince(since: string, to: string): void {
  const tmp = `/tmp/ets-driver-log-${process.pid}.txt`;
  remote(`cd "${ETS_LOG_DIR}" && cat $(ls -r ETS6.log.1 ETS6.log 2>/dev/null) | LC_ALL=C awk -v s=${q(since)} '/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] / { p = (substr($0, 1, 19) >= s) } p' > ${tmp}`);
  execFileSync("scp", ["-q", `${HOST}:${tmp}`, to]);
  remote(`rm -f ${tmp}`);
}

// Whether ETS6.log holds a line with `needle` from `since` on (and, where given, matching `pattern` too).
function etsLogHas(since: string, needle: string, pattern?: RegExp): boolean {
  const lines = remote(`cd "${ETS_LOG_DIR}" && LC_ALL=C awk -v s=${q(since)} '/^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] / { p = (substr($0, 1, 19) >= s) } p' ETS6.log | grep -a -F ${q(needle)} || true`);
  return lines.split("\n").some((l) => l.includes(needle) && (!pattern || pattern.test(l)));
}

// ---- processes on the bench host, by PID ----

function pidsOf(file: string): { name: string; pid: number }[] {
  return remote(`cat ${STATE}/${file} 2>/dev/null || true`).split("\n").filter(Boolean).map((l) => { const [name, pid] = l.split(" "); return { name, pid: Number(pid) }; });
}
const alive = (pid: number) => remote(`kill -0 ${pid} 2>/dev/null && echo y || true`).trim() === "y";

// Starts what is not running: Xvfb, openbox and x11vnc (localhost:5905, password) on the display, then ETS;
// records each PID it started. Refuses to start ETS beside one it did not start.
export async function up(): Promise<void> {
  remote(`mkdir -p ${STATE}/export`);
  const display = pidsOf("display.pids").filter((p) => alive(p.pid));
  if (display.length === 0) {
    if (remote(`pgrep -f "Xvfb ${DISPLAY}" || true`).trim()) fail(`another Xvfb serves ${DISPLAY}: not started by this driver, so not used`);
    remote(`cd ${STATE}
setsid nohup Xvfb ${DISPLAY} -screen 0 1920x1200x24 -nolisten tcp > xvfb.log 2>&1 < /dev/null & echo "xvfb $!" > display.pids; sleep 2
DISPLAY=${DISPLAY} setsid nohup openbox > openbox.log 2>&1 < /dev/null & echo "openbox $!" >> display.pids; sleep 1
setsid nohup env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE x11vnc -display ${DISPLAY} -localhost -forever -shared -rfbauth $HOME/.vnc/passwd -rfbport 5905 > vnc.log 2>&1 < /dev/null & echo "x11vnc $!" >> display.pids; sleep 1`);
  }
  const ets = pidsOf("ets.pids").filter((p) => alive(p.pid));
  if (ets.length) return;
  if (remote(`pgrep -f 'ETS6.exe' || true`).trim()) fail("an ETS this driver did not start runs on the bench host");
  remote(`cd ${STATE}; pgrep -f 'wine|\\.exe' | sort > wine-before.txt
WINEPREFIX=${PREFIX} DISPLAY=${DISPLAY} setsid nohup wine 'C:\\Program Files (x86)\\ETS6\\ETS6N.exe' > ets-run.log 2>&1 < /dev/null &`);
  for (let i = 0; i < 90; i++) {
    if (remote(`DISPLAY=${DISPLAY} xdotool search --name '^ETS6 - ' 2>/dev/null || true`).trim()) break;
    await sleep(2000);
  }
  await sleep(5000);
  // Every Wine process that was not running before: ETS, its launcher, the Wine desktop.
  remote(`cd ${STATE}; pgrep -f 'wine|\\.exe' | sort > wine-after.txt; for p in $(comm -13 wine-before.txt wine-after.txt); do echo "$(ps -o comm= -p $p) $p"; done | grep -v -e '^ ' -e '^pgrep' > ets.pids; cat ets.pids`);
  if (!pidsOf("ets.pids").some((p) => p.name.startsWith("ETS6"))) fail("ETS did not start: no ETS6 process after the launcher");
}

// Closes ETS (its window, then its processes by PID) and stops the display this driver started.
export async function down(): Promise<void> {
  const ets = pidsOf("ets.pids");
  if (ets.length) {
    remote(`DISPLAY=${DISPLAY} xdotool search --name '^ETS6 - ' windowclose 2>/dev/null || true`, { allowFail: true });
    for (let i = 0; i < 30 && ets.some((p) => alive(p.pid)); i++) await sleep(1000);
    for (const p of ets.filter((x) => alive(x.pid))) remote(`kill ${p.pid} || true`);
    remote(`rm -f ${STATE}/ets.pids`);
  }
  for (const p of pidsOf("display.pids").reverse()) if (alive(p.pid)) remote(`kill ${p.pid} || true`);
  remote(`rm -f ${STATE}/display.pids`);
}

async function restartEts(): Promise<void> {
  const ets = pidsOf("ets.pids");
  if (!ets.length) fail("ETS needs a restart, but this driver did not start it");
  for (const p of ets) if (alive(p.pid)) remote(`kill ${p.pid} || true`);
  for (let i = 0; i < 20 && ets.some((p) => alive(p.pid)); i++) await sleep(1000);
  for (const p of ets) if (alive(p.pid)) remote(`kill -9 ${p.pid} || true`);
  remote(`rm -f ${STATE}/ets.pids`);
  await up();
}

// ---- ETS, step by step ----

// ETS's window title names the tab in front: "ETS6 - Übersicht" or "ETS6 - <project>".
export function etsTitle(): string {
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
  for (let i = 0; etsTitle() !== want; i++) {
    if (i === 30) fail(`ETS did not open the project ${name} within 60 s`);
    await sleep(2000);
  }
  await sleep(3000);
}

// The topology view in the left panel, with line 1.1 visible; the box of the tree row matching `pattern`.
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

// Every device of line 1.1 deleted.
async function emptyLine(s: Screen): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const dev = await treeRow(s, ANY_DEVICE);
    if (!dev) return;
    if (attempt === 5) fail(`line 1.1 still holds ${dev.text} after deleting`);
    click(dev.cx, dev.cy);
    await sleep(1000);
    key("Delete");
    await sleep(2500);
    const { ws } = s.look();
    const confirm = findText(ws, "Ja")[0] ?? findText(ws, "Löschen").find((b) => b.y > 200 && b.y < 1100);
    if (confirm) { click(confirm.cx, confirm.cy); await sleep(2000); }
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
    return textLines(s.look().png, { x: AT.properties.x, y: t.y + 20, w: AT.properties.w, h: 200 });
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
export function catalogueIdentity(applicationId: string): { deviceType: string; version: string; fingerprint: string } {
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
    const headers = rows(s.look(grid).ws.filter(inside(grid)));
    for (const h of headers) { click(326, Math.round(h.y)); await sleep(1000); }
    items = products();
  }
  if (items.length === 0) fail(`the catalogue holds no product for order number ${orderNumber}`);
  const entries: (CatalogueEntry & { y: number })[] = [];
  for (const r of items) {
    click(500, Math.round(r.y));
    await sleep(1500);
    entries.push({ ...(await readCatalogueEntry(s)), y: Math.round(r.y) });
  }
  const sameOrder = entries.filter((e) => e.orderNumber === orderNumber);
  const atVersion = sameOrder.filter((e) => e.version === want.version);
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
    if (await treeRow(s, ANY_DEVICE)) return;
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

// The toolbar's interface set to the configured connection at `endpoint` ("host:port"), its check mark read
// back. Where the dropdown does not list it, the project's connection (the backbone's) is set to it first.
async function selectInterface(s: Screen, endpoint: string): Promise<void> {
  const compact = (t: string) => t.replace(/\s+/g, "").replace(/,/g, ".");
  const entryIn = (ws: Word[]) => rows(ws.filter(inside(AT.menuRight))).find((r) => compact(r.text).includes(`${endpoint}Tcp`) || compact(r.text).includes(`(${endpoint}`));
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
    const listed = rows(words(png, box)).find((r) => compact(r.text).includes(`(${endpoint}`)) ?? fail(`ETS has no configured connection to ${endpoint}: add one under 'Konfigurierte Verbindungen verwalten'`);
    click(box.x + 250, Math.round(listed.y));
    await sleep(1500);
    // The project's connection carries a yellow star left of its row (blue minimum 0.19 measured, 0.95 without);
    // the button toggles it, so it is pressed only where the star is missing.
    const starred = (png: string) => Number(execFileSync("magick", [png, "-crop", `18x16+${box.x + 55}+${Math.round(listed.y) - 8}`, "+repage", "-format", "%[fx:minima.b]", "info:"], { encoding: "utf8" }).trim()) < 0.6;
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

// ---- the simulator on this machine ----

interface Sim { pid: number; out: string; stop(): Promise<string> }

function startSim(unit: string, log: string, port: number, advertise: string, overrides: string[] = []): Promise<Sim> {
  const out = `${log}.serve.txt`;
  const child = spawn("bun", ["run", join(import.meta.dir, "sim-unit-serve.ts"), unit, "--tool", "ETS", "--log", log, "--port", String(port - 1), "--proxy-port", String(port), "--advertise", advertise, ...overrides.flatMap((o) => ["--override", o])], {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  let text = "";
  child.stdout.on("data", (d: Buffer) => { text += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { text += d.toString(); });
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the simulator did not start: ${text}`)), 20_000);
    const check = setInterval(() => {
      if (!text.includes(`connects to :${port}`)) return;
      clearTimeout(t); clearInterval(check);
      resolve({
        pid: child.pid ?? 0, out,
        async stop() { child.kill("SIGINT"); await exited; writeFileSync(out, text); return text; },
      });
    }, 200);
    child.on("exit", () => { clearTimeout(t); clearInterval(check); reject(new Error(`the simulator ended: ${text}`)); });
  });
}

const frameCount = (log: string) => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes("ETS->BRIDGE TUNNELLING_REQ")).length : 0;

// ---- the row ----

export interface RowOptions {
  unit: string; variant: string; orderNumber?: string; simulator: string; project: string; configured: boolean;
  passwordEnv?: string; out?: string; stopSimAfter?: number; wrongInterface?: string;
  // Properties the simulator answers otherwise than its unit (tools/sim-unit-serve.ts --override): a wrong identity.
  simOverrides?: string[];
}

export interface RowRun { dir: string; outcome: EtsOutcome | { kind: "driver-failed"; why: string }; minutes: number }

export async function runRow(o: RowOptions): Promise<RowRun> {
  const t0 = Date.now();
  const spec = simUnitSpec(o.unit);
  const applicationId = spec.catalogue.replace(/\.xml\.gz$/, "");
  const dir = o.out ?? corpusUnlistedPath(`${SWEEP_DIR}/${applicationId}/${o.variant}`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty: a row is written once`);
  mkdirSync(dir, { recursive: true });
  const [host, portText] = o.simulator.split(":");
  const port = Number(portText);
  const ia = numToIa(newSimUnit(spec).deviceIa);
  const s = new Screen(dir);
  const since = etsClock();
  const log = join(dir, ROW_FILES.ets);
  let sim: Sim | null = null, wrong: Sim | null = null;
  let outcome: RowRun["outcome"];
  try {
    if (remote(`lsusb | grep -c 147b || true`).trim() !== "0") console.log("note: the KNX-USB stick is plugged into the bench host; ETS6.log decides which interface ETS used");
    await up();
    sim = await startSim(o.unit, log, port, host, o.simOverrides);
    if (o.wrongInterface) {
      const [, wp] = o.wrongInterface.split(":");
      wrong = await startSim(o.unit, join(dir, "wrong-interface.log"), Number(wp), host);
    }
    await closeDialogs(s);
    await openProject(s, o.project, o.passwordEnv);
    await showTopology(s);
    if (!o.configured) {
      if (!o.orderNumber) fail("--order is needed to insert the product from the catalogue");
      await emptyLine(s);
      await insertProduct(s, o.orderNumber!, applicationId);
      await setAddress(s, ia);
    } else if (!(await treeRow(s, iaRow(ia)))) fail(`the project holds no device at ${ia}`);
    await selectInterface(s, o.wrongInterface ?? o.simulator);
    const dev = (await treeRow(s, iaRow(ia))) ?? fail(`no device ${ia} in the topology`);
    click(dev.cx, dev.cy);
    await sleep(1500);
    const started = etsClock();
    key("ctrl+alt+shift+d");
    for (let i = 0; !etsLogHas(started, `StartLoadDevice(Application) ${ia} `); i++) {
      if (i === 15) fail(`ETS did not start the application download of ${ia} within 30 s of its shortcut`);
      await sleep(2000);
    }
    const until = Date.now() + 300_000;
    for (;;) {
      if (o.stopSimAfter !== undefined && sim && frameCount(log) >= o.stopSimAfter) { await sim.stop(); sim = null; console.log(`stopped the simulator after ${o.stopSimAfter} frames of ETS`); }
      // The task's end, or its exception where it failed (tools/ets-sweep.ts etsOutcome).
      if (etsLogHas(started, `End LoadApplicationProgram ${ia} `) || etsLogHas(started, "Knx.Ets.Hawk.LoadDeviceTask - ", /(WARN|ERROR) +Knx\.Ets\.Hawk\.LoadDeviceTask - /)) break;
      if (Date.now() > until) fail(`ETS did not end the download of ${ia} within 300 s`);
      await sleep(2000);
    }
    // ETS closes the tunnel after the task; the capture is whole then.
    for (let i = 0; i < 20 && sim && !readFileSync(`${log}.sim.txt`, "utf8").includes("closed by the client"); i++) await sleep(500);
    etsLogSince(since, join(dir, ROW_FILES.ets6log));
    outcome = etsOutcome(readFileSync(join(dir, ROW_FILES.ets6log), "latin1"), ia, o.simulator);
    if (outcome.kind !== "completed") { shot(join(dir, "failure.png")); await closeDialogs(s); }
    await exportProject(s, o.project, dir);
    writeRow(dir, o, applicationId, ia);
  } catch (e) {
    if (!(e instanceof DriverFailure)) throw e;
    outcome = { kind: "driver-failed", why: e.message };
    console.error(`driver-failed: ${e.message}`);
    shot(join(dir, "failure.png"));
    etsLogSince(since, join(dir, ROW_FILES.ets6log));
    writeFileSync(join(dir, "ets6.log.tail.txt"), readFileSync(join(dir, ROW_FILES.ets6log), "latin1").split("\n").slice(-200).join("\n"), "latin1");
    writeFileSync(join(dir, "driver-failed.txt"), `${e.message}\n`);
    await closeDialogs(s).catch(async () => { await restartEts(); });
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

// ETS shows its dialogs inside its window and dims the rest of it: the window's margins turn grey, and the
// dialog is the one bright box left.
function dialogBox(png: string): Region | null {
  const lightest = (r: Region) => Number(execFileSync("magick", [png, "-crop", `${r.w}x${r.h}+${r.x}+${r.y}`, "+repage", "-colorspace", "Gray", "-format", "%[fx:maxima]", "info:"], { encoding: "utf8" }).trim());
  if (![{ x: 2, y: 1185, w: 300, h: 12 }, { x: 1580, y: 1185, w: 300, h: 12 }].every((r) => lightest(r) < 0.7)) return null;
  const m = execFileSync("magick", [png, "-colorspace", "Gray", "-threshold", "80%", "-format", "%@", "info:"], { encoding: "utf8" }).trim().match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
  return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
}

// The buttons in a dialog's bottom bar, which ETS aligns right: read as one line, without the dialog's frames
// and lists to its left (sparse OCR loses the light grey buttons, a wider strip reads the frames as text).
function dialogButtons(png: string, box: Region): Word[] {
  const w = Math.min(box.w, 420);
  return words(png, { x: box.x + box.w - w, y: box.y + box.h - 40, w, h: 40 }, { scale: 2, psm: 7 });
}

// Dialogs ETS shows inside its window, closed by the buttons the driver knows, else by Escape; one still
// open after that fails, and the caller restarts ETS.
async function closeDialogs(s: Screen): Promise<void> {
  for (let i = 0; ; i++) {
    const png = s.snap();
    const box = dialogBox(png);
    if (!box) break;
    if (i === 4) fail("a dialog in ETS's window stays open");
    const buttons = dialogButtons(png, box);
    const button = ["Schlie", "OK", "Abbrechen", "Nein"].map((b) => findText(buttons, b)[0]).find(Boolean);
    if (!button) { key("Escape"); await sleep(1000); }
    else { click(button.cx, button.cy); await sleep(1500); }
  }
  if (!etsTitle()) fail("ETS's window is gone");
}

// The project exported (no password) from ETS's overview into the row as export.knxproj.
async function exportProject(s: Screen, project: string, dir: string): Promise<void> {
  click(AT.overviewTab[0], AT.overviewTab[1]);
  const card = await s.waitText(project, { x: 60, y: 600, w: 1800, h: 120 }, 20_000, "the project's card");
  xdo("mousemove", String(card.cx), String(card.y - 80), "sleep", "1", "mousemove", String(card.cx), String(card.y + 84), "sleep", "1");
  const { ws } = s.look({ x: card.x - 20, y: card.y + 70, w: 270, h: 30 });
  const exp = findText(ws, "Export")[0] ?? fail("no Export on the project's card");
  click(exp.cx, exp.cy);
  const name = await s.waitText("File name", undefined, 20_000, "the export's file dialog");
  const file = `${Date.now()}.knxproj`;
  click(name.x + 180, name.cy);
  key("ctrl+a");
  typeText(`${EXPORT_DIR_WIN}\\${file}`);
  key("Return");
  await s.waitText("Export erfolgreich", undefined, 120_000, "the export");
  const png = s.snap();
  const box = dialogBox(png) ?? fail("the export's result is no dialog");
  const close = findText(dialogButtons(png, box), "Schlie")[0] ?? fail("no Schließen under the export's result");
  click(close.cx, close.cy);
  execFileSync("scp", ["-q", `${HOST}:${EXPORT_DIR.replace("$HOME", "/home/tf")}/${file}`, join(dir, "export.knxproj")]);
  remote(`rm -f ${EXPORT_DIR}/${file}`);
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

// ---- two runs of a row ----

// The dialogue between ETS and the unit in a capture, frame by frame: ETS's requests to it with the line's
// confirmation (OK/NEG), the unit's frames with their first control field.
export function dialogue(text: string, device: number): string[] {
  const out: string[] = [];
  const pending: number[] = [];
  for (const fr of captureLData(text, "ETS")) {
    if (fr.group) continue;
    if (fr.fromTool && fr.code === 0x11 && fr.dst === device) { pending.push(out.length); out.push(`>> ${fr.tpdu.toString("hex")}`); }
    else if (!fr.fromTool && fr.code === 0x2e && fr.dst === device) { const i = pending.shift(); if (i !== undefined) out[i] += fr.line.includes("CON-NEG") ? " NEG" : " OK"; }
    else if (!fr.fromTool && fr.code === 0x29 && fr.src === device) {
      const f = Buffer.from(fr.line.match(/\| ([0-9a-fA-F]+)\s*$/)![1], "hex"), cemi = f.subarray(f[0] + f[f[0]]);
      out.push(`<< ${fr.tpdu.toString("hex")} ctrl ${cemi[2 + cemi[1]].toString(16)}`);
    }
  }
  return out;
}

// The positions where two captures' dialogues with the unit differ (a missing frame counts as different).
export function dialogueDifferences(a: string, b: string, device: number): string[] {
  const x = dialogue(a, device), y = dialogue(b, device);
  const out: string[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(`#${i}: ${x[i] ?? "(none)"} | ${y[i] ?? "(none)"}`);
  return out;
}

// ---- the command line ----

function flag(args: string[], name: string): string | undefined { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "up") { await up(); console.log(remote(`cat ${STATE}/display.pids ${STATE}/ets.pids`)); return 0; }
  if (cmd === "down") { await down(); return 0; }
  if (cmd === "shot") { console.log(shot(rest[0] ?? "/tmp/ets.png")); return 0; }
  if (cmd === "words") {
    const png = rest[0] ?? shot("/tmp/ets.png");
    for (const w of words(png)) console.log(`${w.x},${w.y} ${w.w}x${w.h} ${w.text}`);
    return 0;
  }
  if (cmd === "same") {
    const [a, b, unit] = rest;
    if (!a || !b || !unit) throw new Error("usage: bun run tools/ets-driver.ts same <ets.log> <ets.log> <unit>");
    const device = newSimUnit(simUnitSpec(unit)).deviceIa;
    const d = dialogueDifferences(readFileSync(a, "utf8"), readFileSync(b, "utf8"), device);
    console.log(`${dialogue(readFileSync(a, "utf8"), device).length} and ${dialogue(readFileSync(b, "utf8"), device).length} frames with ${numToIa(device)}, ${d.length} positions differ`);
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
  if (cmd === "xdo") { process.stdout.write(xdo(...rest)); return 0; }
  if (cmd === "type") { typeText(rest.join(" ")); return 0; }
  if (cmd === "row") {
    const [unit, variant] = rest;
    if (!unit || !variant || unit.startsWith("--") || variant.startsWith("--")) throw new Error("usage: bun run tools/ets-driver.ts row <unit> <variant> --order <order number> [...]");
    const stop = flag(rest, "stop-sim-after");
    const r = await runRow({
      unit, variant, orderNumber: flag(rest, "order"), simulator: flag(rest, "simulator") ?? "192.168.1.105:3701",
      project: flag(rest, "project") ?? "Busforge Sweep", configured: rest.includes("--configured"), passwordEnv: flag(rest, "password-env"),
      out: flag(rest, "out"), stopSimAfter: stop === undefined ? undefined : Number(stop), wrongInterface: flag(rest, "wrong-interface"),
      simOverrides: rest.flatMap((a, i) => (a === "--sim-override" ? [rest[i + 1]] : [])),
    });
    console.log(`${r.dir}: ${r.outcome.kind}${"why" in r.outcome ? `: ${r.outcome.why}` : ""} (${r.minutes.toFixed(1)} min)`);
    return r.outcome.kind === "completed" ? 0 : 1;
  }
  throw new Error("usage: bun run tools/ets-driver.ts row|up|down|shot|words|xdo|type ...");
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (e) { console.error(`ets-driver: ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
}
