// Finding a device physically: its programming LED is switched on over a connection, held, and
// switched off again.
//
// The LED shows programming mode, and while a device is in programming mode it answers a broadcast
// address read and takes a broadcast address write. Leaving one in that mode makes it join the next
// address assignment on the line, so the mode is switched off at the end whatever happened before:
// an error, a cancel, a device that did not take the mode. Only an end that is read back off the device
// counts; one that cannot be shown is a coded failure, never a quiet success.
//
// The mode is the device object's PID_PROGMODE (54), bit 0. Which devices hold it there is the caller's
// decision (the mask); a device that answers the property with no element is refused before any write.
import type { KnxDevice } from "./device.ts";
import { PID } from "./device.ts";
import { KnxError } from "./errors.ts";

const DEVICE_OBJECT = 0;
const ON = 0x01;
const OFF = 0x00;

export interface BlinkOptions {
  holdMs: number;
  // A device closes a transport connection that carries no request for 6 s, so the hold reads the mode
  // at this interval; the read also notices the mode ended at the device (its button pressed).
  pollMs?: number;
  signal?: AbortSignal;
  onProgress?: (phase: string) => void;
  // Called right before the first write; it may throw to stop a cancelled task before anything is written.
  enterWrites?: () => void;
}

// How the hold ended: its time ran out, it was cancelled, or the device left programming mode itself.
export type BlinkEnd = "time" | "cancel" | "device";
export interface BlinkResult { kind: "located"; endedBy: BlinkEnd; heldMs: number; progModeOff: true }

const isOn = (v: Buffer | null) => v !== null && v.length > 0 && (v[0] & ON) !== 0;

// Wait `ms`, or less when the signal aborts. Resolves either way.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function hold(dev: KnxDevice, holdMs: number, pollMs: number, signal?: AbortSignal): Promise<BlinkEnd> {
  const until = Date.now() + holdMs;
  for (;;) {
    if (signal?.aborted) return "cancel";
    const left = until - Date.now();
    if (left <= 0) return "time";
    await pause(Math.min(pollMs, left), signal);
    if (signal?.aborted) return "cancel";
    if (!isOn(await dev.propReadIfPresent(DEVICE_OBJECT, PID.PROG_MODE))) return "device";
  }
}

async function writeOffAndRead(dev: KnxDevice): Promise<void> {
  await dev.propWrite(DEVICE_OBJECT, PID.PROG_MODE, Buffer.from([OFF]));
  const back = await dev.propReadIfPresent(DEVICE_OBJECT, PID.PROG_MODE);
  if (back === null || back.length === 0) throw new Error("the device did not answer the read of its programming mode after the write");
  if (isOn(back)) throw new Error(`the device still reports programming mode (PID 54 reads ${back.toString("hex")})`);
}

// Programming mode off, read back. A failure on the session's connection gets one more try on a new one:
// the link may have broken during the hold, and this is the step that must not be left undone.
async function switchOff(dev: KnxDevice): Promise<void> {
  try {
    await writeOffAndRead(dev);
    return;
  } catch (first) {
    try {
      await dev.disconnect();
      await dev.connect();
      await writeOffAndRead(dev);
    } catch (second) {
      const why = (e: unknown) => e instanceof Error ? e.message : String(e);
      throw new KnxError("LOCATE_PROG_MODE_LEFT_ON",
        `programming mode could not be shown off (${why(first)}; again on a new connection: ${why(second)}); the device may still be in programming mode and would take part in the next address assignment: press its programming button until the LED is off`);
    }
  }
}

// Switch programming mode on, hold it, and switch it off, read back.
export async function blinkProgrammingMode(dev: KnxDevice, opts: BlinkOptions): Promise<BlinkResult> {
  const { holdMs, pollMs = 2000, signal, onProgress, enterWrites } = opts;
  onProgress?.("prog-mode-read");
  const before = await dev.propReadIfPresent(DEVICE_OBJECT, PID.PROG_MODE);
  if (before === null || before.length === 0) {
    throw new KnxError("LOCATE_NO_PROG_MODE_PROPERTY",
      "the device answers its programming-mode property (device object, PID 54) with no element, so its programming mode is not switched over the bus; find it by its address label");
  }
  enterWrites?.();
  const started = Date.now();
  let endedBy: BlinkEnd = "cancel";
  let failure: unknown = null;
  try {
    onProgress?.("prog-mode-on");
    const echo = await dev.propWrite(DEVICE_OBJECT, PID.PROG_MODE, Buffer.from([ON]));
    if (!isOn(echo)) {
      throw new KnxError("LOCATE_PROG_MODE_NOT_TAKEN",
        `the device did not take programming mode (it answered the write with ${echo.length ? echo.toString("hex") : "no element"})`);
    }
    onProgress?.("prog-mode-hold");
    endedBy = await hold(dev, holdMs, pollMs, signal);
  } catch (e) {
    failure = e;
  }
  onProgress?.("prog-mode-off");
  try {
    await switchOff(dev);
  } catch (off) {
    // The mode left on is what matters now; what failed before is kept in the message.
    if (failure && off instanceof KnxError) throw new KnxError(off.code, `${off.message}; before that: ${failure instanceof Error ? failure.message : String(failure)}`);
    throw off;
  }
  if (failure) throw failure;
  return { kind: "located", endedBy, heldMs: Date.now() - started, progModeOff: true };
}
