import { test, expect, describe } from "bun:test";
import type { KnxTransport } from "../src/transport.ts";
import { parseCemiLData } from "../src/transport.ts";
import { assignIndividualAddress, readProgModeDevices, writeIndividualAddress } from "../src/individualaddress.ts";
import { apduUnnumbered, parseApdu, iaToNum, numToIa, APCI, BROADCAST } from "../src/frame.ts";
import { KnxError } from "../src/errors.ts";

// Individual-address assignment against a simulated bus. The dangerous cases are the point of
// this suite: a broadcast address write hits EVERY device in programming mode, so the code must
// refuse rather than write when the bus does not look exactly the way it must.

// A device on the simulated line. `progMode` decides whether it answers the broadcast
// A_IndividualAddress_Read and whether it takes an A_IndividualAddress_Write.
class SimDevice {
  // `deafFor`: ignore this many point-to-point frames before answering. That is what a device
  // busy, rebooting, or behind a burst of line noise looks like, and it is how the pre-check can
  // miss a device that IS on the target address.
  // `closes`: answer every numbered frame with a T_Disconnect, as a device in another tool's
  // connection (or one that missed our T_Connect) does.
  constructor(public ia: string, public progMode: boolean, public takesWrite = true, public deafFor = 0, public closes = false) {}
}

class SimBus implements KnxTransport {
  readonly assignedIa = iaToNum("0.0.1");
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  broadcastWrites: string[] = [];
  progModeWrites = 0;

  constructor(public devices: SimDevice[]) {}
  async connect() {}
  async disconnect() {}

  private deviceAt(n: number) { return this.devices.find((d) => iaToNum(d.ia) === n); }

  async sendCemi(cemi: Buffer): Promise<void> {
    const { dst, tpdu, isGroup } = parseCemiLData(cemi);
    const p = parseApdu(tpdu);

    if (isGroup && dst === BROADCAST) {
      if (p.apci === APCI.INDIVIDUAL_ADDRESS_READ) {
        // every device in programming mode answers, with its own address as the frame source
        for (const d of this.devices.filter((x) => x.progMode)) {
          this.deliver(iaToNum(d.ia), BROADCAST, apduUnnumbered(APCI.INDIVIDUAL_ADDRESS_RESPONSE), true);
        }
        return;
      }
      if (p.apci === APCI.INDIVIDUAL_ADDRESS_WRITE) {
        const ia = numToIa((p.data[0] << 8) | p.data[1]);
        this.broadcastWrites.push(ia);
        for (const d of this.devices.filter((x) => x.progMode && x.takesWrite)) d.ia = ia; // ALL of them
        return;
      }
      return;
    }

    // Connection-oriented management: only a device that exists at the destination answers.
    const dev = this.deviceAt(dst);
    if (!dev) return; // silence: the request times out, which is how a free address looks
    if (dev.deafFor > 0) { dev.deafFor--; return; } // present, but not answering right now
    const t = tpdu[0];
    if (t === 0x80) { this.deliver(dst, this.assignedIa, Buffer.from([0xc2]), false); return; } // T_Connect -> T_ACK
    if (t === 0x81) return;                                                                     // T_Disconnect
    if (dev.closes) { this.deliver(dst, this.assignedIa, Buffer.from([0x81]), false); return; }
    const seq = (t >> 2) & 0x0f;
    this.deliver(dst, this.assignedIa, Buffer.from([0xc2 | (seq << 2)]), false);                // T_ACK the request
    if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) {
      this.deliver(dst, this.assignedIa, Buffer.from([0x40 | (seq << 2), 0x40, 0x07, 0xb0]), false); // MV-07B0
    }
    if (p.apci === APCI.PROPERTY_WRITE) {
      const [obj, pid] = [p.data[0], p.data[1]];
      if (obj === 0 && pid === 54) { this.progModeWrites++; dev.progMode = p.data[4] !== 0; }
      this.deliver(dst, this.assignedIa, Buffer.from([0x40 | (seq << 2), 0xd6, obj, pid, p.data[2], p.data[3], 0]), false);
    }
  }

  private deliver(src: number, dst: number, tpdu: Buffer, isGroup: boolean) {
    queueMicrotask(() => this.onCemi?.(src, dst, tpdu, isGroup));
  }
}

const NEW_IA = "1.2.32";
const fast = { probeMs: 20, settleMs: 5 };

describe("reading who is in programming mode", () => {
  test("reports every device that answers, by its own address", async () => {
    const bus = new SimBus([new SimDevice("15.15.255", true), new SimDevice("1.1.5", false), new SimDevice("1.1.6", true)]);
    expect(await readProgModeDevices(bus, 20)).toEqual(["1.1.6", "15.15.255"]);
  });

  test("an empty bus is an empty answer, not an error", async () => {
    expect(await readProgModeDevices(new SimBus([new SimDevice("1.1.5", false)]), 20)).toEqual([]);
  });

  test("it restores the transport's previous frame handler", async () => {
    const bus = new SimBus([]);
    const mine = () => {};
    bus.onCemi = mine;
    await readProgModeDevices(bus, 5);
    expect(bus.onCemi).toBe(mine);
  });
});

describe("assigning an individual address", () => {
  test("assigns to the one device in programming mode, verifies it, and switches the mode off", async () => {
    const virgin = new SimDevice("15.15.255", true);
    const bus = new SimBus([virgin, new SimDevice("1.1.5", false)]);

    const res = await assignIndividualAddress(bus, NEW_IA, fast);

    expect(res).toEqual({ previous: "15.15.255", assigned: NEW_IA, verified: true, progModeCleared: true, progModeError: null });
    expect(virgin.ia).toBe(NEW_IA);       // the device really moved
    expect(virgin.progMode).toBe(false);  // and will not answer the next assignment
    expect(bus.broadcastWrites).toEqual([NEW_IA]);
    expect(bus.progModeWrites).toBe(1);
  }, 20_000); // the "is the target free?" probe waits out a silent address (3 tries x 1.5 s)

  test("REFUSES when no device is in programming mode, and writes nothing", async () => {
    const bus = new SimBus([new SimDevice("1.1.5", false)]);
    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("PROG_MODE_NO_DEVICE");
    expect(bus.broadcastWrites).toEqual([]);
  });

  test("REFUSES when TWO devices are in programming mode: a write would give both the same address", async () => {
    const a = new SimDevice("15.15.255", true);
    const b = new SimDevice("1.1.9", true);
    const bus = new SimBus([a, b]);

    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);

    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("PROG_MODE_MULTIPLE_DEVICES");
    expect(bus.broadcastWrites).toEqual([]); // nothing was written
    expect([a.ia, b.ia]).toEqual(["15.15.255", "1.1.9"]); // both untouched
    // Proof the refusal is what protects us: the raw service really does hit both.
    await writeIndividualAddress(bus, NEW_IA);
    expect([a.ia, b.ia]).toEqual([NEW_IA, NEW_IA]);
  });

  test("REFUSES an address another device already answers on", async () => {
    const bus = new SimBus([new SimDevice("15.15.255", true), new SimDevice(NEW_IA, false)]);
    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("IA_ALREADY_IN_USE");
    expect(bus.broadcastWrites).toEqual([]);
  });

  test("REFUSES an address whose device closes the connection instead of answering: it is there", async () => {
    const bus = new SimBus([new SimDevice("15.15.255", true), new SimDevice(NEW_IA, false, true, 0, true)]);
    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);
    expect((err as KnxError).code).toBe("IA_ALREADY_IN_USE");
    expect(bus.broadcastWrites).toEqual([]);
  });

  test("re-assigning a device its OWN current address is not a collision with itself", async () => {
    const dev = new SimDevice(NEW_IA, true); // already at the target, in programming mode
    const bus = new SimBus([dev]);
    const res = await assignIndividualAddress(bus, NEW_IA, fast);
    expect(res.previous).toBe(NEW_IA);
    expect(res.verified).toBe(true);
  }, 20_000);

  test("an incumbent the pre-check missed cannot make a failed write look verified", async () => {
    // The false green this check exists for. An incumbent sits on the target address but is
    // silent while we ask (busy, rebooting, a burst of line noise), so the pre-check reads the
    // address as free. Then the device we wrote to ignores the write and stays where it was.
    // "Does anything answer at the target?" would say yes (the incumbent!) and report success.
    // Asking WHO is in programming mode catches it: that is still OUR device, and it still
    // reports its old address.
    const stubborn = new SimDevice("15.15.255", true, false);  // in prog mode, ignores the write
    const incumbent = new SimDevice(NEW_IA, false, true, 4);   // on the target, deaf for the whole pre-check (T_Connect + 3 descriptor retries)
    const bus = new SimBus([stubborn, incumbent]);

    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);

    expect(incumbent.deafFor).toBe(0);                      // the pre-check DID miss it...
    expect(bus.broadcastWrites).toEqual([NEW_IA]);          // ...so the write went out
    expect(err).toBeInstanceOf(KnxError);                   // but the result is not passed off as success
    expect((err as KnxError).code).toBe("IA_WRITE_UNVERIFIED");
    expect((err as KnxError).message).toContain("15.15.255"); // and it says where the device still is
    expect(stubborn.ia).toBe("15.15.255");
  }, 20_000);

  test("a bus failure is not read as 'the address is free'", async () => {
    // A dead transport must not become a green light to write: silence on a working bus means the
    // address is free, but a broken bus means we learned nothing at all.
    const bus = new SimBus([new SimDevice("15.15.255", true)]);
    const realSend = bus.sendCemi.bind(bus);
    let probed = false;
    bus.sendCemi = async (cemi: Buffer) => {
      const { isGroup } = parseCemiLData(cemi);
      if (isGroup) { probed = true; return realSend(cemi); }   // the prog-mode probe still works
      throw new Error("tunnel is gone");                        // but management does not
    };

    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);

    expect(probed).toBe(true);                        // it got as far as the free-address check
    expect((err as Error).message).toBe("tunnel is gone"); // and surfaced the failure
    expect(bus.broadcastWrites).toEqual([]);          // rather than writing on a bus it cannot see
  }, 20_000);

  test("a write the device did not take is reported, not passed off as success", async () => {
    // The device answers the probe but ignores the address write (it stays where it was).
    const stubborn = new SimDevice("15.15.255", true, false);
    const bus = new SimBus([stubborn]);

    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);

    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("IA_WRITE_UNVERIFIED");
    expect(stubborn.ia).toBe("15.15.255"); // and it is honest about where the device still is
  }, 20_000); // two silent-address probes: the pre-check and the post-write verify
});
