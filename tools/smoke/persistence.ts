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
import { flagsNotRead, type ConfigView } from "./client.ts";

// `unproven`: after a negatively confirmed restart the device left a probe unanswered or unacknowledged and answered a
// later one, but the probes never showed the two silences in a row that would prove a reboot (a device
// silent for less time than two probes take, as the MEAN WELL power supply). The caller still reads the
// load states and the configuration back; if they hold, nothing speaks against the reboot and nothing
// shows it, so the step is not assessed, as the product's flash reports such a restart
// (restartUnproven). A device that answers every probe after the restart did not reboot: no unproven.
export interface RebootObservation { rebooted: boolean; unproven?: true; detail: string }

// The connection-oriented part of a device that `restartInConnection` uses (KnxDevice).
export interface RestartConnection {
  connect(): Promise<void>; deviceDescriptor(): Promise<unknown>; sendRestart(): Promise<boolean>; takeTransportReply(): boolean; disconnect(): Promise<void>;
  // KnxDevice: the device's T_Disconnect came ahead of the last request's first frame; the last A_Restart
  // went out a second time.
  closedAheadOfLastRequest?(): boolean; readonly restartWasResent?: boolean;
}

// What a restart sent by restartInConnection showed: the interface's confirmation (sendRestart) and how
// the device took the descriptor read sent behind A_Restart in the same connection, as a probe outcome.
// "undecided": the connection was closed, but by a T_Disconnect that came ahead of the read (a link that
// stalled past the device's 6 s idle timeout delivers that timeout's close so) or after a restart sent a
// second time; it is no silence, and the fresh probes decide.
export interface RestartSent { confirmed: boolean; inConnection: ProbeOutcome | "undecided" }

// The restart observeReboot sends, in the order of the server's plain restart (KnxDevice.restart): a
// fresh connection in which the device answers a descriptor read (any answer: one with another service
// also shows it is up and holds the connection), A_Restart, and a descriptor read in the same connection
// before it is closed. A Gira Tastsensor 3 Komfort ignored an A_Restart behind which the connection was
// closed at once, and executed every one the server sent this way. KnxDevice.restart itself is not
// called: it judges the reboot by that one read alone, which the product asks only where the device's
// firmware allows it (a GVS AMMA answers once more and drops out seconds later, so the product does
// not require the reboot there), and after a negatively confirmed A_Restart it keeps the connection for
// seconds, past a short reboot. Here the read is one more probe for observeReboot to judge; one the
// device took on the transport layer (T_ACK or T_NAK) and left unanswered found it still on the
// connection and counts as answered, as restart() counts it.
// A device silent before the restart, as the probes count silence (no answer, the connection closed, no
// acknowledgement on the bus, a secure Sync unanswered: the probe just before answered with the same
// key), gets none (RestartNotSent). A failure of the link to the interface is thrown as it is.
export class RestartNotSent extends Error {}
const DEVICE_SILENT = new Set(["DEVICE_NOT_ANSWERING", "DEVICE_CLOSED_CONNECTION", "BUS_SEND_FAILED", "SECURE_SYNC_NO_RESPONSE"]);
const codeOf = (e: unknown): unknown => (e as { code?: unknown }).code;
export async function restartInConnection(dev: RestartConnection): Promise<RestartSent> {
  try {
    try { await dev.connect(); await dev.deviceDescriptor(); }
    catch (e) {
      const code = codeOf(e);
      if (code === "ANSWER_SERVICE_MISMATCH") { /* it answered: it is up and holds the connection */ }
      else if (typeof code === "string" && DEVICE_SILENT.has(code)) throw new RestartNotSent(`the device did not answer in the restart's connection (${code}), so A_Restart was not sent`);
      else throw e;
    }
    const confirmed = await dev.sendRestart();
    dev.takeTransportReply();
    let inConnection: ProbeOutcome | "undecided";
    try { await dev.deviceDescriptor(); inConnection = "answered"; }
    catch (e) {
      const code = codeOf(e);
      if (code === "ANSWER_SERVICE_MISMATCH") inConnection = "answered";
      else if (code === "BUS_SEND_FAILED") inConnection = "unacknowledged";
      else if (code === "DEVICE_NOT_ANSWERING") inConnection = dev.takeTransportReply() ? "answered" : "silent";
      else if (code === "DEVICE_CLOSED_CONNECTION" && (dev.closedAheadOfLastRequest?.() || dev.restartWasResent)) inConnection = "undecided";
      else if (code === "DEVICE_CLOSED_CONNECTION" || code === "SECURE_SYNC_NO_RESPONSE") inConnection = "silent";
      else throw e;
    }
    return { confirmed, inConnection };
  } finally { await dev.disconnect(); }
}

// "answered": the device replied. "silent": the device did not reply (DEVICE_NOT_ANSWERING).
// "unacknowledged": the interface reported that no device acknowledged the probe (BUS_SEND_FAILED). Any
// other failure is thrown by the probe.
export type ProbeOutcome = "answered" | "silent" | "unacknowledged";

// `restart` sends A_Restart, throws when the interface did not take the frame (or RestartNotSent, a
// result of this check), and returns whether the interface confirmed it, or that with the outcome of a
// read in the restart's own connection (RestartSent), which counts as the first probe: a device that
// reboots at once sends no L2 acknowledgement, so the confirmation can be negative although the frame
// arrived. After a confirmed restart an unacknowledged probe counts as silence. After an unconfirmed one
// it does not: a device that stops acknowledging for a while without rebooting would show the same on
// the restart and on the probes, so only probes the device left unanswered count, two in a row.
// `probe` opens a fresh connection and asks for the device descriptor.
export async function observeReboot(
  restart: () => Promise<boolean | RestartSent>,
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
  let sent: boolean | RestartSent;
  // The device's own silence before the restart is a result of this check, not a broken harness.
  try { sent = await restart(); }
  catch (e) { if (e instanceof RestartNotSent) return { rebooted: false, detail: e.message }; throw e; }
  const confirmed = typeof sent === "boolean" ? sent : sent.confirmed;
  const silentNeeded = confirmed ? 1 : 2;
  const note = confirmed ? "" : " (A_Restart confirmed negatively)";
  let silentAt: number | null = null;
  let silentRun = 0;
  let gap = false;
  let answeredAfterGap = false;
  // One probe outcome; true once the reboot is seen (a silence, then an answer).
  const see = (outcome: ProbeOutcome): boolean => {
    if (outcome !== "answered") gap = true;
    else if (gap) answeredAfterGap = true;
    if (outcome === "silent" || (confirmed && outcome === "unacknowledged")) {
      silentRun++;
      if (silentRun >= silentNeeded && silentAt === null) silentAt = now() - start;
    } else silentRun = 0;
    return outcome === "answered" && silentAt !== null;
  };
  // The record says where a silence was seen first: in the restart's own connection, or by the probes.
  const inConnection = typeof sent === "boolean" ? null : sent.inConnection;
  const where = inConnection === "silent" || (confirmed && inConnection === "unacknowledged") ? ", first in the restart's own connection" : "";
  const rebooted = (): RebootObservation => ({ rebooted: true, detail: `silent ${silentAt} ms after A_Restart${where}, answering again after ${now() - start} ms${note}` });
  if (inConnection !== null && inConnection !== "undecided" && see(inConnection)) return rebooted();
  while (now() - start < windowMs) {
    if (see(await probe())) return rebooted();
    await sleep(intervalMs);
  }
  if (silentAt === null && !confirmed && answeredAfterGap) {
    return { rebooted: false, unproven: true, detail: `the device left a probe unanswered and answered again, but never went silent on two probes in a row within ${windowMs} ms of A_Restart${note}: the reboot cannot be seen` };
  }
  return silentAt === null
    ? { rebooted: false, detail: `the device never went silent${confirmed ? "" : " on two probes in a row"} within ${windowMs} ms of A_Restart${note}` }
    : { rebooted: false, detail: `the device went silent after A_Restart and did not answer again within ${windowMs} ms${note}` };
}

// After the reboot, the server's read-back must cover parameters and links and show neither differing
// from the project. `changed` is the server's comparison of the project against the baseline the
// read-back just replaced with what the device holds. The com-object table is not read back, so its
// persistence is not shown here.
export function judgeRestoredConfig(view: ConfigView, coverage: DeviceReadbackInfo | null): { state: "pass" | "fail"; detail: string } {
  if (!coverage) return { state: "fail", detail: "the read-back after the reboot did not report what it covered" };
  if (coverage.paramsRead !== true || coverage.linksRead !== true) return { state: "fail", detail: "the read-back after the reboot did not cover both parameters and links" };
  if (coverage.linkGaps > 0) return { state: "fail", detail: `${coverage.linkGaps} association(s) did not resolve after the reboot` };
  const unread = flagsNotRead(view, coverage);
  if (unread) return { state: "fail", detail: `after the reboot ${unread}` };
  const items = view.blocks.flatMap((b) => b.items);
  const params = items.flatMap((it) => (it.kind === "param" && it.param.changed ? [it.param.refId] : []));
  const objects = items.flatMap((it) => (it.kind === "comObject" && it.comObject.changed ? [`object ${it.comObject.number}`] : []));
  const flags = items.flatMap((it) => (it.kind === "comObject" && it.comObject.flagsChanged ? [`flags of object ${it.comObject.number}`] : []));
  const lost = [...params, ...objects, ...flags];
  if (lost.length) return { state: "fail", detail: `differs from the project after the reboot: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ` and ${lost.length - 5} more` : ""}` };
  return { state: "pass", detail: `parameters and links${view.readbackSupport?.flags === true ? " and the com-object flags" : ""} read back equal to the project after the reboot` };
}

// The load state of each load object (1 = LOADED, 3 = ERROR, ...), null where it could not be read.
// Equal bytes do not show that the device runs them: a device can keep every byte across a reboot
// and still refuse its application at boot (Jung 400021SE: object 4 in ERROR). So every object that
// was LOADED before the restart must be LOADED after it.
const LOADED = 1;
const STATE_NAME: Record<number, string> = { 0: "UNLOADED", 1: "LOADED", 2: "LOADING", 3: "ERROR", 4: "UNLOADING" };
export function judgeLoadStates(before: Map<number, number | null>, after: Map<number, number | null>): { state: "pass" | "fail"; detail: string } {
  const watched = [...before].filter(([, s]) => s === LOADED).map(([obj]) => obj);
  if (!watched.length) return { state: "fail", detail: "no load object read LOADED before the restart" };
  const lost = watched.filter((obj) => after.get(obj) !== LOADED)
    .map((obj) => { const s = after.get(obj); return `object ${obj} ${s === null || s === undefined ? "unreadable" : (STATE_NAME[s] ?? `state ${s}`)}`; });
  if (lost.length) return { state: "fail", detail: `after the reboot: ${lost.join(", ")}` };
  return { state: "pass", detail: `load objects ${watched.join(", ")} LOADED after the reboot` };
}

// A System 1 (BCU1) unit has no load-state machines: its run error byte (EEPROM 0x010D, system1.ts
// BCU1_RUN_ERROR) reads FF while the application may run, and the load procedure leaves it 00 until it
// completes. So it must read FF before the restart and after the reboot.
export function judgeRunError(before: number | null, after: number | null): { state: "pass" | "fail"; detail: string } {
  const hex = (b: number | null) => (b === null ? "unreadable" : b.toString(16).padStart(2, "0").toUpperCase());
  if (before !== 0xff) return { state: "fail", detail: `the run error read ${hex(before)} before the restart, not FF` };
  if (after !== 0xff) return { state: "fail", detail: `after the reboot the run error reads ${hex(after)}, not FF` };
  return { state: "pass", detail: "the run error read FF before the restart and after the reboot" };
}
