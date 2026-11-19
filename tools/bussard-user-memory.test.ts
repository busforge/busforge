import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { KnxDevice, APCI, apdu, iaToNum, parseApdu, tpAck, type KnxTransport } from "../packages/knx/src/index.ts";
import { bussardCapture, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { memoryImage, parseCapture, parseTunnelFrame } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";

// bussard's ETS 6.4.1 downloads (MIT, Tom Bocklisch; the corpus's captures/external/bussard-synthetic/README.md) of
// one 8448-octet parameter segment that the simulator at 1.1.1 places at 0x10000, once from an application without
// SupportsExtendedMemoryServices (syn-user-memory) and once with it (syn-user-memory-extmem). They show what ETS sends
// and what the simulator answered, never how a device answers.

const DEVICE = iaToNum("1.1.1");
const SEGMENT = 0x10000, SEGMENT_SIZE = 8448;

// The device-addressed data frames of a capture in order: ETS's requests and the device's answers, the TPDU
// without its sequence number (the TPCI octet keeps only the APCI's top bits).
type Frame = { from: "ets" | "device"; apci: number; apdu: Buffer };
function frames(product: string): Frame[] {
  const log = pcapToLog(readFileSync(corpusPath(bussardCapture(product, "defaults"))));
  return log.split("\n").flatMap((line): Frame[] => {
    const from = line.includes(" ETS->BRIDGE TUNNELLING_REQ ") ? "ets" : line.includes(" BRIDGE->ETS TUNNELLING_REQ ") ? "device" : null;
    if (!from) return [];
    const fr = parseTunnelFrame(line.slice(line.lastIndexOf("| ") + 2));
    if (!fr || fr.group || fr.tpdu.length < 2 || (fr.tpdu[0] & 0x80) !== 0) return [];
    if (from === "ets" ? fr.code !== 0x11 || fr.dst !== DEVICE : fr.code !== 0x29 || fr.src !== DEVICE) return [];
    const p = parseApdu(fr.tpdu);
    return [{ from, apci: p.apci, apdu: Buffer.concat([Buffer.from([fr.tpdu[0] & 0x03]), fr.tpdu.subarray(1)]) }];
  });
}
const isMemoryWrite = (f: Frame) => (f.apci & 0x3c0) === APCI.MEMORY_WRITE || f.apci === APCI.MEMORY_EXT_WRITE || f.apci === APCI.USER_MEMORY_WRITE;
const isDeviceControlRead = (f: Frame) => f.from === "ets" && f.apci === APCI.PROPERTY_READ && f.apdu[2] === 0 && f.apdu[3] === 14;

// A device declaring the simulator's maximum APDU (PID 56 = 66) behind an interface that announces none (the
// simulator's SEARCH_RESPONSE_EXTENDED carries no extended device information), answering every A_UserMemory_Write
// with its octets as the simulator does.
class SimulatedDevice implements KnxTransport {
  assignedIa = 0x11fe;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  sent: Buffer[] = [];
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    const p = parseApdu(tpdu);
    if (p.control) return;
    this.sent.push(Buffer.concat([Buffer.from([tpdu[0] & 0x03]), tpdu.subarray(1)]));
    this.onCemi?.(DEVICE, this.assignedIa, tpAck(p.seq), false);
    if (p.apci === APCI.PROPERTY_READ && p.data[0] === 0 && p.data[1] === 56) {
      this.onCemi?.(DEVICE, this.assignedIa, apdu(p.seq, APCI.PROPERTY_RESPONSE, Buffer.from([0, 56, 0x10, 0x01, 0x00, 0x42])), false);
    } else if (p.apci === APCI.USER_MEMORY_WRITE) {
      this.onCemi?.(DEVICE, this.assignedIa, apdu(p.seq, APCI.USER_MEMORY_RESPONSE, Buffer.from(p.data)), false);
    } else throw new Error(`the simulated device takes no service 0x${p.apci.toString(16)}`);
  }
}

corpusDescribe("bussard's synthetic captures: memory past 0xFFFF without the extended memory services", () => {
  const all = frames("syn-user-memory");

  test("ETS writes the segment with A_UserMemory_Write, 15 octets per request, each answered by its echo, and the tables below 0xFFFF classic", () => {
    const writes = all.filter((f) => f.from === "ets" && isMemoryWrite(f));
    const user = writes.filter((f) => f.apci === APCI.USER_MEMORY_WRITE);
    expect(user.length).toBe(564);
    expect(user.map((f) => f.apdu[2] & 0x0f)).toEqual([...Array(563).fill(15), 3]);
    expect(writes.filter((f) => f.apci !== APCI.USER_MEMORY_WRITE).map((f) => [f.apci & 0x3c0, f.apdu.readUInt16BE(2)])).toEqual([[APCI.MEMORY_WRITE, 0x8000], [APCI.MEMORY_WRITE, 0xc000], [APCI.MEMORY_WRITE, 0xa000]]);
    // Each request's next device frame is its A_UserMemory_Response, with the same octets after the APCI.
    for (const w of user) {
      const answer = all.slice(all.indexOf(w) + 1).find((f) => f.from === "device");
      expect(answer?.apci).toBe(APCI.USER_MEMORY_RESPONSE);
      expect(answer!.apdu.subarray(2).equals(w.apdu.subarray(2))).toBe(true);
    }
    // ETS reads the device-control property (verify mode) only after these writes, before the first classic one.
    const firstUser = all.indexOf(user[0]), pid14 = all.findIndex(isDeviceControlRead);
    expect(pid14).toBeGreaterThan(firstUser);
    expect(pid14).toBeLessThan(all.findIndex((f) => (f.apci & 0x3c0) === APCI.MEMORY_WRITE));
  });

  test("the capture reader takes the A_UserMemory writes, and Busforge's write of that segment sends ETS's requests", async () => {
    const cap = parseCapture(pcapToLog(readFileSync(corpusPath(bussardCapture("syn-user-memory", "defaults")))), DEVICE);
    const mem = memoryImage(cap.writes.filter((w) => w.service === "A_UserMemory_Write"));
    expect(Math.min(...mem.keys())).toBe(SEGMENT);
    expect(mem.size).toBe(SEGMENT_SIZE);
    const segment = Buffer.from(Array.from({ length: SEGMENT_SIZE }, (_, i) => mem.get(SEGMENT + i)!));

    const sim = new SimulatedDevice();
    const dev = new KnxDevice(sim, "1.1.1");
    dev.setExtendedMemoryServices(false);
    // The System B full download's write of an echo-checked segment (packages/knx/src/flash.ts).
    await dev.memWrite(SEGMENT, segment, { verify: false, echo: true });
    const ours = sim.sent.filter((b) => parseApdu(Buffer.concat([Buffer.from([0x40 | b[0]]), b.subarray(1)])).apci === APCI.USER_MEMORY_WRITE);
    const ets = all.filter((f) => f.from === "ets" && f.apci === APCI.USER_MEMORY_WRITE).map((f) => f.apdu);
    expect(ours.map((b) => b.toString("hex"))).toEqual(ets.map((b) => b.toString("hex")));
  });
});

corpusDescribe("bussard's synthetic captures: memory with the extended memory services", () => {
  test("ETS writes every memory with A_MemoryExtended_Write, the tables below 0xFFFF too, and reads no device-control property", () => {
    const all = frames("syn-user-memory-extmem");
    const writes = all.filter((f) => f.from === "ets" && isMemoryWrite(f));
    expect(writes.length).toBe(142);
    expect(writes.every((f) => f.apci === APCI.MEMORY_EXT_WRITE)).toBe(true);
    expect(writes.filter((f) => f.apdu.readUIntBE(3, 3) < 0x10000).map((f) => f.apdu.readUIntBE(3, 3))).toEqual([0x8000, 0xc000, 0xa000]);
    expect(all.some(isDeviceControlRead)).toBe(false);
  });
});
