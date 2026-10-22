import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { KnxDevice, KnxError, APCI, apdu, parseApdu, tpAck, type KnxTransport } from "@busforge/knx";
import { runFlashOp } from "../src/profiles.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 3.2 s with the
// file alone (load 5-27) and up to 3.2 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(70_000);

// A device whose restart takes the interface's tunnels down (a power supply that cuts the bus voltage,
// a router beside the interface): the link fails inside the restart's proof window. The flash then
// reconnects, opening the link again, and its read-back decides; the result names the unproven restart.
// A real KnxDevice over a scripted KNXnet/IP link: from the A_Restart on every frame fails with
// TUNNEL_CLOSED until the link is opened again.
const DEV = 0x110b; // 1.1.11
const AT = 0x4000;
const FAST: ConstructorParameters<typeof KnxDevice>[3] = { ackMs: 15, responseMs: 20, retryGapMs: 1, syncResponseMs: 30, restartAnswerMs: 20, restartProofMs: 150, droppedRepeatMs: 12_000 };

class DroppingLink implements KnxTransport {
  assignedIa = 0x1101;
  onCemi: KnxTransport["onCemi"] = null;
  onClosed: KnxTransport["onClosed"] = null;
  down = false;
  reopened = 0;
  // byte: what the unit holds at AT once it is back. restartCon: how the interface confirms the A_Restart.
  // lost: the error every frame meets once the link is down (a KNX-USB stick that is gone: USB_INTERFACE_LOST).
  constructor(private readonly unit: { byte: number; restartCon: "positive" | "negative"; lost?: string }) {}
  async connect() { this.down = false; this.reopened++; }
  async disconnect() {}
  async sendCemi(cemi: Buffer) {
    if (this.down) throw new KnxError(this.unit.lost ?? "TUNNEL_CLOSED", "scripted: the link is down");
    const tpdu = Buffer.from(cemi.subarray(9));
    if (tpdu[0] === 0x80 || tpdu[0] === 0x81) return; // T_Connect, T_Disconnect
    const p = parseApdu(tpdu);
    if (p.control) return;
    if ((p.apci & ~0x01) === APCI.RESTART) {
      this.down = true;
      if (this.unit.restartCon === "negative") throw new KnxError("BUS_SEND_FAILED", "scripted: no L2 acknowledgement");
      return;
    }
    const reply = (frame: Buffer) => this.onCemi?.(DEV, this.assignedIa, frame, false);
    reply(tpAck(p.seq));
    if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) reply(apdu(p.seq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0xb0])));
    if ((p.apci & 0x3c0) === APCI.MEMORY_READ) reply(apdu(p.seq, APCI.MEMORY_RESPONSE, Buffer.from([(AT >> 8) & 0xff, AT & 0xff, this.unit.byte]), 1));
  }
}

const flash = (link: DroppingLink) => {
  const dev = new KnxDevice(link, "1.1.11", undefined, FAST);
  return runFlashOp(dev, "07B0", { dryRun: false, persistBackups: () => "backup" }, {
    imageBytes: 1, diffBytes: 1, backup: "backup", backups: [], extendedMemory: false,
    write: async () => { await dev.restart(); },
    verify: async () => (await dev.memRead(AT, 1, 1))[0] === 0x5a,
  });
};

describe("a restart that takes the interface's tunnel down inside its proof window", () => {
  for (const restartCon of ["positive", "negative"] as const) {
    test(`A_Restart confirmed ${restartCon}ly: the link is opened again, the read-back verifies, the restart is named unproven`, async () => {
      const link = new DroppingLink({ byte: 0x5a, restartCon });
      const res = await flash(link);
      expect(res).toMatchObject({ kind: "flashed", verified: true, restartUnproven: true });
      expect(link.reopened).toBe(1);
    }, 70_000);
  }

  test("a USB interface lost in the proof cannot be opened again: the write is reported unverified at once", async () => {
    const link = new DroppingLink({ byte: 0x5a, restartCon: "positive", lost: "USB_INTERFACE_LOST" });
    const start = Date.now();
    const failure = await flash(link).then(() => null, (e: unknown) => e);
    expect(failure).toMatchObject({ code: "FLASH_UNVERIFIED_LINK_DOWN" });
    expect((failure as Error).message).toMatch(/may well have landed/);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(link.reopened).toBe(0);
  });

  test("a read-back after it that differs is reported unverified, never a pass", async () => {
    const link = new DroppingLink({ byte: 0x00, restartCon: "negative" });
    const res = await flash(link);
    expect(res).toMatchObject({ kind: "flashed", verified: false, restartUnproven: true });
  }, 70_000);
});
