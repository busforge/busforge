// The persistence check (docs/evidence-contract.md, the persistence axis): restart the device, prove
// it actually rebooted, then read it back and require the configuration the run left on it.
//
// The reboot has to be observed, not assumed. A_Restart carries no reliable acknowledgement, and
// firmware differs in how it reboots: most devices stop answering at once, the GVS AMMA still answers
// the first request after the restart and drops out a moment later (the same device polled without a
// restart shows no gap). So the proof is a sequence of fresh-connection probes that must contain a
// silence followed by an answer. Only the device failing to answer counts as silence; an interface or
// tunnel error proves nothing about the device and ends the check as a failure.
import type { DeviceReadbackInfo } from "../../packages/product/src/index.ts";
import type { ConfigView } from "./client.ts";

export interface RebootObservation { rebooted: boolean; detail: string }

// "answered": the device replied. "silent": the device did not reply (DEVICE_NOT_ANSWERING). Any other
// failure is thrown by the probe.
export type ProbeOutcome = "answered" | "silent";

// `restart` sends A_Restart and nothing else, and throws when the interface did not take the frame.
// `probe` opens a fresh connection and asks for the device descriptor.
export async function observeReboot(
  restart: () => Promise<void>,
  probe: () => Promise<ProbeOutcome>,
  opts: { windowMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RebootObservation> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const windowMs = opts.windowMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  // A device that is already silent would turn its own absence into a "reboot".
  if ((await probe()) !== "answered") return { rebooted: false, detail: "the device did not answer before the restart" };
  const start = now();
  await restart();
  let silentAt: number | null = null;
  while (now() - start < windowMs) {
    const outcome = await probe();
    if (outcome === "silent" && silentAt === null) silentAt = now() - start;
    if (outcome === "answered" && silentAt !== null) return { rebooted: true, detail: `silent ${silentAt} ms after A_Restart, answering again after ${now() - start} ms` };
    await sleep(intervalMs);
  }
  return silentAt === null
    ? { rebooted: false, detail: `the device never went silent within ${windowMs} ms of A_Restart` }
    : { rebooted: false, detail: `the device went silent after A_Restart and did not answer again within ${windowMs} ms` };
}

// After the reboot, the server's read-back must cover parameters and links and show neither differing
// from the project. `changed` is the server's comparison of the project against the baseline the
// read-back just replaced with what the device holds. The com-object table is not read back, so its
// persistence is not shown here.
export function judgeRestoredConfig(view: ConfigView, coverage: DeviceReadbackInfo | null): { state: "pass" | "fail"; detail: string } {
  if (!coverage) return { state: "fail", detail: "the read-back after the reboot did not report what it covered" };
  if (coverage.paramsRead !== true || coverage.linksRead !== true) return { state: "fail", detail: "the read-back after the reboot did not cover both parameters and links" };
  if (coverage.linkGaps > 0) return { state: "fail", detail: `${coverage.linkGaps} association(s) did not resolve after the reboot` };
  const items = view.blocks.flatMap((b) => b.items);
  const params = items.flatMap((it) => (it.kind === "param" && it.param.changed ? [it.param.refId] : []));
  const objects = items.flatMap((it) => (it.kind === "comObject" && it.comObject.changed ? [`object ${it.comObject.number}`] : []));
  const lost = [...params, ...objects];
  if (lost.length) return { state: "fail", detail: `differs from the project after the reboot: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` and ${lost.length - 5} more` : ""}` };
  return { state: "pass", detail: "parameters and links read back equal to the project after the reboot" };
}
