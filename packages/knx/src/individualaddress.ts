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
import type { KnxTransport } from "./transport.ts";
import { KnxDevice } from "./device.ts";
import { cemiLDataGroup, apduUnnumbered, parseApdu, numToIa, iaToNum, APCI, BROADCAST } from "./frame.ts";
import { KnxError } from "./errors.ts";

// The device object's programming-mode property (PID_PROGMODE). Writing 0 switches the mode
// off, which is what ETS does once the address is assigned: leaving it on would make the
// device answer the NEXT assignment too.
const OBJ_DEVICE = 0;
const PID_PROGMODE = 54;

export interface AssignIaOptions {
  // How long to listen for A_IndividualAddress_Response frames. Devices answer within
  // milliseconds; the default is generous because the window is also the only thing standing
  // between us and a missed second device in programming mode.
  probeMs?: number;
  // Time for the device to apply its new address before we talk to it there.
  settleMs?: number;
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
async function addressAnswers(tun: KnxTransport, ia: string): Promise<boolean> {
  const dev = new KnxDevice(tun, ia);
  try {
    await dev.connect();
    await dev.deviceDescriptor();
    return true;
  } catch (e) {
    if (e instanceof KnxError && e.code === "DEVICE_NOT_ANSWERING") return false; // silence: absent
    // A T_Disconnect answering our request: a device is there (in another tool's connection, or
    // one that missed our T_Connect), so the address is taken.
    if (e instanceof KnxError && e.code === "DEVICE_CLOSED_CONNECTION") return true;
    throw e; // a transport failure is not evidence of a free address
  } finally {
    try { await dev.disconnect(); } catch { /* nothing was connected */ }
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
//   5. Switch programming mode off, so the device does not also answer the next assignment.
export async function assignIndividualAddress(tun: KnxTransport, ia: string, opts: AssignIaOptions = {}): Promise<AssignIaResult> {
  const { probeMs = 3000, settleMs = 1000, onProgress } = opts;

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

  if (previous !== ia) {
    onProgress?.("check-free");
    if (await addressAnswers(tun, ia)) {
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
  // ...and it is reachable there for real management, not just for the broadcast probe.
  if (!(await addressAnswers(tun, ia))) {
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written and the device reports it, but it does not answer management there. Read the bus before continuing.`);
  }

  // Programming mode off. A device left in programming mode silently takes part in the NEXT
  // assignment, so a failure here is carried out with its reason rather than swallowed, even
  // though the address itself is by now assigned and verified.
  onProgress?.("prog-mode-off");
  let progModeCleared = false;
  let progModeError: string | null = null;
  const dev = new KnxDevice(tun, ia);
  try {
    await dev.connect();
    await dev.propWrite(OBJ_DEVICE, PID_PROGMODE, Buffer.from([0]));
    progModeCleared = (await readProgModeDevices(tun, probeMs)).length === 0;
    if (!progModeCleared) progModeError = "the device still answers in programming mode after the write";
  } catch (e) {
    progModeError = e instanceof Error ? e.message : String(e);
  } finally {
    try { await dev.disconnect(); } catch { /* connection may already be gone */ }
  }

  return { previous, assigned: ia, verified: true, progModeCleared, progModeError };
}

// ─────────────────────────────────────────────────────────────────────────────
// Addressing a device by its SERIAL NUMBER.
//
// The programming-mode dance above has two costs: somebody must physically press a button, and
// every device in programming mode takes the address. Addressing by serial number has neither. It
// is still a broadcast, but it names exactly one device, so no bystander can take the address by
// accident and nobody has to be at the bench.
//
// It is also the only thing that works in the situation it was invented for: SEVERAL unconfigured
// devices on one line. They all sit on the factory address 15.15.255, so a point-to-point read
// gets whichever answers first, and nothing else can tell them apart. Their serial numbers can.
// ─────────────────────────────────────────────────────────────────────────────

const SERIAL_LEN = 6;

function serialBytes(serial: string): Buffer {
  const b = Buffer.from(serial.replace(/[^0-9a-f]/gi, ""), "hex");
  if (b.length !== SERIAL_LEN) {
    throw new KnxError("SERIAL_INVALID", `"${serial}" is not a 6-byte KNX serial number (e.g. 00FA00000032)`);
  }
  return b;
}

// Ask, by broadcast, which address the device with this serial number currently holds. Only that
// device answers (the firmware compares the serial against its own PID_SERIAL_NUMBER), so an empty
// result means it is not on this line, not that something went wrong.
export async function readAddressBySerial(tun: KnxTransport, serial: string, probeMs = 3000): Promise<string | null> {
  const want = serialBytes(serial);
  let found: number | null = null;
  const prev = tun.onCemi;
  tun.onCemi = (src, _dst, tpdu, isGroup) => {
    if (!isGroup) return;
    const p = parseApdu(tpdu);
    // The response repeats the serial number; the device's address is the frame's SOURCE.
    if (p.apci === APCI.IA_SERIAL_RESPONSE && p.data.subarray(0, SERIAL_LEN).equals(want)) found = src;
  };
  try {
    await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, apduUnnumbered(APCI.IA_SERIAL_READ, want)));
    await sleep(probeMs);
  } finally {
    tun.onCemi = prev;
  }
  return found === null ? null : numToIa(found);
}

// A_IndividualAddress_SerialNumber_Write: serial (6) + the new address (2) + 4 reserved zero bytes.
export async function writeAddressBySerial(tun: KnxTransport, serial: string, ia: string): Promise<void> {
  const n = iaToNum(ia);
  const tail = Buffer.concat([serialBytes(serial), Buffer.from([(n >> 8) & 0xff, n & 0xff]), Buffer.alloc(4)]);
  await tun.sendCemi(cemiLDataGroup(tun.assignedIa, BROADCAST, apduUnnumbered(APCI.IA_SERIAL_WRITE, tail)));
}

// Give the device with this serial number the address `ia`, and prove it.
//
// The safety rails are the same ones the programming-mode path needs, minus the ones it only needs
// because it cannot tell devices apart:
//   1. The device must actually be on this line (it answers a serial-number read).
//   2. The target address must not already answer from a DIFFERENT device.
//   3. Afterwards the device must report the new address FOR THAT SERIAL. Identity, not presence:
//      "something answers at the target" would also be true if the write never landed and an
//      unrelated device happened to sit there.
export async function assignAddressBySerial(tun: KnxTransport, serial: string, ia: string, opts: AssignIaOptions = {}): Promise<AssignIaResult> {
  const { probeMs = 3000, settleMs = 1000, onProgress } = opts;

  onProgress?.("probe");
  const previous = await readAddressBySerial(tun, serial, probeMs);
  if (previous === null) {
    throw new KnxError("SERIAL_NOT_FOUND",
      `no device with the serial number ${serial} answers on this line; check the serial, and that the device is powered and connected`);
  }

  if (previous !== ia) {
    onProgress?.("check-free");
    if (await addressAnswers(tun, ia)) {
      throw new KnxError("IA_ALREADY_IN_USE",
        `another device already answers on ${ia}; assigning it would put two devices with the same address on the bus. Refusing.`);
    }
  }

  onProgress?.("write");
  await writeAddressBySerial(tun, serial, ia);
  await sleep(settleMs);

  onProgress?.("verify");
  const now = await readAddressBySerial(tun, serial, probeMs);
  if (now !== ia) {
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written but the device with serial ${serial} reports ${now ?? "nothing"}; it may still hold ${previous}. Read the bus before continuing.`);
  }
  if (!(await addressAnswers(tun, ia))) {
    throw new KnxError("IA_WRITE_UNVERIFIED",
      `${ia} was written and the device reports it, but it does not answer management there. Read the bus before continuing.`);
  }

  // Serial-number addressing never touches programming mode, so there is none to switch off.
  return { previous, assigned: ia, verified: true, progModeCleared: true, progModeError: null };
}
