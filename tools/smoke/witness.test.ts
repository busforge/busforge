import { describe, expect, test } from "bun:test";
import { gaToNum, iaToNum } from "../../packages/knx/src/index.ts";
import { Witness } from "./witness.ts";

const READ = Buffer.from([0x00, 0x00]);
const resp = (hex: string) => Buffer.from([0x00, 0x40, ...Buffer.from(hex, "hex")]);
const DEVICE = iaToNum("1.2.18");
const OWN = ["5/3/9", "5/3/12"];
const TEST = "15/7/250";

type Frame = { src: number; dst: string; tpdu: Buffer };

// A tunnel that delivers `before` while the witness listens ahead of its read, and `after` once the
// read went out, as the bus would.
function witnessOn(before: Frame[], after: (sentTo: number) => Frame[]) {
  const tun = {
    assignedIa: iaToNum("1.1.255"),
    onCemi: null as ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null,
    sendCemi: async (cemi: Buffer) => {
      const dst = cemi.readUInt16BE(6);
      for (const f of after(dst)) tun.onCemi?.(f.src, gaToNum(f.dst), f.tpdu, true);
    },
  };
  const w = new Witness("test-host", 0);
  Object.assign(w, { tun });
  setTimeout(() => { for (const f of before) tun.onCemi?.(f.src, gaToNum(f.dst), f.tpdu, true); }, 1);
  return w;
}

describe("the witness's read of an address added behind an object's own (findings.md §36)", () => {
  test("takes the device's answer on the object's first address to its read of the test address", async () => {
    const w = witnessOn([], (to) => (to === gaToNum(TEST) ? [{ src: DEVICE, dst: OWN[0], tpdu: resp("1708") }] : []));
    expect(await w.groupReadAnsweredOn(TEST, OWN, DEVICE, 10, 10)).toEqual({ value: "1708", unattributable: false });
  });

  test("counts no answer from another device, nor one on another of the object's addresses", async () => {
    const w = witnessOn([], () => [{ src: iaToNum("1.2.19"), dst: OWN[0], tpdu: resp("01") }, { src: DEVICE, dst: OWN[1], tpdu: resp("02") }, { src: DEVICE, dst: TEST, tpdu: resp("03") }]);
    expect(await w.groupReadAnsweredOn(TEST, OWN, DEVICE, 10, 10)).toEqual({ value: null, unattributable: false });
  });

  test("counts no write the device sends on its first address, only a response", async () => {
    const w = witnessOn([], () => [{ src: DEVICE, dst: OWN[0], tpdu: Buffer.from([0x00, 0x80, 0x17, 0x08]) }]);
    expect(await w.groupReadAnsweredOn(TEST, OWN, DEVICE, 10, 10)).toEqual({ value: null, unattributable: false });
  });

  test("leaves the answer unattributed when another client reads the test address", async () => {
    const w = witnessOn([], () => [{ src: iaToNum("1.1.254"), dst: TEST, tpdu: READ }, { src: DEVICE, dst: OWN[0], tpdu: resp("1708") }]);
    expect((await w.groupReadAnsweredOn(TEST, OWN, DEVICE, 10, 10)).unattributable).toBe(true);
  });

  test("leaves the answer unattributed when another client reads one of the object's own addresses", async () => {
    const w = witnessOn([], () => [{ src: iaToNum("1.1.254"), dst: OWN[1], tpdu: READ }, { src: DEVICE, dst: OWN[0], tpdu: resp("1708") }]);
    expect((await w.groupReadAnsweredOn(TEST, OWN, DEVICE, 10, 10)).unattributable).toBe(true);
  });

  test("leaves it unattributed when an answer on the first address comes before the read went out", async () => {
    const w = witnessOn([{ src: DEVICE, dst: OWN[0], tpdu: resp("1708") }], () => []);
    expect((await w.groupReadAnsweredOn(TEST, OWN, DEVICE, 10, 20)).unattributable).toBe(true);
  });

  test("refuses an object without an address of its own", async () => {
    const w = witnessOn([], () => []);
    const refused = await w.groupReadAnsweredOn(TEST, [], DEVICE).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(refused).toContain("no address of its own");
  });
});
