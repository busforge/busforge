import { KnxError } from "@busforge/knx";

// A mock unit's property reads as KnxDevice gives them, from the mock's answer to one element, where an
// empty answer is the device's answer of no element: propRead refuses it, propReadIfPresent returns null.
export function refusedIfEmpty(v: Buffer, obj: number, pid: number, start = 1): Buffer {
  if (v.length === 0) throw new KnxError("PROPERTY_READ_REFUSED", `object ${obj} PID ${pid} from ${start}: the device answered 0 of 1 element(s)`);
  return v;
}
export const absentIfEmpty = (v: Buffer): Buffer | null => (v.length ? v : null);
