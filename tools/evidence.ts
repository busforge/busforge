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

// What bytes read from a device written as `origin` states can stand for (docs/evidence-contract.md,
// "Only independent sources can confirm the bytes"): only a device ETS configured and Busforge never
// wrote is an independent reference; bytes Busforge wrote prove transfer at most.
export function originReference(origin: DeclaredOrigin): "independently-commissioned-device" | "self-written" | "none" {
  if (origin.configuredBy === "ets" && origin.priorBusforgeWrites === "none") return "independently-commissioned-device";
  return origin.configuredBy === "busforge" ? "self-written" : "none";
}

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
  const reference = originReference(origin);
  const independent = reference === "independently-commissioned-device";
  const selfWritten = reference === "self-written";
  const unattributed: AxisResult = { state: "not-assessed", detail: `${c.match ? "equal" : "different"}, but who wrote the device is not known` };
  return parseEvidenceRecord({
    schema: "busforge.evidence/1", id: `readback-${c.ia}-${run.recordedAt}`, recordedAt: run.recordedAt,
    subject: { manufacturer: app.slice(0, 6), productRef: c.productRef, appProgramId: app, mask: c.mask, firmware: c.firmware },
    medium: "unknown", transport: run.transport,
    build: { server: null, runner: { name: "tools/readback.ts", revision: run.runnerRevision }, spec: null },
    scope: { operation: "readParams", channel: "tool", configuration: "the device's installed configuration, as the imported project states it", configurationFingerprint: null },
    origin: { configuredBy: origin.configuredBy, reference, priorBusforgeWrites: origin.priorBusforgeWrites },
    results: {
      transfer: selfWritten ? result : independent ? NOT_ASSESSED : unattributed,
      reference: independent ? result : NOT_ASSESSED,
      behaviour: NOT_ASSESSED, persistence: NOT_ASSESSED,
    },
    supersedes: [], supersedeReason: null,
    source: { kind: "readback-tool", artifact: run.artifact, sha256: run.sha256 },
  });
}

// Busforge's full-download image compared, segment by segment, with the memory writes of an ETS full
// download of the same configuration. A reference pass needs every byte ETS wrote to be compared and
// equal: an ETS byte outside Busforge's image, or a segment that could not be placed, is not a pass.
// Bytes Busforge writes that ETS does not are not contradicted by the capture, but not proven by it
// either, so the detail names them.
export interface EtsDiffSummary {
  ia: string; productRef: string | null; hardware2Program: string; mask: string;
  configuration: string;       // the configuration both sides were built from, in words
  compared: number;            // bytes compared (ETS-written or ETS-filled, and in Busforge's image)
  divergent: number;           // of those, bytes that differ
  etsOutside: number;          // bytes ETS wrote that no Busforge segment covers (after printed exclusions)
  busforgeOnly: number;        // bytes Busforge writes that ETS neither wrote nor filled
  uncomparedSegments: number;  // Busforge segments whose device address could not be established
  segments: string[];          // per segment: "<id> <divergent>/<compared>" or "<id> not compared"
  declaredUnwritten?: string[]; // declared segments Busforge writes nothing to (ETS wrote nothing there either, or it would be outside)
  exclusions: string[];        // rule-based exclusions applied, each with its rule
  // What the capture was: an ETS full download (the default), or an ETS partial download split by
  // the Busforge operation that writes the compared segments.
  operation?: "fullDownload" | "flashParams" | "flashLinks";
}
export function etsdiffEvidence(
  c: EtsDiffSummary,
  run: { recordedAt: string; runnerRevision: string | null; artifact: string; sha256: string },
): EvidenceRecord {
  const operation = c.operation ?? "fullDownload";
  const partial = operation !== "fullDownload";
  const image = partial ? "image for the same configuration" : "full-download image";
  // Nothing compared is nothing shown.
  if (c.compared === 0 && !c.uncomparedSegments) throw new Error(`no ETS write to ${c.ia} fell inside Busforge's ${image}; nothing to record`);
  const app = appProgramId(c.hardware2Program);
  const scope = [
    `${c.compared} bytes compared (${c.segments.join(", ")})`,
    ...(c.exclusions.length ? [`excluded by rule: ${c.exclusions.join("; ")}`] : []),
    ...(c.busforgeOnly ? [`${c.busforgeOnly} bytes Busforge writes that ETS does not are not covered`] : []),
    ...(c.declaredUnwritten?.length ? [`declared segments neither side writes: ${c.declaredUnwritten.join(", ")}`] : []),
  ].join("; ");
  const problems = [
    ...(c.divergent ? [`${c.divergent} of ${c.compared} compared bytes differ`] : []),
    ...(c.etsOutside ? [`${c.etsOutside} bytes ETS wrote lie outside Busforge's image`] : []),
    ...(c.uncomparedSegments ? [`${c.uncomparedSegments} segments could not be placed on the device`] : []),
  ];
  const segmentsOf = { fullDownload: "every segment", flashParams: "the parameter segments", flashLinks: "the group tables" }[operation];
  return parseEvidenceRecord({
    schema: "busforge.evidence/1", id: `etsdiff-${partial ? `${operation}-` : ""}${c.ia}-${run.recordedAt}`, recordedAt: run.recordedAt,
    subject: { manufacturer: app.slice(0, 6), productRef: c.productRef, appProgramId: app, mask: c.mask, firmware: { state: "unknown" } },
    medium: "unknown", transport: { kind: "unknown", via: "unknown" },
    build: { server: null, runner: { name: "tools/etsdiff.ts", revision: run.runnerRevision }, spec: null },
    scope: {
      operation, channel: "tool", configurationFingerprint: null,
      configuration: partial
        ? `${c.configuration}; ETS partial download against Busforge's configuration image (not the flash operation's write set), ${segmentsOf}`
        : `${c.configuration}; full-download image, every segment`,
    },
    origin: { configuredBy: "ets", reference: "ets-capture", priorBusforgeWrites: "none" },
    results: {
      transfer: { state: "not-assessed", detail: "offline comparison; no device involved" },
      reference: problems.length === 0
        ? { state: "pass", method: partial
          ? `every memory byte the ETS partial download wrote to ${segmentsOf} byte-equal to Busforge's image for the same configuration at the device address`
          : "every memory byte of the ETS full download byte-equal to Busforge's full-download image at the device address", detail: scope }
        : { state: "fail", detail: `${problems.join("; ")}; ${scope}` },
      behaviour: NOT_ASSESSED, persistence: NOT_ASSESSED,
    },
    supersedes: [], supersedeReason: null,
    source: { kind: "etsdiff", artifact: run.artifact, sha256: run.sha256 },
  });
}
