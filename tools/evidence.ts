// Shared pieces for the tools that write busforge.evidence/1 records (docs/evidence-contract.md):
// the smoke runner, tools/readback.ts and tools/etsdiff.ts. Everything a record states comes from
// the run itself or from the operator; nothing is defaulted to a value that looks known.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { parseEvidenceRecord, type AxisResult, type EvidenceRecord, type Firmware } from "../packages/product/src/index.ts";
import { appProgramId } from "../packages/project/src/index.ts";

export const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

// A dev server reports its working copy; with local changes the commit alone does not name the code.
export function serverBuild(v: { version: string; commit: string }): { version: string; commit: string } {
  return { version: v.version, commit: /-dirty\b/.test(v.version) ? `${v.commit}-dirty` : v.commit };
}

// The KNXnet/IP transport is known only when the connection pins it; "auto" is resolved inside the
// server and not reported. Whether the interface is Busforge's own bridge cannot be read off the bus
// (its name is configurable), so it is recorded only when the operator declares it.
export function transportOf(ipTransport: string | undefined, via: string | undefined): EvidenceRecord["transport"] {
  if (via !== undefined && via !== "busforge-bridge" && via !== "direct") {
    throw new Error(`BUSFORGE_BENCH_VIA must be "busforge-bridge" or "direct", not "${via}"`);
  }
  const kind = ipTransport === "udp" ? "ip-udp" : ipTransport === "tcp" ? "ip-tcp" : "unknown";
  return { kind, via: via ?? "unknown" };
}

// The revision of the tools checkout, marked dirty when it has local changes.
export function gitRevision(): string | null {
  try {
    const run = (args: string) => execSync(`git ${args}`, { cwd: import.meta.dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const rev = run("rev-parse --short=7 HEAD");
    // Untracked files do not count, as for the server's `git describe --dirty`.
    return rev ? (run("status --porcelain --untracked-files=no") !== "" ? `${rev}-dirty` : rev) : null;
  } catch {
    return null;
  }
}

// The firmware revision is the device object's PID_FIRMWARE_REVISION (object 0, PID 9), one byte.
// It is optional: a device without it answers with no data, and its firmware stays unknown. PID 25
// (PID_VERSION) is not read as firmware: it versions the interface object, which some devices fill
// and some do not, and nothing ties it to the firmware.
export async function readFirmwareRevision(dev: { propReadIfPresent(obj: number, pid: number): Promise<Uint8Array | null> }): Promise<Firmware> {
  const v = await dev.propReadIfPresent(0, 9);
  return v === null || v.length === 0 ? { state: "unknown" } : { state: "observed", value: String(v[0]), source: "device object PID_FIRMWARE_REVISION (object 0, PID 9)" };
}

const NOT_ASSESSED: AxisResult = { state: "not-assessed" };

export interface ImageComparison {
  ia: string;
  firmware: Firmware;
  productRef: string;
  hardware2Program: string;
  mask: string;
  match: boolean;
  diffBytes: number;
  length: number;
}

// Who put the configuration a read-back compares against into the device, as the operator states it.
export interface DeclaredOrigin { configuredBy: "busforge" | "ets" | "unknown"; priorBusforgeWrites: "none" | "some" | "unknown" }

// A read-back of a device's parameter memory compared with the image Busforge builds for the project.
// What the comparison shows depends on who wrote the device: bytes Busforge wrote give transfer
// evidence, bytes only ETS ever wrote give reference evidence, and an unknown writer gives neither.
export function readbackEvidence(
  c: ImageComparison, origin: DeclaredOrigin,
  run: { recordedAt: string; runnerRevision: string | null; transport: EvidenceRecord["transport"]; artifact: string; sha256: string },
): EvidenceRecord {
  const app = appProgramId(c.hardware2Program);
  const outcome = c.match
    ? { method: "device parameter memory byte-equal to the image Busforge builds from the project", detail: `${c.length} bytes` }
    : { detail: `${c.diffBytes} of ${c.length} bytes differ; a difference can also be project-versus-device drift` };
  const result: AxisResult = c.match ? { state: "pass", ...outcome } : { state: "fail", detail: outcome.detail };
  const independent = origin.configuredBy === "ets" && origin.priorBusforgeWrites === "none";
  const selfWritten = origin.configuredBy === "busforge";
  const unattributed: AxisResult = { state: "not-assessed", detail: `${c.match ? "equal" : "different"}, but who wrote the device is not known` };
  return parseEvidenceRecord({
    schema: "busforge.evidence/1", id: `readback-${c.ia}-${run.recordedAt}`, recordedAt: run.recordedAt,
    subject: { manufacturer: app.slice(0, 6), productRef: c.productRef, appProgramId: app, mask: c.mask, firmware: c.firmware },
    medium: "unknown", transport: run.transport,
    build: { server: null, runner: { name: "tools/readback.ts", revision: run.runnerRevision }, spec: null },
    scope: { operation: "readParams", channel: "tool", configuration: "the device's installed configuration, as the imported project states it", configurationFingerprint: null },
    origin: { configuredBy: origin.configuredBy, reference: independent ? "independently-commissioned-device" : selfWritten ? "self-written" : "none", priorBusforgeWrites: origin.priorBusforgeWrites },
    results: {
      transfer: selfWritten ? result : independent ? NOT_ASSESSED : unattributed,
      reference: independent ? result : NOT_ASSESSED,
      behaviour: NOT_ASSESSED, persistence: NOT_ASSESSED,
    },
    supersedes: [], supersedeReason: null,
    source: { kind: "readback-tool", artifact: run.artifact, sha256: run.sha256 },
  });
}

// Busforge's parameter segment compared with the writes of an ETS full download of the same project.
export function etsdiffEvidence(
  c: { ia: string; productRef: string; hardware2Program: string; mask: string; divergent: number; compared: number; outside: number; base: number; basePinned: boolean },
  run: { recordedAt: string; runnerRevision: string | null; artifact: string; sha256: string },
): EvidenceRecord {
  // Nothing compared is nothing shown; a pass needs at least one ETS write inside the segment.
  if (c.compared === 0) throw new Error(`no ETS write fell inside ${c.ia}'s parameter segment at base 0x${c.base.toString(16)}; nothing to record`);
  const app = appProgramId(c.hardware2Program);
  const scope = `${c.compared} writes compared, ${c.outside} outside the segment not compared, base 0x${c.base.toString(16)} ${c.basePinned ? "pinned" : "inferred from the capture"}`;
  return parseEvidenceRecord({
    schema: "busforge.evidence/1", id: `etsdiff-${c.ia}-${run.recordedAt}`, recordedAt: run.recordedAt,
    subject: { manufacturer: app.slice(0, 6), productRef: c.productRef, appProgramId: app, mask: c.mask, firmware: { state: "unknown" } },
    medium: "unknown", transport: { kind: "unknown", via: "unknown" },
    build: { server: null, runner: { name: "tools/etsdiff.ts", revision: run.runnerRevision }, spec: null },
    scope: { operation: "fullDownload", channel: "tool", configuration: "the project's configuration of the device, parameter segment only", configurationFingerprint: null },
    origin: { configuredBy: "ets", reference: "ets-capture", priorBusforgeWrites: "none" },
    results: {
      transfer: { state: "not-assessed", detail: "offline comparison; no device involved" },
      reference: c.divergent === 0
        ? { state: "pass", method: "every parameter-segment write of the ETS download byte-equal to Busforge's image at the segment base", detail: scope }
        : { state: "fail", detail: `${c.divergent} of ${c.compared} parameter-segment writes differ; ${scope}` },
      behaviour: NOT_ASSESSED, persistence: NOT_ASSESSED,
    },
    supersedes: [], supersedeReason: null,
    source: { kind: "etsdiff", artifact: run.artifact, sha256: run.sha256 },
  });
}
