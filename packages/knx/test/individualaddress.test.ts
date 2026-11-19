import { test, expect, describe, setDefaultTimeout } from "bun:test";
import type { KnxTransport } from "../src/transport.ts";
import { parseCemiLData } from "../src/transport.ts";
import { assignAddressBySerial, assignIndividualAddress, readAddressBySerial, readProgModeDevices, writeIndividualAddress } from "../src/individualaddress.ts";
import { apduUnnumbered, parseApdu, iaToNum, numToIa, APCI, BROADCAST } from "../src/frame.ts";
import { KnxError } from "../src/errors.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 5.0 s with the
// file alone (load 5-27) and up to 5.0 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(100_000);

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
  // `mask`: what A_DeviceDescriptor_Read answers. `noProperties`: a device without interface objects
  // (a BCU1), which leaves a property write unanswered. `serial`: what the serial-number services match;
  // `serialDeafFor`: ignore this many serial-number reads before answering.
  mask = "07b0";
  noProperties = false;
  serial = "";
  serialDeafFor = 0;
  constructor(public ia: string, public progMode: boolean, public takesWrite = true, public deafFor = 0, public closes = false) {}
}

class SimBus implements KnxTransport {
  readonly assignedIa = iaToNum("0.0.1");
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  broadcastWrites: string[] = [];
  progModeWrites = 0;
  restarts = 0;
  // Every frame on the line, in order: the broadcast services and the point-to-point ones by name.
  wire: string[] = [];
  // `stuckInProgMode`: the device ignores A_Restart.
  stuckInProgMode = false;

  // `negativeCon`: a frame to an address no device acknowledges comes back as a negative
  // L_Data.con (as an ABB KNX-USB stick behind a bridge does) instead of silence.
  constructor(public devices: SimDevice[], public negativeCon = false) {}
  nacks = 0;
  async connect() {}
  async disconnect() {}

  private deviceAt(n: number) { return this.devices.find((d) => iaToNum(d.ia) === n); }

  async sendCemi(cemi: Buffer): Promise<void> {
    const { dst, tpdu, isGroup } = parseCemiLData(cemi);
    const p = parseApdu(tpdu);

    if (isGroup && dst === BROADCAST) {
      this.wire.push(p.apci === APCI.INDIVIDUAL_ADDRESS_READ ? "IA_Read" : p.apci === APCI.INDIVIDUAL_ADDRESS_WRITE ? "IA_Write"
        : p.apci === APCI.IA_SERIAL_READ ? "IA_SerialRead" : p.apci === APCI.IA_SERIAL_WRITE ? "IA_SerialWrite" : "broadcast");
      const bySerial = () => this.devices.filter((d) => d.serial !== "" && Buffer.from(d.serial, "hex").equals(p.data.subarray(0, 6)));
      if (p.apci === APCI.IA_SERIAL_READ) {
        // every device holding that serial answers, from its own address, repeating the serial
        for (const d of bySerial()) if (d.serialDeafFor > 0) d.serialDeafFor--; else this.deliver(iaToNum(d.ia), BROADCAST, apduUnnumbered(APCI.IA_SERIAL_RESPONSE, Buffer.concat([p.data.subarray(0, 6), Buffer.alloc(4)])), true);
        return;
      }
      if (p.apci === APCI.IA_SERIAL_WRITE) {
        const ia = numToIa((p.data[6] << 8) | p.data[7]);
        this.broadcastWrites.push(ia);
        for (const d of bySerial().filter((x) => x.takesWrite)) d.ia = ia;
        return;
      }
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
    const t0 = tpdu[0];
    this.wire.push(`${numToIa(dst)} ${t0 === 0x80 ? "T_Connect" : t0 === 0x81 ? "T_Disconnect" : (t0 & 0xc3) === 0xc2 ? "T_ACK" : p.apci === APCI.DEVICE_DESCRIPTOR_READ ? "DescRead" : p.apci === APCI.RESTART ? "Restart" : p.apci === APCI.PROPERTY_WRITE ? "PropWrite" : "other"}`);
    const dev = this.deviceAt(dst);
    if (!dev && this.negativeCon) { this.nacks++; throw new KnxError("BUS_SEND_FAILED", "negative L_Data.con"); } // T_Connect included, as a USB interface confirms it
    if (!dev) return; // silence: the request times out, which is how a free address looks
    if (dev.deafFor > 0) { dev.deafFor--; return; } // present, but not answering right now
    const t = tpdu[0];
    if (t === 0x80) { this.deliver(dst, this.assignedIa, Buffer.from([0xc2]), false); return; } // T_Connect -> T_ACK
    if (t === 0x81) return;                                                                     // T_Disconnect
    if (dev.closes) { this.deliver(dst, this.assignedIa, Buffer.from([0x81]), false); return; }
    const seq = (t >> 2) & 0x0f;
    this.deliver(dst, this.assignedIa, Buffer.from([0xc2 | (seq << 2)]), false);                // T_ACK the request
    if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) {
      this.deliver(dst, this.assignedIa, Buffer.concat([Buffer.from([0x43 | (seq << 2), 0x40]), Buffer.from(dev.mask, "hex")]), false); // A_DeviceDescriptor_Response
    }
    if (p.apci === APCI.RESTART) { this.restarts++; if (!this.stuckInProgMode) dev.progMode = false; return; } // reboots, which ends programming mode
    if (p.apci === APCI.PROPERTY_WRITE && dev.noProperties) return; // no interface objects: no answer
    if (p.apci === APCI.PROPERTY_WRITE) {
      const [obj, pid] = [p.data[0], p.data[1]];
      if (obj === 0 && pid === 54) { this.progModeWrites++; dev.progMode = p.data[4] !== 0; }
      this.deliver(dst, this.assignedIa, Buffer.from([0x43 | (seq << 2), 0xd6, obj, pid, p.data[2], p.data[3], 0]), false); // A_PropertyValue_Response
    }
  }

  private deliver(src: number, dst: number, tpdu: Buffer, isGroup: boolean) {
    queueMicrotask(() => this.onCemi?.(src, dst, tpdu, isGroup));
  }
}

const NEW_IA = "1.2.3";
const fast = { probeMs: 20, settleMs: 5, returnMs: 0 };

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
  test("assigns to the one device in programming mode, verifies it, and ends the mode with A_Restart as ETS does", async () => {
    const virgin = new SimDevice("15.15.255", true);
    const bus = new SimBus([virgin, new SimDevice("1.1.5", false)]);

    const res = await assignIndividualAddress(bus, NEW_IA, fast);

    expect(res).toEqual({ previous: "15.15.255", assigned: NEW_IA, verified: true, progModeCleared: true, progModeError: null, route: "programming-mode" });
    expect(virgin.ia).toBe(NEW_IA);       // the device really moved
    expect(virgin.progMode).toBe(false);  // and will not answer the next assignment
    expect(bus.broadcastWrites).toEqual([NEW_IA]);
    expect(bus.restarts).toBe(1);
    expect(bus.progModeWrites).toBe(0);
    // From the write on, ETS's frames on the MDT BE-02001.02 (MV-0705; private corpus
    // internal/captures/progmode-end-2026-11-19/d1-mdt-ia-56to57.log, lines 33-71) and the ABB US/U 4.2
    // (MV-0701; d3-abb-ia-201to211.log, lines 33-71): the address write, the read that finds the device
    // there, one connection with the descriptor read, its acknowledgement, A_Restart, the close. ETS reads
    // PID_MAX_APDU_LENGTH and the serial number between the descriptor and the restart (lines 51-64), which
    // Busforge leaves out. After the close Busforge's own proof that the mode ended: the device answers at
    // its address again (a descriptor read on a connection of its own), then nobody answers the IA_Read.
    expect(bus.wire.slice(bus.wire.indexOf("IA_Write"))).toEqual([
      "IA_Write", "IA_Read", `${NEW_IA} T_Connect`, `${NEW_IA} DescRead`, `${NEW_IA} T_ACK`, `${NEW_IA} Restart`, `${NEW_IA} T_Disconnect`,
      `${NEW_IA} T_Connect`, `${NEW_IA} DescRead`, `${NEW_IA} T_ACK`, `${NEW_IA} T_Disconnect`, "IA_Read",
    ]);
  }, 100_000); // the "is the target free?" probe waits out a silent address (3 tries x 1.5 s)

  test("a device without a device object (a BCU1) gets the same frames, as ETS sends them there", async () => {
    // ETS ends programming mode of the Hager TH001 (MV-0012) with A_Restart right behind the descriptor
    // read at the new address (private corpus internal/captures/hager-th001/ets-ia-assign-proxy.log).
    const bcu1 = new SimDevice("1.1.255", true);
    bcu1.mask = "0012";
    bcu1.noProperties = true;
    const bus = new SimBus([bcu1]);

    const res = await assignIndividualAddress(bus, NEW_IA, fast);

    expect(res).toEqual({ previous: "1.1.255", assigned: NEW_IA, verified: true, progModeCleared: true, progModeError: null, route: "programming-mode" });
    expect(bus.restarts).toBe(1);
    expect(bus.progModeWrites).toBe(0);
    expect(bcu1.progMode).toBe(false);
    expect(bus.wire.slice(bus.wire.indexOf("IA_Write"))).toEqual([
      "IA_Write", "IA_Read", `${NEW_IA} T_Connect`, `${NEW_IA} DescRead`, `${NEW_IA} T_ACK`, `${NEW_IA} Restart`, `${NEW_IA} T_Disconnect`,
      `${NEW_IA} T_Connect`, `${NEW_IA} DescRead`, `${NEW_IA} T_ACK`, `${NEW_IA} T_Disconnect`, "IA_Read",
    ]);
  }, 100_000);

  test("a device still in programming mode after the restart is reported, the address stays verified", async () => {
    // A unit in Data Secure mode ignores a plain A_Restart (docs/findings.md §18).
    const dev = new SimDevice("1.1.255", true);
    const bus = new SimBus([dev]);
    bus.stuckInProgMode = true;

    const res = await assignIndividualAddress(bus, NEW_IA, fast);

    expect(res).toEqual({ previous: "1.1.255", assigned: NEW_IA, verified: true, progModeCleared: false, progModeError: "the device still answers in programming mode after the restart", route: "programming-mode" });
  }, 100_000);

  test("a device that does not come back after the restart is reported as not known to have left programming mode", async () => {
    const dev = new SimDevice("1.1.255", true);
    const bus = new SimBus([dev]);
    const orig = bus.sendCemi.bind(bus);
    bus.sendCemi = async (cemi: Buffer) => {
      const { tpdu, isGroup } = parseCemiLData(cemi);
      if (!isGroup && parseApdu(tpdu).apci === APCI.RESTART) { await orig(cemi); dev.deafFor = 1_000; return; } // reboots and stays silent
      return orig(cemi);
    };

    const res = await assignIndividualAddress(bus, NEW_IA, fast);

    expect(res).toEqual({ previous: "1.1.255", assigned: NEW_IA, verified: true, progModeCleared: false, progModeError: `the device does not answer at ${NEW_IA} after the restart, so whether it left programming mode is not known`, route: "programming-mode" });
    expect(bus.wire.filter((w) => w === "IA_Read").length).toBe(2); // the two before the restart: no probe without the device back
  }, 100_000);

  test("for a Data Secure device whose keys went unanswered, a device in programming mode with another serial is refused", async () => {
    const other = new SimDevice("1.1.30", true); other.serial = "00fa09090909";
    const target = new SimDevice("1.1.31", false); target.serial = "00fa01020304";
    const bus = new SimBus([other, target]);
    const err = await assignIndividualAddress(bus, NEW_IA, { ...fast, onlySerial: "00fa01020304" }).then(() => null, (e) => e);
    expect(err.code).toBe("PROG_MODE_NOT_THIS_DEVICE");
    expect(bus.broadcastWrites).toEqual([]);
  });

  test("a device that takes longer to come back after the restart is asked again until it answers", async () => {
    const dev = new SimDevice("1.1.255", true);
    const bus = new SimBus([dev]);
    const orig = bus.sendCemi.bind(bus);
    bus.sendCemi = async (cemi: Buffer) => {
      const { tpdu, isGroup } = parseCemiLData(cemi);
      // reboots: silent through the first check (T_Connect, three descriptor reads, T_Disconnect)
      if (!isGroup && parseApdu(tpdu).apci === APCI.RESTART) { await orig(cemi); dev.deafFor = 5; return; }
      return orig(cemi);
    };

    const res = await assignIndividualAddress(bus, NEW_IA, { ...fast, returnMs: 60_000 });

    expect(res).toMatchObject({ verified: true, progModeCleared: true, progModeError: null });
    expect(bus.wire.filter((w) => w === "IA_Read").length).toBe(3);
  }, 100_000);

  test("a device that closes the connection instead of handing out its descriptor gets the restart on a new one", async () => {
    // After the write the device answers every numbered request with T_Disconnect until programming mode
    // is to end, so the reachability check gets no descriptor and keeps no connection for the restart.
    const dev = new SimDevice("1.1.255", true);
    const bus = new SimBus([dev]);
    const orig = bus.sendCemi.bind(bus);
    let written = false;
    let ending = false;
    let endingAt = -1;
    bus.sendCemi = async (cemi: Buffer) => {
      const { tpdu, isGroup } = parseCemiLData(cemi);
      if (isGroup && parseApdu(tpdu).apci === APCI.INDIVIDUAL_ADDRESS_WRITE) written = true;
      dev.closes = written && !ending;
      return orig(cemi);
    };

    const res = await assignIndividualAddress(bus, NEW_IA, { ...fast, onProgress: (p) => { if (p === "prog-mode-off") { ending = true; endingAt = bus.wire.length; } } });

    expect(res).toEqual({ previous: "1.1.255", assigned: NEW_IA, verified: true, progModeCleared: true, progModeError: null, route: "programming-mode" });
    expect(bus.restarts).toBe(1);
    expect(bus.progModeWrites).toBe(0);
    // The restart went out on a connection opened after the reachability check had none to hand over.
    expect(bus.wire.slice(endingAt, endingAt + 2)).toEqual([`${NEW_IA} T_Connect`, `${NEW_IA} Restart`]);
  }, 100_000);

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

  test("an interface that confirms a frame to an empty address negatively still finds it free", async () => {
    const bus = new SimBus([new SimDevice("15.15.255", true)], true);
    const r = await assignIndividualAddress(bus, NEW_IA, fast);
    expect(r.verified).toBe(true);
    expect(bus.broadcastWrites).toEqual([NEW_IA]);
    expect(bus.nacks).toBeGreaterThanOrEqual(3); // free only after every attempt went unacknowledged
  });

  test("re-assigning a device its OWN current address is not a collision with itself", async () => {
    const dev = new SimDevice(NEW_IA, true); // already at the target, in programming mode
    const bus = new SimBus([dev]);
    const res = await assignIndividualAddress(bus, NEW_IA, fast);
    expect(res.previous).toBe(NEW_IA);
    expect(res.verified).toBe(true);
  }, 60_000);

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
  }, 100_000);

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
  }, 60_000);

  test("a write the device did not take is reported, not passed off as success", async () => {
    // The device answers the probe but ignores the address write (it stays where it was).
    const stubborn = new SimDevice("15.15.255", true, false);
    const bus = new SimBus([stubborn]);

    const err = await assignIndividualAddress(bus, NEW_IA, fast).then(() => null, (e) => e);

    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("IA_WRITE_UNVERIFIED");
    expect(stubborn.ia).toBe("15.15.255"); // and it is honest about where the device still is
  }, 100_000); // two silent-address probes: the pre-check and the post-write verify
});

describe("assigning an individual address by serial number", () => {
  const withSerial = (ia: string, serial: string) => Object.assign(new SimDevice(ia, false), { serial });

  test("assigns to the device with that serial, and proves it by that serial", async () => {
    const unit = withSerial("15.15.255", "00fa01020304");
    const bus = new SimBus([unit, withSerial("15.15.255", "00fa01020305")]);

    const res = await assignAddressBySerial(bus, "00FA01020304", NEW_IA, fast);

    expect(res).toEqual({ previous: "15.15.255", assigned: NEW_IA, verified: true, progModeCleared: true, progModeError: null, route: "serial" });
    expect(unit.ia).toBe(NEW_IA);
    expect(bus.devices[1].ia).toBe("15.15.255");
  }, 100_000); // one silent-address probe: the free-address check

  for (const serial of ["000000000000", "FFFFFFFFFFFF", "00:00:00:00:00:00", "ff-ff-ff-ff-ff-ff"]) {
    test(`refuses the unset serial ${serial} before anything reaches the bus`, async () => {
      const bus = new SimBus([withSerial("15.15.255", "000000000000"), withSerial("15.15.255", "ffffffffffff")]);

      const err = await assignAddressBySerial(bus, serial, NEW_IA, fast).then(() => null, (e) => e);

      expect((err as KnxError).code).toBe("SERIAL_NOT_UNIQUE");
      expect(bus.wire).toEqual([]);
      expect(bus.devices.map((d) => d.ia)).toEqual(["15.15.255", "15.15.255"]);
    });
  }

  test("refuses a serial two devices answer for, naming both, and writes nothing", async () => {
    const bus = new SimBus([withSerial("1.1.7", "00fa01020304"), withSerial("15.15.255", "00fa01020304")]);

    const err = await assignAddressBySerial(bus, "00fa01020304", NEW_IA, fast).then(() => null, (e) => e);

    expect((err as KnxError).code).toBe("SERIAL_NOT_UNIQUE");
    expect((err as KnxError).message).toContain("1.1.7, 15.15.255");
    expect(bus.wire).toEqual(["IA_SerialRead"]);
    expect(bus.broadcastWrites).toEqual([]);
  });

  test("a second unit with the serial that shows itself only after the write leaves the write unverified", async () => {
    // It misses the probe and the write, then answers the verify read from where it is: behind the new
    // address, so only the check for a second responder, not the check of the first one, refuses.
    const late = Object.assign(withSerial("1.5.0", "00fa01020304"), { serialDeafFor: 1, takesWrite: false });
    const bus = new SimBus([withSerial("15.15.255", "00fa01020304"), late]);

    const err = await assignAddressBySerial(bus, "00fa01020304", NEW_IA, fast).then(() => null, (e) => e);

    expect((err as KnxError).code).toBe("IA_WRITE_UNVERIFIED");
    expect((err as KnxError).message).toContain(`devices on ${NEW_IA}, 1.5.0 now all answer for the serial`);
  }, 100_000); // one silent-address probe: the free-address check

  for (const serial of ["00FA0102030", "00FA010203045", "0x00FA01020304", "00FA0102030G"]) {
    test(`refuses ${serial} as no 6-byte serial number, before anything reaches the bus`, async () => {
      const bus = new SimBus([withSerial("15.15.255", "00fa01020304")]);

      const err = await assignAddressBySerial(bus, serial, NEW_IA, fast).then(() => null, (e) => e);

      expect((err as KnxError).code).toBe("SERIAL_INVALID");
      expect(bus.wire).toEqual([]);
    });
  }

  test("a read of a serial nobody holds is an empty answer, not an error", async () => {
    expect(await readAddressBySerial(new SimBus([withSerial("1.1.7", "00fa01020304")]), "00fa09090909", 20)).toBeNull();
  });
});
