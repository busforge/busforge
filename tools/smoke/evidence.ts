// Turns one smoke run into busforge.evidence/1 records (docs/evidence-contract.md), written next to
// the report. A record states only what the run observed: a capability that was not exercised, a
// harness abort before any device contact and a guard-the-guardrail refusal are not device evidence
// and produce none. Every record is validated before it is written; an invalid one throws.
import { parseEvidenceRecord, maskInfo, type AxisResult, type EvidenceRecord, type Firmware } from "../../packages/product/src/index.ts";
import { appProgramId as programOf } from "../../packages/project/src/index.ts";
import { sha256, serverBuild } from "../evidence.ts";
import type { CapabilityResult } from "./capabilities.ts";
import type { BehaviourResult } from "./behaviours.ts";
import type { Channel, DeviceSpec } from "./spec.ts";

export interface RunConditions {
  server: { version: string; commit: string };
  runnerRevision: string | null;
  transport: EvidenceRecord["transport"];
  firmware: Firmware;
  source: { artifact: string | null; sha256: string | null };
}

// The parts of a runner result a record is built from.
export interface ObservedRun {
  spec: string; channel: Channel; startedAt: number;
  capabilities: CapabilityResult[];
  clickThrough: { state: "pass" | "fail" | "not-applicable"; detail: string };
  behaviours: BehaviourResult[];
  // The persistence check (persistence.ts), when the run reached it: A_Restart, an observed reboot,
  // then a read-back compared with the project.
  persistence?: { state: "pass" | "fail"; detail: string };
}

// What a passing driver actually established (capabilities.ts). A write passes on the server's
// verified FlashResult, which is a read-back or a device-reported CRC depending on the profile; a
// read passes when the device's memory was read and decoded completely, without a comparison.
const METHOD: Record<string, string> = {
  fullDownload: "the server reported the download verified (read-back or device CRC, per profile)",
  flashParams: "each change and its revert reported verified by the server, zero drift on read-back",
  flashLinks: "the link flash reported verified by the server and the link read back",
  readParams: "parameter memory read and decoded completely; not compared with a built image",
  readLinks: "group tables read and decoded, every association resolved; not compared with a built image",
};
const PERSISTS = new Set(["fullDownload", "flashLinks"]);
const PERSISTENCE_METHOD = "A_Restart, reboot observed (the device stopped answering, then answered again), every load object LOADED before is LOADED after, then a device read-back: decoded parameters and group links equal to the project; the com-object table is not read back";
const NOT_ASSESSED: AxisResult = { state: "not-assessed" };
const detail = (d: string) => (d ? { detail: d } : {});

// A DeviceSpec is plain data, so its JSON is all of it: any edit to what the run is told to do or
// skip changes the revision, which is what separates a spec edit from a device outcome.
export const specRevision = (spec: DeviceSpec): string => sha256(JSON.stringify(spec)).slice(0, 12);

export function runEvidence(run: ObservedRun, spec: DeviceSpec, cond: RunConditions): EvidenceRecord[] {
  const appProgramId = programOf(spec.device.appRef);
  const recordedAt = new Date(run.startedAt).toISOString();
  const base = {
    schema: "busforge.evidence/1", recordedAt,
    subject: { manufacturer: appProgramId.slice(0, 6), productRef: spec.device.productRef, appProgramId, mask: spec.device.mask, firmware: cond.firmware },
    medium: maskInfo(spec.device.mask)?.medium ?? "unknown", transport: cond.transport,
    build: { server: serverBuild(cond.server), runner: { name: "tools/smoke", revision: cond.runnerRevision }, spec: { name: spec.id, revision: specRevision(spec) } },
    origin: { configuredBy: "busforge", reference: "self-written", priorBusforgeWrites: "some" },
    supersedes: [], supersedeReason: null,
    source: { kind: "smoke-report", ...cond.source },
  };
  const out: EvidenceRecord[] = [];
  const add = (operation: string, configuration: string, results: Partial<EvidenceRecord["results"]>) => {
    out.push(parseEvidenceRecord({
      ...base, id: `${spec.id}-${run.channel}-${recordedAt}#${out.length}-${operation}`,
      scope: { operation, channel: run.channel, configuration, configurationFingerprint: null },
      results: { transfer: NOT_ASSESSED, reference: NOT_ASSESSED, behaviour: NOT_ASSESSED, persistence: NOT_ASSESSED, ...results },
    }));
  };
  const baseline = `spec baseline (${spec.configure.length} configure steps)`;

  // The persistence check runs right after the capabilities (runner.ts), so it reads back the
  // download's parameters and group tables with the link flashLinks placed on top. flashParams reverts
  // every change it makes, so what survives the reboot is not its own write, and it gets no result.
  const persisted = (c: CapabilityResult): AxisResult => {
    const p = run.persistence;
    if (!p || c.state !== "pass" || !PERSISTS.has(c.capability)) return NOT_ASSESSED;
    return p.state === "pass" ? { state: "pass", method: PERSISTENCE_METHOD, ...detail(p.detail) } : { state: "fail", ...detail(p.detail) };
  };
  for (const c of run.capabilities) {
    if (!(c.capability in METHOD) || (c.state !== "pass" && c.state !== "fail")) continue;
    add(c.capability, `${baseline}, then the ${c.capability} driver's own change`, {
      transfer: c.state === "pass" ? { state: "pass", method: METHOD[c.capability], ...detail(c.detail) } : { state: "fail", ...detail(c.detail) },
      persistence: persisted(c),
    });
  }
  const downloadedHere = run.capabilities.some((c) => c.capability === "fullDownload" && c.state === "pass");
  if (run.clickThrough.state === "pass" || run.clickThrough.state === "fail") {
    add("uiClickThrough", baseline, {
      transfer: run.clickThrough.state === "pass"
        ? { state: "pass", method: "every parameter and com-object the API lists was visible in the UI", ...detail(run.clickThrough.detail) }
        : { state: "fail", ...detail(run.clickThrough.detail) },
    });
  }
  // A behaviour either links its objects to fresh group addresses and flashes them, or observes
  // addresses the baseline linked and a full download committed (behaviours.ts, observe-only). An
  // observe-only behaviour is evidence for this run only if this run's download committed them;
  // otherwise an earlier build did, and the record would name the wrong one.
  for (const b of run.behaviours) {
    const declared = spec.behaviours.find((d) => d.kind === b.kind && d.label === b.label);
    if (!declared) throw new Error(`behaviour ${b.kind}:${b.label} is not declared in spec ${spec.id}`);
    const observeOnly = "ga" in declared ? !!declared.ga : "inGa" in declared && !!declared.inGa && !!declared.outGa;
    if (observeOnly && !downloadedHere) continue;
    add(observeOnly ? "fullDownload" : "flashLinks", `behaviour ${b.kind}: ${b.label}`, {
      behaviour: b.state === "pass" ? { state: "pass", method: `independent witness connection observed ${b.kind}`, ...detail(b.detail) } : { state: "fail", ...detail(b.detail) },
    });
  }
  return out;
}
