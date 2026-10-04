import { APCI } from "./frame.ts";
import { KnxError } from "./errors.ts";

// Encoders and decoders of the read-only management services raw acquisition uses
// (docs/raw-acquisition.md). Each decoder takes the APDU data after the two APCI octets, as
// parseApdu returns it, and refuses a payload of the wrong shape rather than reading past it.
// tools/raw-acquisition-vectors.test.ts runs them against the ETS captures.

// The free key of A_Authorize: the access level a tool without keys gets. No other key is ever
// encoded here; a request with a real key would be a credential on the wire.
export const FREE_KEY = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export function encodeAuthorizeFreeKey(): Buffer {
  return Buffer.concat([Buffer.from([0x00]), FREE_KEY]);
}

export function decodeAuthorizeResponse(data: Buffer): { level: number } {
  if (data.length !== 1) throw new KnxError("AUTHORIZE_RESPONSE_INVALID", `an authorize response carries one octet, not ${data.length}`);
  return { level: data[0] };
}

export function encodePropertyDescriptionRead(objectIndex: number, pid: number, propertyIndex: number): Buffer {
  for (const [v, what] of [[objectIndex, "object index"], [pid, "PID"], [propertyIndex, "property index"]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new KnxError("PROPERTY_ADDRESS_INVALID", `${what} ${v} does not fit one octet`);
  }
  return Buffer.from([objectIndex, pid, propertyIndex]);
}

// A property description. `pid` 0 is the device saying there is no property (or no object) at the
// asked index; the other fields then carry nothing.
export interface PropertyDescription {
  objectIndex: number; pid: number; propertyIndex: number;
  writable: boolean; pdt: number; maxElements: number; readLevel: number; writeLevel: number;
}
export function decodePropertyDescription(data: Buffer): PropertyDescription {
  if (data.length !== 7) throw new KnxError("PROPERTY_DESCRIPTION_INVALID", `a property description carries 7 octets, not ${data.length}`);
  return {
    objectIndex: data[0], pid: data[1], propertyIndex: data[2],
    writable: (data[3] & 0x80) !== 0, pdt: data[3] & 0x3f,
    maxElements: data.readUInt16BE(4) & 0x0fff,
    readLevel: data[6] >> 4, writeLevel: data[6] & 0x0f,
  };
}

// A_PropertyValue_Response: object index, PID, element count (4 bits), start index (12 bits), then
// the value. A count of 0 is the device answering that it has no such property or refuses the read;
// whatever follows it then is its error octet, never a value.
export interface PropertyValueResponse { objectIndex: number; pid: number; count: number; start: number; value: Buffer }
export function decodePropertyValueResponse(data: Buffer): PropertyValueResponse {
  if (data.length < 4) throw new KnxError("PROPERTY_RESPONSE_INVALID", `a property response carries at least 4 octets, not ${data.length}`);
  return { objectIndex: data[0], pid: data[1], count: data[2] >> 4, start: ((data[2] & 0x0f) << 8) | data[3], value: data.subarray(4) };
}

export function decodeDeviceDescriptorResponse(apci: number, data: Buffer): { type: number; mask: string } {
  if ((apci & 0x3c0) !== APCI.DEVICE_DESCRIPTOR_RESPONSE) throw new KnxError("DESCRIPTOR_RESPONSE_INVALID", `service 0x${apci.toString(16)} is not a device descriptor response`);
  const type = apci & 0x3f;
  if (type !== 0 || data.length !== 2) throw new KnxError("DESCRIPTOR_RESPONSE_INVALID", `descriptor type ${type} with ${data.length} octets is not a type 0 descriptor`);
  return { type, mask: `MV-${data.toString("hex").toUpperCase()}` };
}

// A_Memory_Read/Response fold the byte count into the low six APCI bits; parseApdu folds them away,
// so the count is taken from the TPDU's second octet.
export function decodeMemoryRead(tpdu: Buffer, data: Buffer): { count: number; address: number } {
  if (data.length !== 2) throw new KnxError("MEMORY_REQUEST_INVALID", `a memory read carries a 2-octet address, not ${data.length} octets`);
  return { count: tpdu[1] & 0x3f, address: data.readUInt16BE(0) };
}
export function decodeMemoryResponse(tpdu: Buffer, data: Buffer): { count: number; address: number; value: Buffer } {
  if (data.length < 2) throw new KnxError("MEMORY_RESPONSE_INVALID", `a memory response carries at least its 2-octet address, not ${data.length} octets`);
  return { count: tpdu[1] & 0x3f, address: data.readUInt16BE(0), value: data.subarray(2) };
}

// A_FunctionPropertyExt_StateResponse: object type, instance (12 bits), PID (12 bits), return code,
// result.
export function decodeFunctionPropertyExtState(data: Buffer): { objectType: number; instance: number; pid: number; returnCode: number; value: Buffer } {
  if (data.length < 6) throw new KnxError("PROPERTY_RESPONSE_INVALID", `a function property state response carries at least 6 octets, not ${data.length}`);
  return { objectType: data.readUInt16BE(0), instance: (data[2] << 4) | (data[3] >> 4), pid: ((data[3] & 0x0f) << 8) | data[4], returnCode: data[5], value: data.subarray(6) };
}
