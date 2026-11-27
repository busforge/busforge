#!/usr/bin/env bun
// Raw acquisition from the command line (docs/raw-acquisition.md): the collector of the server's
// `collect` task, run against one device over a KNXnet/IP TCP tunnel, without a data directory.
// Read-only: it sends the services the collector sends and nothing else.
//
//   bun run tools/collect.ts <host[:port]> <ia> <out.json> [--app=<app.xml | app.xml.gz>] [--no-authorize]
//        [--range=<start>:<length>]... [--knxproj=<file.knxproj> --password-env=<VAR>]
//
// --app            the device's application program, which places the M112 parameter segments and
//                  decides how memory past 0xFFFF is reached (without it, that memory is probed with
//                  A_MemoryExtended)
// --no-authorize   no free-key authorize, to compare what the device answers without it
// --range          additional classic memory range (<start>:<length>, decimal or 0x hex) to read at the end
//                  of the memory plan, skipping already-read octets; only masks whose plan declares fixed
//                  segments take them (refused ranges are recorded in limits and exit 3)
// --knxproj        a secured device: its tool key and serial come from the project (password from the
//                  environment variable), the session runs secured; the key never enters the package
//                  (the serial does, as the device's own answer to the identity read)
//
// Unlike the server, the tool stores no device sequence after a secured session: it prints the
// sequence the device used, and a Busforge data directory keeps the older one it holds.
//
// Exit 0: the plan ran to its end. Exit 3: the package is written, but the collection stopped or hit a
// bound (its `stop` and `limits` say which). Exit 130: interrupted, nothing written.
//
// The package is the device's memory and identity. For a device of a real installation, write it to
// a gitignored location and do not commit it.
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { KnxIpTunnel, KnxDevice, SecureSession, iaToNum } from "../packages/knx/src/index.ts";
import { loadKnxproj } from "../packages/project/src/index.ts";
import { collectDevice, collectApp, parseAppConfig, CollectCancelled, type CollectApp, type CollectPackage, type MemoryRange } from "../packages/product/src/index.ts";
import { gitRevision } from "./evidence.ts";

const USAGE = "usage: bun run tools/collect.ts <host[:port]> <ia> <out.json> [--app=<app.xml[.gz]>] [--no-authorize] [--range=<start>:<length>]... [--knxproj=<file> --password-env=<VAR>]";
const args = process.argv.slice(2);
const FLAGS = ["--app=", "--knxproj=", "--password-env=", "--range="];
const SINGLE_FLAGS = ["--app=", "--knxproj=", "--password-env=", "--no-authorize"];
const unknown = args.filter((a) => a.startsWith("--") && a !== "--no-authorize" && !FLAGS.some((f) => a.startsWith(f)));
const empty = args.filter((a) => FLAGS.includes(a));
const repeated = SINGLE_FLAGS.filter((f) => args.filter((a) => a === f || (f.endsWith("=") && a.startsWith(f))).length > 1);
const positional = args.filter((a) => !a.startsWith("--"));
const problem = unknown.length > 0 ? `unknown option ${unknown.join(", ")}`
  : empty.length > 0 ? `option without a value: ${empty.join(", ")}`
  : repeated.length > 0 ? `option given more than once: ${repeated.join(", ")}`
  : args.some((a) => a.startsWith("--password-env=")) !== args.some((a) => a.startsWith("--knxproj=")) ? "--knxproj and --password-env go together"
  : positional.length !== 3 ? `expected 3 arguments, got ${positional.length}` : null;
if (problem) {
  console.error(problem);
  console.error(USAGE);
  process.exit(2);
}
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const rawRanges = args.filter((a) => a.startsWith("--range=")).map((a) => a.slice("--range=".length));
const parseUint = (s: string) => (/^0x[0-9a-f]+$/i.test(s) ? Number.parseInt(s.slice(2), 16) : /^\d+$/.test(s) ? Number.parseInt(s, 10) : NaN);
const extraRanges: MemoryRange[] = rawRanges.map((spec) => {
  const parts = spec.split(":");
  const address = parts.length === 2 ? parseUint(parts[0]) : NaN;
  const length = parts.length === 2 ? parseUint(parts[1]) : NaN;
  if (!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || length <= 0 || address + length > 0x10000) {
    throw new Error(`--range=${spec} must be <start>:<length> within 0x0000..0xFFFF`);
  }
  return { address, length };
});
const [target, ia, out] = positional;
const m = /^([^:]+)(?::(\d+))?$/.exec(target);
const port = m?.[2] === undefined ? undefined : Number(m[2]);
if (!m || (port !== undefined && (port < 1 || port > 65535))) throw new Error(`${target} is not <host> or <host>:<port>`);
const iaParts = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/.exec(ia)?.slice(1).map(Number);
if (!iaParts || iaParts[0] > 15 || iaParts[1] > 15 || iaParts[2] > 255) throw new Error(`${ia} is not an individual address <area>.<line>.<device>`);
const dst = iaToNum(ia);
// The bus work is minutes long, and on a secured device it spends sequence numbers: the package's
// directory must be writable before it starts.
accessSync(dirname(out), constants.W_OK);
const authorize = !args.includes("--no-authorize");

let app: CollectApp | null = null;
const appPath = flag("app");
if (appPath) {
  const raw = readFileSync(appPath);
  const cfg = parseAppConfig((appPath.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
  app = collectApp(cfg);
}

let creds: { toolKey: Buffer; serial: Buffer } | undefined;
const projPath = flag("knxproj");
if (projPath) {
  const envName = flag("password-env");
  const password = envName ? process.env[envName] : undefined;
  if (password === undefined) throw new Error("--knxproj needs --password-env=<VAR> naming a set environment variable");
  const proj = loadKnxproj(readFileSync(projPath), password, "collect");
  const device = proj.devices.find((d) => d.ia === ia);
  const sec = device && proj.deviceSecurity.find((s) => s.deviceId === device.id);
  if (!sec) throw new Error(`${projPath} holds no tool key for ${ia}`);
  creds = { toolKey: Buffer.from(sec.toolKey, "base64"), serial: Buffer.from(sec.serialNumber, "base64") };
}

const ctl = new AbortController();
// The first interrupt ends the collection and writes nothing; a second one exits at once.
process.on("SIGINT", () => { if (ctl.signal.aborted) process.exit(130); ctl.abort(); });
const tun = KnxIpTunnel.tcp(m[1], port);
let session: SecureSession | undefined;
try {
  await tun.connect();
  session = creds && new SecureSession({ ...creds, src: tun.assignedIa, dst });
  const dev = new KnxDevice(tun, ia, session);
  try {
    await dev.connect();
    let pkg: CollectPackage | undefined;
    try {
      pkg = await collectDevice(dev, {
        ia, app, signal: ctl.signal, authorize,
        extraRanges: extraRanges.length > 0 ? extraRanges : undefined,
        reopen: async () => { await dev.disconnect(); await dev.connect(); },
        onProgress: (phase) => console.error(`[collect] ${phase}`),
      });
    } catch (e) {
      if (!(e instanceof CollectCancelled)) throw e;
      console.error(`[collect] ${e.message}; ${out} is not written`);
      process.exitCode = 130;
    }
    if (pkg) {
      const provenance = { tool: "tools/collect.ts", commit: gitRevision(), target, authorize, app: appPath ?? null, ...(extraRanges.length ? { extraRanges: rawRanges } : {}) };
      writeFileSync(out, JSON.stringify({ ...pkg, provenance }, null, 1));
      const outcomes = new Map<string, number>();
      for (const r of pkg.records) outcomes.set(`${r.space} ${r.outcome}`, (outcomes.get(`${r.space} ${r.outcome}`) ?? 0) + 1);
      console.log(JSON.stringify({ mask: pkg.mask, authorizeLevel: pkg.authorizeLevel, stop: pkg.stop, limits: pkg.limits, counts: pkg.counts, seconds: (pkg.finishedAt - pkg.startedAt) / 1000, outcomes: Object.fromEntries(outcomes) }, null, 1));
      if (pkg.stop || pkg.limits.length > 0) process.exitCode = 3;
    }
  } finally {
    await dev.disconnect().catch(() => {});
  }
} finally {
  await tun.disconnect().catch(() => {});
  if (session?.peerSequence != null) console.error(`[collect] the device's sequence in this session: ${session.peerSequence}`);
}
