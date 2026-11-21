// Whether two commits read the private corpus alike: every archive and catalogue file of the corpus
// (`.knxproj`, `.knxprod`, OpenKNX release zips and the manufacturer XMLs inside them, `.busforge`-free) is
// run through the archive readers of `packages/project` (loadKnxproj, readXml0, readBaggage,
// extractCatalogProducts, hardwareApplications, extractAppPrograms, readAppProgram, extractPictureBaggage)
// as each commit has them, and each reader's output is reduced to one hash, or to the code and text of
// its refusal. The tool prints every file and reader whose result differs between the two.
//
//   KNXPROJ_PASSWORDS="…" BUSFORGE_CORPUS=… bun tools/loader-hash.ts <commit> <commit|worktree>
//
// `worktree` is the checkout's packages/ as they are, uncommitted changes included. A commit's packages/
// are unpacked under node_modules/.cache/loader-hash/<commit>/ and its own @busforge packages linked
// there; third-party packages come from this checkout's node_modules. A protected project is opened with
// each of KNXPROJ_PASSWORDS (tools/corpus-archives.ts). Exits 1 where any result differs.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { corpusRoot } from "./corpus.ts";
import { codeOf, describeFailure, NEEDS_PASSWORD, NOT_THIS_PASSWORD, passwords } from "./corpus-archives.ts";

const REPO = resolve(import.meta.dir, "..");
type Results = Record<string, Record<string, string>>; // file -> reader -> hash or refusal

// The corpus files the readers take, relative to its root, sorted: every .knxproj, .knxprod and .zip, and
// every .xml that holds manufacturer data.
function corpusFiles(root: string): string[] {
  const found: string[] = [];
  const head = (path: string) => { const fd = openSync(path, "r"); const b = Buffer.alloc(4096); const n = readSync(fd, b, 0, b.length, 0); closeSync(fd); return b.subarray(0, n).toString("latin1"); };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && (/\.(knxproj|knxprod|zip)$/i.test(e.name) || (/\.xml$/i.test(e.name) && head(path).includes("<ManufacturerData")))) found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

// A value as text that a hash can be taken of: maps as their entries in order, bytes as their hash.
const stable = (v: unknown): string => JSON.stringify(v, (_, x) => {
  if (x instanceof Map) return { map: [...x.entries()] };
  if (x instanceof Set) return { set: [...x] };
  if (x && typeof x === "object" && x.type === "Buffer" && Array.isArray(x.data)) return { bytes: createHash("sha256").update(Buffer.from(x.data)).digest("hex") };
  return x;
});
const hashOf = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex").slice(0, 16);

// Runs inside one commit's packages: every reader on every file, as a JSON object on stdout.
async function measure(projectSrc: string): Promise<void> {
  const p = await import(join(projectSrc, "index.ts"));
  const root = corpusRoot();
  if (!root) throw new Error("BUSFORGE_CORPUS is not set");
  const out: Results = {};
  const inputs: [string, Buffer][] = [];
  for (const file of corpusFiles(root)) {
    const bytes = readFileSync(join(root, file));
    inputs.push([file, bytes]);
    // An OpenKNX release carries its product database as plain manufacturer XMLs below data/.
    if (/\.zip$/i.test(file)) {
      try {
        for (const [name, b] of p.readZip(bytes) as Map<string, Buffer>) {
          if (/^data[\\/][^\\/]+\.xml$/.test(name) && !/[\\/]content\.xml$/.test(name)) inputs.push([`${file}!${name}`, b]);
        }
      } catch { /* the zip readers below record the refusal */ }
    }
  }
  for (const [file, bytes] of inputs) {
    const r: Record<string, string> = {};
    const run = (reader: string, fn: () => unknown): unknown => {
      try { const v = fn(); r[reader] = hashOf(v); return v; } catch (e) { r[reader] = `refused ${describeFailure(e)}`; return undefined; }
    };
    // A protected project: the first password that opens it.
    const withPassword = (reader: string, fn: (pw: string | undefined) => unknown): unknown => run(reader, () => {
      let last: unknown;
      for (const pw of [undefined, ...passwords()]) {
        try { return fn(pw); } catch (e) { last = e; if (!NEEDS_PASSWORD.has(codeOf(e) ?? "") && !NOT_THIS_PASSWORD.has(codeOf(e) ?? "")) throw e; }
      }
      throw last;
    });
    const project = withPassword("loadKnxproj", (pw) => p.loadKnxproj(bytes, pw, "x")) as { devices: { appRef: string; appProgramId: string }[] } | undefined;
    withPassword("readXml0", (pw) => p.readXml0(bytes, pw));
    withPassword("readBaggage", (pw) => p.readBaggage(bytes, pw));
    const products = run("extractCatalogProducts", () => p.extractCatalogProducts(bytes)) as { appRef: string; appProgramId: string }[] | undefined;
    const applications = run("hardwareApplications", () => p.hardwareApplications(bytes)) as Map<string, string> | undefined;
    const devices = project?.devices ?? [];
    const ids = [...new Set([...devices, ...(products ?? [])].map((d) => d.appProgramId).filter(Boolean))].sort();
    const programs = run("extractAppPrograms", () => p.extractAppPrograms(bytes, ids)) as Map<string, string> | undefined;
    const appRefs = [...new Set([...devices.map((d) => d.appRef), ...(applications?.keys() ?? [])].filter(Boolean))].sort();
    run("readAppProgram", () => appRefs.map((ref) => [ref, p.readAppProgram(bytes, ref)]));
    if (programs) run("extractPictureBaggage", () => p.extractPictureBaggage(bytes, programs));
    out[file] = r;
  }
  process.stdout.write(JSON.stringify(out));
}

// The packages/ of `rev` on disk: the checkout's own for "worktree", else unpacked from git once.
function packagesOf(rev: string): string {
  if (rev === "worktree") return join(REPO, "packages");
  const sha = execFileSync("git", ["-C", REPO, "rev-parse", "--verify", `${rev}^{commit}`], { encoding: "utf8" }).trim();
  const dir = join(REPO, "node_modules", ".cache", "loader-hash", sha);
  if (!existsSync(join(dir, "packages", "project", "src", "index.ts"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "node_modules", "@busforge"), { recursive: true });
    execFileSync("sh", ["-c", `git -C "$0" archive "$1" packages | tar -x -C "$2"`, REPO, sha, dir]);
    for (const pkg of readdirSync(join(dir, "packages"))) symlinkSync(join(dir, "packages", pkg), join(dir, "node_modules", "@busforge", pkg));
  }
  return join(dir, "packages");
}

function resultsOf(rev: string): Results {
  const run = spawnSync(process.execPath, [import.meta.path, "--measure", join(packagesOf(rev), "project", "src")], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });
  if (run.status !== 0) throw new Error(`measuring ${rev} failed (exit ${run.status})`);
  return JSON.parse(run.stdout) as Results;
}

if (process.argv[2] === "--measure") await measure(process.argv[3]);
else {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error("usage: bun tools/loader-hash.ts <commit> <commit|worktree>"); process.exit(2); }
  const ra = resultsOf(a), rb = resultsOf(b);
  const files = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
  let differ = 0, readings = 0, refused = 0;
  for (const file of files) {
    const readers = [...new Set([...Object.keys(ra[file] ?? {}), ...Object.keys(rb[file] ?? {})])];
    for (const reader of readers) {
      readings++;
      const x = ra[file]?.[reader] ?? "(not run)", y = rb[file]?.[reader] ?? "(not run)";
      if (y.startsWith("refused")) refused++;
      if (x !== y) { differ++; console.log(`${file}  ${reader}\n  ${a}: ${x}\n  ${b}: ${y}`); }
    }
  }
  console.log(`${files.length} files, ${readings} readings (${refused} refused on ${b}), ${differ} differ`);
  process.exit(differ ? 1 : 0);
}
