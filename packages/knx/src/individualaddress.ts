// Individual-address assignment: giving a device its physical address.
//
// This is the one management operation that cannot address the device it talks to. A virgin
// device has no usable address, so it is reached by BROADCAST (destination 0x0000), and the
// device selects itself by having its programming mode switched on (the button on its front).
// Every device in programming mode answers, and every device in programming mode takes the
// address an A_IndividualAddress_Write carries.
//
// THAT is the danger, and it shapes everything here: if two devices are in programming mode,
// a write gives BOTH the same address, and a bus with a duplicated address misbehaves in ways
// that are miserable to diagnose. So the write never runs blind. `assignIndividualAddress`
// insists on seeing exactly one device in programming mode, refuses to hand out an address a
// different device already answers on, and proves the result by talking to the device on its
// new address afterwards. Each refusal is a coded KnxError, never a silent no-op.
import { randomBytes } from "node:crypto";
import type { KnxTransport } from "./transport.ts";
import { KnxDevice, DEVICE_TIMEOUTS, OBJECT_TYPE_SECURITY, SECURITY_PID, noteSync } from "./device.ts";
import { cemiLDataGroup, apduUnnumbered, parseApdu, numToIa, iaToNum, APCI, BROADCAST } from "./frame.ts";
import { KnxError } from "./errors.ts";
import { isSecureApdu, SCF } from "./secure.ts";
import { SecureSession, toolSequenceNow } from "./secureSession.ts";

export interface AssignIaOptions {
  // How long to listen for A_IndividualAddress_Response frames. Devices answer within
  // milliseconds; the default is generous because the window is also the only thing standing
  // between us and a missed second device in programming mode.
  probeMs?: number;
  // Time for the device to apply its new address before we talk to it there.
  settleMs?: number;
  // How long a device may take to answer at its address again after the restart that ends programming
  // mode: the GVS AMMA-04/06.S takes its first frame about 4 s after its secured restart.
  returnMs?: number;
  // The programming-mode route for a Data Secure device whose keys went unanswered (assignAddress): the one
  // device in programming mode must be the device with this serial.
  onlySerial?: string;
  onProgress?: (phase: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Broadcast A_IndividualAddress_Read and collect who answers: the individual addresses of
// every device currently in programming mode. An empty result is a legitimate answer (nobody
// is in programming mode), not an error, so callers can poll this to drive a UI.
export async function readProgModeDevices(tun: KnxTransport, probeMs = 3000): Promise<string[]> {
  const found = new Set<number>();
  const prev = tun.onCemi;
  tun.onCemi = (src, _dst, tpdu, isGroup) => {
    if (!isGroup) return; // broadcast frames arrive with the group/broadcast address type
    if (parseApdu(tpdu).apci === APCI.INDIVIDUAL_ADDRESS_RESPONSE) found.add(src);
  };
  try {
    await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, apduUnnumbered(APCI.INDIVIDUAL_ADDRESS_READ)));
    await sleep(probeMs);
  } finally {
    tun.onCemi = prev;
  }
  return [...found].sort((a, b) => a - b).map(numToIa);
}

// Broadcast A_IndividualAddress_Write: EVERY device in programming mode takes this address.
// Unguarded on purpose (it is the raw service); use assignIndividualAddress, which guards it.
export async function writeIndividualAddress(tun: KnxTransport, ia: string): Promise<void> {
  const n = iaToNum(ia);
  const tail = Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, apduUnnumbered(APCI.INDIVIDUAL_ADDRESS_WRITE, tail)));
}

// Does anything answer on this address?
//
// Only a device that stayed SILENT through the full retry budget counts as absent
// (DEVICE_NOT_ANSWERING: the request machinery sent its 3 attempts and heard nothing). Any other
// failure, a dead tunnel, a USB error, means we learned nothing about the address, and reporting
// "free" there would turn a broken bus into a green light to write. Those rethrow.
//
// The residual limitation is inherent to KNX and worth naming: a device that IS at this address
// but happens not to answer right now (rebooting, wedged) is indistinguishable from an empty
// address. ETS has the same blind spot. It is why the post-write check below proves the identity
// of the device that moved, rather than settling for "something answers there now".
//
// `lineAlive`: a device has just answered over this transport, so the line carries frames. An
// interface that confirms a frame negatively (BUS_SEND_FAILED: no device acknowledged it, the ABB
// KNX-USB stick) then says nobody is at `ia`, but only when that holds on every one of
// NACK_TRIES connection attempts, as silence must hold on every request try: a present device that
// is busy through the interface's own repetitions once is not an empty address. Without the proof
// of a live line it could as well be a dead line.
const NACK_TRIES = 3;
async function addressAnswers(tun: KnxTransport, ia: string, lineAlive: boolean): Promise<boolean> {
  return (await answerAt(tun, ia, lineAlive, false)) !== null;
}
// What answers at `ia`: null for nobody, else a device (`dev` null when it is there but did not hand
// its descriptor out). `keep`: a device that handed its descriptor out stays connected and is returned
// for the caller to go on with and disconnect.
type Answer = { dev: KnxDevice | null };
async function answerAt(tun: KnxTransport, ia: string, lineAlive: boolean, keep: boolean): Promise<Answer | null> {
  for (let i = 0; ; i++) {
    try { return await answerAtOnce(tun, ia, keep); }
    catch (e) {
      if (!(lineAlive && e instanceof KnxError && e.code === "BUS_SEND_FAILED")) throw e;
      if (i === NACK_TRIES - 1) return null; // never acknowledged: absent
    }
  }
}
async function answerAtOnce(tun: KnxTransport, ia: string, keep: boolean): Promise<Answer | null> {
  const dev = new KnxDevice(tun, ia);
  let kept = false;
  try {
    await dev.connect();
    await dev.deviceDescriptor();
    kept = keep;
    return { dev: keep ? dev : null };
  } catch (e) {
    if (e instanceof KnxError && e.code === "DEVICE_NOT_ANSWERING") return null; // silence: absent
    // A T_Disconnect answering our request: a device is there (in another tool's connection, or
    // one that missed our T_Connect), so the address is taken.
    if (e instanceof KnxError && e.code === "DEVICE_CLOSED_CONNECTION") return { dev: null };
    // A device that acknowledged and sent another service is there too.
    if (e instanceof KnxError && e.code === "ANSWER_SERVICE_MISMATCH") return { dev: null };
    throw e; // a transport failure is not evidence of a free address
  } finally {
    if (!kept) { try { await dev.disconnect(); } catch { /* nothing was connected */ } }
  }
}

export interface AssignIaResult {
  previous: string;  // the address the device answered on before (a virgin device reports 15.15.255)
  assigned: string;  // the address it now holds
  verified: boolean; // THE device we programmed answers on the new address (see the identity check)
  progModeCleared: boolean; // its programming mode was switched back off
  // Why programming mode could not be switched off, if it could not. The address is assigned and
  // verified either way, but a device left in programming mode joins the NEXT assignment, so the
  // reason is carried out rather than reduced to a bare false.
  progModeError: string | null;
  // How the address went: by programming mode (plain), by serial number (plain), or by serial number secured
  // under the device's tool key or its factory key (assignSecureAddressBySerial).
  route: "programming-mode" | "serial" | "serial-secured";
  // Set where a Data Secure device went the programming-mode route because none of its keys was answered.
  secureNotAnswered?: string;
}

// Assign `ia` to the single device currently in programming mode, and prove it.
//
// The sequence, and why each step is there:
//   1. Who is in programming mode? Exactly one device, or refuse. Zero means nobody pressed the
//      button; more than one means a write would give them all the same address.
//   2. Is `ia` free? If something already answers there and it is not the device we are about to
//      program, refuse: assigning it would create a duplicate address.
//   3. Write the address (broadcast).
//   4. Prove it, by IDENTITY and not merely by presence. The device is still in programming mode,
//      so ask again who is there: it must be exactly one device, and it must now answer FROM the
//      new address. "Does something answer at `ia`?" is not enough on its own, because an
//      unrelated device already sitting at `ia` answers that just as well, which would turn a
//      write that never landed into a green result. Then confirm it is reachable there.
//   5. Switch programming mode off, so the device does not also answer the next assignment: A_Restart
//      on the connection of the descriptor read, as ETS ends it on System 1, System 7 and System B.
export async function assignIndividualAddress(tun: KnxTransport, ia: string, opts: AssignIaOptions = {}): Promise<AssignIaResult> {
  const { probeMs = 3000, settleMs = 1000, returnMs = RETURN_MS, onProgress } = opts;

  onProgress?.("probe");
  const inProgMode = await readProgModeDevices(tun, probeMs);
  if (inProgMode.length === 0) {
    throw new KnxError("PROG_MODE_NO_DEVICE",
      "no device is in programming mode; press the programming button on the device you want to address, then try again");
  }
  if (inProgMode.length > 1) {
    throw new KnxError("PROG_MODE_MULTIPLE_DEVICES",
      `${inProgMode.length} devices are in programming mode (${inProgMode.join(", ")}); an address write would give the SAME address to all of them. Leave exactly one in programming mode.`);
  }
  const previous = inProgMode[0];
  if (opts.onlySerial !== undefined) {
    const holder = await readAddressBySerial(tun, opts.onlySerial, probeMs);
    if (holder !== previous) {
      throw new KnxError("PROG_MODE_NOT_THIS_DEVICE",
        `the device in programming mode is ${previous}, and the device with serial ${opts.onlySerial} ${holder === null ? "does not answer" : `answers from ${holder}`}; its keys were not answered, so it is not addressed the plain way through another device`);
    }
  }

  if (previous !== ia) {
    onProgress?.("check-free");
    if (await addressAnswers(tun, ia, true)) { // the programming-mode probe just got an answer
      throw new KnxError("IA_ALREADY_IN_USE",
        `another device already answers on ${ia}; assigning it would put two devices with the same address on the bus. Refusing.`);
    }
  }

  onProgress?.("write");
  await writeIndividualAddress(tun, ia);
  await sleep(settleMs);

  // IDENTITY, not presence. The device we wrote to is still in programming mode, so it is still
  // the one that answers this probe, and it now answers from whatever address it actually holds.
  onProgress?.("verify");
  const after = await readProgModeDevices(tun, probeMs);
  if (after.length !== 1 || after[0] !== ia) {
    const where = after.length === 0 ? "nothing answers in programming mode any more" : `programming mode now answers from ${after.join(", ")}`;
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written but the device did not take it (${where}); it may still hold ${previous}. Read the bus before continuing.`);
  }
  // ...and it is reachable there for real management, not just for the broadcast probe. The
  // connection stays open for the restart that ends programming mode below.
  const reached = await answerAt(tun, ia, true, true);
  if (reached === null) {
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written and the device reports it, but it does not answer management there. Read the bus before continuing.`);
  }

  // Programming mode off. A device left in programming mode silently takes part in the NEXT
  // assignment, so a failure here is carried out with its reason rather than swallowed, even
  // though the address itself is by now assigned and verified.
  //
  // ETS ends it with A_Restart on the connection of its descriptor read at the new address, on every
  // family a capture shows (private corpus: internal/captures/hager-th001/ets-ia-assign-proxy.log, System 1;
  // internal/captures/progmode-end-2026-11-19/d1-*, d3-*, MV-0705 and MV-0701; bussard's syn-minimal/assign,
  // a simulated MV-07B0), and writes no PID_PROGMODE. Where the device has a device object ETS reads
  // PID_MAX_APDU_LENGTH and the serial number between the two; Busforge does not, they are reads. A unit
  // in Data Secure mode ignores a plain A_Restart (docs/findings.md §18): ETS addresses such a unit by its
  // serial number and restarts it under its tool key, which this plain route does not do, so the probe below
  // reports it still in programming mode.
  onProgress?.("prog-mode-off");
  let progModeCleared = false;
  let progModeError: string | null = null;
  let dev = reached.dev;
  try {
    // A device that closed the connection instead of handing out its descriptor is reached again.
    if (!dev) { dev = new KnxDevice(tun, ia); await dev.connect(); }
    // The probe below decides whether the mode ended, so a restart the interface confirmed
    // negatively (the device rebooting before its acknowledgement) is not read here.
    await dev.sendRestart();
    await dev.disconnect();
    dev = null;
    ({ progModeCleared, progModeError } = await progModeAfterRestart(tun, ia, settleMs, probeMs, returnMs, () => true));
  } catch (e) {
    progModeError = e instanceof Error ? e.message : String(e);
  } finally {
    if (dev) { try { await dev.disconnect(); } catch { /* connection may already be gone */ } }
  }

  return { previous, assigned: ia, verified: true, progModeCleared, progModeError, route: "programming-mode" };
}

// Whether the device at `ia` left programming mode after its restart. A rebooting device answers nothing,
// so silence to the probe proves the mode ended only once the device answers at its address again (the MDT
// BE-02001.02 is back about 2 s after the restart, the GVS AMMA about 4 s): it is asked again until it
// answers or `returnMs` has passed. `stillIn`: whether the addresses answering in programming mode include
// the device.
const RETURN_MS = 10_000;
async function progModeAfterRestart(tun: KnxTransport, ia: string, settleMs: number, probeMs: number, returnMs: number, stillIn: (inProgMode: string[]) => boolean): Promise<{ progModeCleared: boolean; progModeError: string | null }> {
  await sleep(settleMs);
  const until = Date.now() + returnMs;
  while (await answerAt(tun, ia, true, false) === null) {
    if (Date.now() >= until) {
      return { progModeCleared: false, progModeError: `the device does not answer at ${ia} after the restart, so whether it left programming mode is not known` };
    }
    await sleep(settleMs);
  }
  const now = await readProgModeDevices(tun, probeMs);
  if (now.length === 0 || !stillIn(now)) return { progModeCleared: true, progModeError: null };
  return { progModeCleared: false, progModeError: "the device still answers in programming mode after the restart" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Addressing a device by its SERIAL NUMBER.
//
// The programming-mode dance above has two costs: somebody must physically press a button, and
// every device in programming mode takes the address. Addressing by serial number has neither. It
// is still a broadcast, but only a device holding the serial it names takes the address, so no bystander in
// programming mode takes it by accident and nobody has to be at the bench. A serial does not name one
// device by itself: one that is not set, or one two units share, reaches each of them, and that is refused.
//
// It is also the only thing that works in the situation it was invented for: SEVERAL unconfigured
// devices on one line. They all sit on the factory address 15.15.255, so a point-to-point read
// gets whichever answers first, and nothing else can tell them apart. Their serial numbers can.
// ─────────────────────────────────────────────────────────────────────────────

const SERIAL_LEN = 6;

// A serial number of all zeros or all ones is what a unit holds where none was ever written into it
// (cleared or erased memory), so any number of units can hold it and a serial-number service would
// reach every one of them.
function serialBytes(serial: string): Buffer {
  const hex = serial.replace(/[\s:.-]/g, "");
  if (!new RegExp(`^[0-9a-f]{${SERIAL_LEN * 2}}$`, "i").test(hex)) {
    throw new KnxError("SERIAL_INVALID", `"${serial}" is not a 6-byte KNX serial number (e.g. 00FA00000032)`);
  }
  const b = Buffer.from(hex, "hex");
  if (b.every((x) => x === 0x00) || b.every((x) => x === 0xff)) {
    throw new KnxError("SERIAL_NOT_UNIQUE",
      `the serial number ${b.toString("hex").toUpperCase()} is not set on the unit and does not tell it apart from others; assign its address by programming mode`);
  }
  return b;
}

// Ask, by broadcast, which addresses answer for this serial number. A device answers where the serial
// equals its own PID_SERIAL_NUMBER, so an empty result means no device holding it is on this line, not
// that something went wrong.
async function serialResponders(tun: KnxTransport, serial: string, probeMs: number): Promise<string[]> {
  const want = serialBytes(serial);
  const found = new Set<number>();
  const prev = tun.onCemi;
  tun.onCemi = (src, _dst, tpdu, isGroup) => {
    if (!isGroup) return;
    const p = parseApdu(tpdu);
    // The response repeats the serial number; the device's address is the frame's SOURCE.
    if (p.apci === APCI.IA_SERIAL_RESPONSE && p.data.subarray(0, SERIAL_LEN).equals(want)) found.add(src);
  };
  try {
    await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, apduUnnumbered(APCI.IA_SERIAL_READ, want)));
    await sleep(probeMs);
  } finally {
    tun.onCemi = prev;
  }
  return [...found].sort((a, b) => a - b).map(numToIa);
}

// The address the device with this serial number currently holds, or null where none answers. Two
// addresses answering for one serial mean it is not unique on this line, and that is refused.
export async function readAddressBySerial(tun: KnxTransport, serial: string, probeMs = 3000): Promise<string | null> {
  const found = await serialResponders(tun, serial, probeMs);
  if (found.length > 1) {
    throw new KnxError("SERIAL_NOT_UNIQUE",
      `devices on ${found.join(", ")} all answer for the serial number ${serial}; a serial-number write would reach each of them. Assign their addresses by programming mode`);
  }
  return found[0] ?? null;
}

// A_IndividualAddress_SerialNumber_Write: serial (6) + the new address (2) + 4 reserved zero bytes.
function serialWriteApdu(serial: string, ia: string): Buffer {
  const n = iaToNum(ia);
  return apduUnnumbered(APCI.IA_SERIAL_WRITE, Buffer.concat([serialBytes(serial), Buffer.from([(n >> 8) & 0xff, n & 0xff]), Buffer.alloc(4)]));
}
export async function writeAddressBySerial(tun: KnxTransport, serial: string, ia: string): Promise<void> {
  await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, serialWriteApdu(serial, ia)));
}

// Steps 1 and 2 of both serial-number routes: where the device with this serial is (refused when nowhere),
// and that `ia` is free unless it is already the device's. Returns the address it answered from.
async function locateBySerial(tun: KnxTransport, serial: string, ia: string, probeMs: number, onProgress?: (phase: string) => void): Promise<string> {
  onProgress?.("probe");
  const previous = await readAddressBySerial(tun, serial, probeMs);
  if (previous === null) {
    throw new KnxError("SERIAL_NOT_FOUND",
      `no device with the serial number ${serial} answers on this line; check the serial, and that the device is powered and connected`);
  }
  if (previous !== ia) {
    onProgress?.("check-free");
    if (await addressAnswers(tun, ia, true)) { // the device just answered the serial-number read
      throw new KnxError("IA_ALREADY_IN_USE",
        `another device already answers on ${ia}; assigning it would put two devices with the same address on the bus. Refusing.`);
    }
  }
  return previous;
}

// Give the device with this serial number the address `ia`, and prove it.
//
// The safety rails are the same ones the programming-mode path needs, minus the ones it only needs
// because it cannot tell devices apart:
//   1. The device must actually be on this line (it answers a serial-number read), and it alone: a
//      serial that is not set, or that answers from two addresses, is refused before the write.
//   2. The target address must not already answer from a DIFFERENT device.
//   3. Afterwards the device must report the new address FOR THAT SERIAL, and nothing else may answer for
//      it from another address. Identity, not presence: "something answers at the target" would also be
//      true if the write never landed and an unrelated device happened to sit there.
export async function assignAddressBySerial(tun: KnxTransport, serial: string, ia: string, opts: AssignIaOptions = {}): Promise<AssignIaResult> {
  const { probeMs = 3000, settleMs = 1000, onProgress } = opts;
  const previous = await locateBySerial(tun, serial, ia, probeMs, onProgress);

  onProgress?.("write");
  await writeAddressBySerial(tun, serial, ia);
  await sleep(settleMs);

  onProgress?.("verify");
  const now = await serialResponders(tun, serial, probeMs);
  if (now.length > 1) {
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written, and devices on ${now.join(", ")} now all answer for the serial ${serial}; another unit holding it may have taken the address too. Read the bus before continuing.`);
  }
  if (now[0] !== ia) {
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written but the device with serial ${serial} reports ${now[0] ?? "nothing"}; it may still hold ${previous}. Read the bus before continuing.`);
  }
  if (!(await addressAnswers(tun, ia, true))) {
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written and the device reports it, but it does not answer management there. Read the bus before continuing.`);
  }

  // Serial-number addressing never touches programming mode, so there is none to switch off.
  return { previous, assigned: ia, verified: true, progModeCleared: true, progModeError: null, route: "serial" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Addressing a KNX Data Secure device by its serial number, as ETS does it.
//
// A device in Data Secure mode takes management only under its tool key. ETS never sends it a plain
// address write: it gives it the address by a SECURED serial-number write, by broadcast under the device's
// key, and then loads its security object's network configuration and ends with a secured confirmed
// restart (private corpus internal/captures/progmode-end-2026-11-19, README: runs i1/i2 and b1/b2 on the
// Jung 400021SE, c1/c2 on the GVS AMMA-04/06.S, a2/a3 on the Jung with Data Secure off in the project):
//
//   1. plain IA_SerialNumber_Read by broadcast, answered plain from the address the device holds (i1; with
//      the device in programming mode ETS asks SystemNetworkParameter_Read PID 11 instead, b1/c1/a2, and
//      learns the same serial);
//   2. Sync.req by broadcast under the key (SCF 0x92, the target's serial in clear), Sync.res to 0/0/0;
//   3. secured IA_SerialNumber_Write by broadcast, then secured IA_SerialNumber_Read, answered secured from
//      the new address;
//   4. a connection to the new address, more than a second after that Sync: plain DescRead (FFFF from a
//      device in secure mode) and plain PID_MAX_APDU_LENGTH read, then the point-to-point Sync (serial field
//      zero), and a secured DescRead where the plain one answered FFFF;
//   5. with Data Secure on: PID_SECURITY_MODE switched on (function command 000001), the tool key written to
//      PID 56 (the same key), the device's sending sequence written to PID 59 (ETS's clock); with Data Secure
//      off: PID_SECURITY_MODE read twice, no write;
//   6. the serial read secured (PID 11), the confirmed restart (erase code 1, channel 0), answered with error
//      0, T_Disconnect.
//
// Busforge adds what the plain path checks as well: the target is free (only after the device answered, so
// that a negatively confirmed frame of a USB interface reads as absent), and after the restart that the
// device answers at its address again and no longer in programming mode.
// ─────────────────────────────────────────────────────────────────────────────

export interface SecureAssignCreds {
  // The device's tool key, or its factory key (FDSK) where the project runs it without Data Secure: ETS
  // runs the off case under the FDSK, the key a device holds as its tool key after its security mode went off.
  key: Buffer;
  serial: Buffer;
  // The project runs the device in Data Secure: its security object's network configuration is loaded
  // (step 5). Undefined where that is not known (a tool key on file without the certificate, so it may be the
  // FDSK of a unit whose Data Secure went off): the device's own state decides, the plain descriptor FFFF of
  // a unit in secure mode for on, its mask for off. Nothing switches the mode on that is off.
  dataSecure?: boolean;
  // The device's sending counter as its authenticated answers showed it last, for the caller to record.
  onPeerSequence?: (sequence: bigint) => void;
}

// Send one secured broadcast and hand every secured broadcast frame to `take` until it returns true or the
// window, counted from the end of the send (an interface over TCP confirms the frame first), ends. An answer
// that comes during the send is taken. Plain frames are no answer to a secured request and are not offered.
async function secureBroadcast(tun: KnxTransport, tpdu: Buffer, windowMs: number, take: (src: number, tpdu: Buffer) => boolean, untilFirst: boolean): Promise<void> {
  const prev = tun.onCemi;
  let done: () => void = () => undefined;
  const finished = new Promise<void>((r) => { done = r; });
  tun.onCemi = (src, dst, frame, isGroup) => {
    if (!isGroup || dst !== BROADCAST || !isSecureApdu(frame)) return;
    if (take(src, frame) && untilFirst) done();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, tpdu));
    timer = setTimeout(done, windowMs);
    await finished;
  } finally {
    clearTimeout(timer);
    tun.onCemi = prev;
  }
}

// Give the Data Secure device with this serial number the address `ia`, under its key, and prove it.
// SECURE_SYNC_NO_RESPONSE comes only from step 2, before anything is written.
export async function assignSecureAddressBySerial(tun: KnxTransport, ia: string, creds: SecureAssignCreds, opts: AssignIaOptions = {}): Promise<AssignIaResult> {
  const { probeMs = 3000, settleMs = 1000, returnMs = RETURN_MS, onProgress } = opts;
  const serial = creds.serial.toString("hex");
  const sessions: SecureSession[] = [];
  try {
    const previous = await locateBySerial(tun, serial, ia, probeMs, onProgress);

    onProgress?.("write");
    const bc = new SecureSession({ toolKey: creds.key, src: tun.assignedIa, dst: BROADCAST, serial: creds.serial, broadcast: true });
    sessions.push(bc);
    const challenge = randomBytes(6);
    let syncedFrom: number | null = null;
    let unauthentic = 0;
    await secureBroadcast(tun, bc.buildSyncRequest(creds.serial, challenge, 0), DEVICE_TIMEOUTS.syncResponseMs, (src, frame) => {
      if ((frame[2] & 0x07) !== SCF.S_A_SYNC_RSP) return false;
      if (!bc.applySyncResponse(frame, challenge, src)) { unauthentic++; return false; }
      syncedFrom = src;
      return true;
    }, true);
    if (syncedFrom === null && unauthentic > 0) {
      throw new KnxError("SECURE_SYNC_FAILED", `the device with serial ${serial} answered the broadcast secure Sync, but the answer did not authenticate under the key on file: it holds another key; nothing was written`);
    }
    if (syncedFrom === null) {
      throw new KnxError("SECURE_SYNC_NO_RESPONSE", `the device with serial ${serial} did not answer the broadcast secure Sync under the key tried: it holds another key (reset to its factory key, or given one by another tool), or it is not in secure mode; nothing was written`);
    }
    if (numToIa(syncedFrom) !== previous) {
      throw new KnxError("SECURE_SYNC_FAILED", `the device with serial ${serial} answered the serial-number read from ${previous} and the secure Sync from ${numToIa(syncedFrom)}; nothing was written`);
    }
    const syncAt = Date.now();
    noteSync(iaToNum(previous), syncAt);
    noteSync(iaToNum(ia), syncAt);
    await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, bc.wrapManagement(serialWriteApdu(serial, ia), 0)));
    await sleep(settleMs);

    onProgress?.("verify");
    const now = new Set<number>();
    await secureBroadcast(tun, bc.wrapManagement(apduUnnumbered(APCI.IA_SERIAL_READ, creds.serial), 0), probeMs, (src, frame) => {
      const r = bc.unwrap(frame, src);
      if (r.status !== "ok") return false;
      const p = parseApdu(r.apdu);
      if (p.apci !== APCI.IA_SERIAL_RESPONSE || !p.data.subarray(0, SERIAL_LEN).equals(creds.serial)) return false;
      now.add(src);
      return true;
    }, false);
    const answered = [...now].sort((a, b) => a - b).map(numToIa);
    if (answered.length > 1) {
      throw new KnxError("IA_WRITE_UNVERIFIED",
        `${ia} was written, and devices on ${answered.join(", ")} now all answer for the serial ${serial} under its key. Read the bus before continuing.`);
    }
    if (answered[0] !== ia) {
      throw new KnxError("IA_WRITE_UNVERIFIED",
        `${ia} was written but the device with serial ${serial} reports ${answered[0] ?? "nothing"} under its key; it may still hold ${previous}. Read the bus before continuing.`);
    }

    // The network configuration and the restart, on a connection to the new address.
    onProgress?.("prog-mode-off");
    const dev = new KnxDevice(tun, ia);
    let connected = false;
    let progModeCleared = false;
    let progModeError: string | null = null;
    try {
      try {
        await dev.connect();
        connected = true;
        const plainMask = await dev.deviceDescriptor();
        await dev.readMaxApduLength();
        // The session's serial field stays zero, as ETS's point-to-point Sync carries it (b1/c1/i1/a2).
        const p2p = new SecureSession({ toolKey: creds.key, src: tun.assignedIa, dst: iaToNum(ia) });
        sessions.push(p2p);
        await dev.secureOpenConnection(p2p);
        // A device in secure mode hides its mask from a plain read (FFFF); ETS reads it again secured then
        // only ("ReReadDeviceDescriptorIfCurrentlyFFFF", b1/c1/i1), not after a plain 07B0 (a2).
        const inSecureMode = plainMask === "MV-FFFF";
        if (inSecureMode) await dev.deviceDescriptor();
        if (creds.dataSecure ?? inSecureMode) {
          // Reserved octet, service 0 (set mode), mode 1, as ETS sends it; the device answers [return code, mode].
          const { returnCode } = await dev.funcPropExtCommand(OBJECT_TYPE_SECURITY, 1, SECURITY_PID.SECURITY_MODE, Buffer.from([0x00, 0x00, 0x01]));
          if (returnCode !== 0) throw new KnxError("ACTIVATION_REFUSED", `the device refused to switch its security mode on (return code 0x${returnCode.toString(16)})`);
          await dev.writeToolKey(creds.key);
          await dev.writeSendingSequence(toolSequenceNow());
        } else {
          // ETS reads the mode twice in a2/a3 and switches nothing. A device in secure mode under its factory
          // key is not what the project says; ETS's answer to that in a download (a1) is a master reset,
          // which an address assignment does not do.
          for (let i = 0; i < 2; i++) {
            if (await dev.securityMode()) {
              throw new KnxError("SECURE_MODE_UNEXPECTED", "the project runs the device without Data Secure, but it is in secure mode under its factory key");
            }
          }
        }
        const read = await dev.propRead(0, 11);
        if (!read.equals(creds.serial)) {
          throw new KnxError("IA_WRITE_UNVERIFIED", `the device at ${ia} answers under its key with serial ${read.toString("hex")}, not ${serial}`);
        }
      } catch (e) {
        const why = e instanceof KnxError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        throw new KnxError("SECURE_IA_CONFIG_FAILED", `${ia} is assigned to the device with serial ${serial} and proven under its key, but its secured connection failed before the restart (${why}); it was not restarted`);
      }
      // From the restart on the address stands, so a failure is carried out with the result, as on the plain route.
      try {
        await dev.restart(true, true);
        await dev.disconnect();
        connected = false;
        ({ progModeCleared, progModeError } = await progModeAfterRestart(tun, ia, settleMs, probeMs, returnMs, (inProgMode) => inProgMode.includes(ia)));
      } catch (e) {
        progModeError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (connected) { try { await dev.disconnect(); } catch { /* the connection may already be gone */ } }
    }
    return { previous, assigned: ia, verified: true, progModeCleared, progModeError, route: "serial-secured" };
  } finally {
    const seen = sessions.map((x) => x.peerSequence).filter((x): x is bigint => x !== null);
    if (seen.length && creds.onPeerSequence) creds.onPeerSequence(seen.reduce((a, b) => (a > b ? a : b)));
  }
}

// The keys a Data Secure device's address assignment can run under: its tool key on file, its certificate's
// factory key (FDSK), and the serial both are bound to.
export interface DeviceKeys { serial: Buffer; toolKey?: Buffer; fdsk?: Buffer; onPeerSequence?: (sequence: bigint) => void }

// Give a device its address, by the route its keys allow. With a tool key or a certificate on file it is a
// Data Secure device and goes by serial secured (assignSecureAddressBySerial): under the tool key first, then
// under the FDSK, as ETS tries them on a unit reset to its factory key (private corpus
// internal/captures/cap-1001), the FDSK as a unit without Data Secure, which such a unit is. A tool key equal
// to the FDSK is a unit whose Data Secure went off (ETS writes the FDSK as the tool key then); one without the
// certificate leaves that open to the device's state (SecureAssignCreds.dataSecure). Only where no key gets
// the broadcast Sync answered at all, nothing has been written, and the plain programming-mode route runs,
// for the device in programming mode only if it is the one with this serial; the result says so
// (`secureNotAnswered`). Without keys the plain route runs.
export async function assignAddress(tun: KnxTransport, ia: string, keys: DeviceKeys | undefined, opts: AssignIaOptions = {}): Promise<AssignIaResult> {
  if (!keys) return assignIndividualAddress(tun, ia, opts);
  const tries: { key: Buffer; dataSecure?: boolean; name: string }[] = [];
  if (keys.toolKey) tries.push({ key: keys.toolKey, dataSecure: keys.fdsk ? !keys.fdsk.equals(keys.toolKey) : undefined, name: "tool key" });
  if (keys.fdsk && !keys.toolKey?.equals(keys.fdsk)) tries.push({ key: keys.fdsk, dataSecure: false, name: "factory key (FDSK)" });
  for (const t of tries) {
    try {
      return await assignSecureAddressBySerial(tun, ia, { key: t.key, serial: keys.serial, dataSecure: t.dataSecure, onPeerSequence: keys.onPeerSequence }, opts);
    } catch (e) {
      if ((e as { code?: string }).code !== "SECURE_SYNC_NO_RESPONSE") throw e;
    }
  }
  const res = await assignIndividualAddress(tun, ia, { ...opts, onlySerial: keys.serial.toString("hex") });
  return { ...res, secureNotAnswered: `the device with serial ${keys.serial.toString("hex")} answered the broadcast secure Sync under none of the keys on file (${tries.map((t) => t.name).join(", ")}), so the address went the plain way` };
}
