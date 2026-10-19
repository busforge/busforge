import { test, expect, describe } from "bun:test";
import { parseCemiLData } from "../src/transport.ts";
import { cemiLData, cemiLDataGroup, iaToNum, gaToNum } from "../src/frame.ts";

// parseCemiLData is the single inbound-decode path for both the IP tunnel and
// the USB transport, so pin its byte-offset math against the cEMI builders.
describe("parseCemiLData", () => {
  test("individual-addressed L_Data round-trips", () => {
    const src = iaToNum("1.1.5");
    const dst = iaToNum("1.2.7");
    const tpdu = Buffer.from([0x42, 0x40, 0x00, 0x00]); // some numbered TPDU
    const cemi = cemiLData(src, dst, tpdu);
    const p = parseCemiLData(cemi);
    expect(p.isGroup).toBe(false);
    expect(p.src).toBe(src);
    expect(p.dst).toBe(dst);
    expect(p.tpdu.equals(tpdu)).toBe(true);
  });

  test("group-addressed L_Data sets isGroup and round-trips", () => {
    const src = iaToNum("1.1.5");
    const ga = gaToNum("1/2/3");
    const tpdu = Buffer.from([0x00, 0x81]); // GroupValueWrite, 1 bit
    const cemi = cemiLDataGroup(src, ga, tpdu);
    const p = parseCemiLData(cemi);
    expect(p.isGroup).toBe(true);
    expect(p.src).toBe(src);
    expect(p.dst).toBe(ga);
    expect(p.tpdu.equals(tpdu)).toBe(true);
  });
});
