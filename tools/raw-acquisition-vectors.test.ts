import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  APCI, CEMI, SVC, iaToNum, parseApdu, parseCemiLData,
  decodeDeviceDescriptorResponse, decodePropertyValueResponse, decodeAuthorizeResponse, decodePropertyDescription,
  decodeFunctionPropertyExtState, decodeMemoryRead, decodeMemoryResponse, encodeAuthorizeFreeKey, encodePropertyDescriptionRead,
} from "../packages/knx/src/index.ts";
import { parseAppConfig } from "../packages/product/src/index.ts";

// The reference vectors of docs/raw-acquisition.md point at lines of the ETS captures. This test
// keeps them honest: every vector must decode, from the captured frame itself, to what the fixture
// and the design doc claim. The decoders below are deliberately local and independent; the collector's
// own codec (packages/knx/src/rawcodec.ts) has to decode every vector to the same result.

const FIXTURES = join(import.meta.dir, "fixtures");
const { vectors } = JSON.parse(readFileSync(join(FIXTURES, "raw-acquisition-vectors.json"), "utf8")) as {
  vectors: { id: string; file: string; line: number; device: string; service: string; decoded: Record<string, unknown> }[];
};

// Literal on purpose: the APCI table is checked against them below, not used to derive them.
const PROPERTY_DESCRIPTION_READ = 0x3d8;
const PROPERTY_DESCRIPTION_RESPONSE = 0x3d9;
const AUTHORIZE_REQUEST = 0x3d1;
const AUTHORIZE_RESPONSE = 0x3d2;

// The collector's codec for each service, in the fixture's terms.
function codec(service: string, tpdu: Buffer, apci: number, data: Buffer): Record<string, unknown> {
  const h = (b: Buffer) => b.toString("hex");
  switch (service) {
    case "DeviceDescriptor_Response": return decodeDeviceDescriptorResponse(apci, data);
    case "PropertyValue_Response": { const v = decodePropertyValueResponse(data); return { ...v, value: h(v.value) }; }
    case "Authorize_Request": expect(data.equals(encodeAuthorizeFreeKey())).toBe(true); return { key: h(data.subarray(1)) };
    case "Authorize_Response": return decodeAuthorizeResponse(data);
    case "PropertyDescription_Read": expect(data.equals(encodePropertyDescriptionRead(data[0], data[1], data[2]))).toBe(true); return { objectIndex: data[0], pid: data[1], propertyIndex: data[2] };
    case "PropertyDescription_Response": { const { objectIndex, pid, propertyIndex, writable, pdt, maxElements, readLevel, writeLevel } = decodePropertyDescription(data); return { objectIndex, pid, propertyIndex, writable, pdt, maxElements, readLevel, writeLevel }; }
    case "FunctionPropertyExtStateResponse": { const v = decodeFunctionPropertyExtState(data); return { ...v, value: h(v.value) }; }
    case "Memory_Read": return decodeMemoryRead(tpdu, data);
    case "Memory_Response": { const v = decodeMemoryResponse(tpdu, data); return { ...v, value: h(v.value) }; }
    default: throw new Error(`no collector codec for ${service}`);
  }
}

function apduAt(file: string, line: number) {
  const text = readFileSync(join(FIXTURES, file), "utf8").split("\n")[line - 1];
  if (!text) throw new Error(`${file}:${line} does not exist`);
  const frame = Buffer.from(text.slice(text.indexOf("| ") + 2).trim(), "hex");
  if (frame.readUInt16BE(2) !== SVC.TUNNEL_REQ) throw new Error(`${file}:${line} is not a tunnelling request`);
  const cemi = frame.subarray(10); // 6-byte KNXnet/IP header + 4-byte connection header
  const { src, dst, tpdu } = parseCemiLData(cemi);
  return { code: cemi[0], src, dst, tpdu, ...parseApdu(tpdu) };
}

const hex = (b: Buffer) => b.toString("hex");

function decode(service: string, tpdu: Buffer, apci: number, data: Buffer): Record<string, unknown> {
  switch (service) {
    case "DeviceDescriptor_Response":
      expect(apci & 0x3c0).toBe(APCI.DEVICE_DESCRIPTOR_RESPONSE);
      return { type: apci & 0x3f, mask: `MV-${hex(data).toUpperCase()}` };
    case "PropertyValue_Response": {
      expect(apci).toBe(APCI.PROPERTY_RESPONSE);
      const count = data[2] >> 4;
      const value = data.subarray(4);
      return { objectIndex: data[0], pid: data[1], count, start: ((data[2] & 0x0f) << 8) | data[3], value: hex(value) };
    }
    case "Authorize_Request":
      expect(apci).toBe(AUTHORIZE_REQUEST);
      expect(data[0]).toBe(0);
      return { key: hex(data.subarray(1, 5)) };
    case "Authorize_Response":
      expect(apci).toBe(AUTHORIZE_RESPONSE);
      return { level: data[0] };
    case "PropertyDescription_Read":
      expect(apci).toBe(PROPERTY_DESCRIPTION_READ);
      return { objectIndex: data[0], pid: data[1], propertyIndex: data[2] };
    case "PropertyDescription_Response":
      expect(apci).toBe(PROPERTY_DESCRIPTION_RESPONSE);
      expect(data.length).toBe(7);
      return {
        objectIndex: data[0], pid: data[1], propertyIndex: data[2],
        writable: (data[3] & 0x80) !== 0, pdt: data[3] & 0x3f,
        maxElements: data.readUInt16BE(4) & 0x0fff,
        readLevel: data[6] >> 4, writeLevel: data[6] & 0x0f,
      };
    case "FunctionPropertyExtStateResponse":
      expect(apci).toBe(APCI.FUNCTION_PROPERTY_EXT_STATE_RESPONSE);
      return { objectType: data.readUInt16BE(0), instance: (data[2] << 4) | (data[3] >> 4), pid: ((data[3] & 0x0f) << 8) | data[4], returnCode: data[5], value: hex(data.subarray(6)) };
    case "Memory_Read":
      expect(apci & 0x3c0).toBe(APCI.MEMORY_READ);
      return { count: tpdu[1] & 0x3f, address: data.readUInt16BE(0) };
    case "Memory_Response":
      expect(apci).toBe(APCI.MEMORY_RESPONSE);
      return { count: tpdu[1] & 0x3f, address: data.readUInt16BE(0), value: hex(data.subarray(2)) };
    default:
      throw new Error(`no decoder for ${service}`);
  }
}

describe("raw acquisition reference vectors", () => {
  test("the APCI table carries the services the collector sends", () => {
    expect([APCI.PROPERTY_DESCRIPTION_READ, APCI.PROPERTY_DESCRIPTION_RESPONSE, APCI.AUTHORIZE_REQUEST, APCI.AUTHORIZE_RESPONSE])
      .toEqual([PROPERTY_DESCRIPTION_READ, PROPERTY_DESCRIPTION_RESPONSE, AUTHORIZE_REQUEST, AUTHORIZE_RESPONSE]);
  });

  test("the fixture is not empty", () => expect(vectors.length).toBeGreaterThan(0));

  for (const v of vectors) {
    test(`${v.id} decodes from ${v.file}:${v.line}`, () => {
      const { code, src, dst, tpdu, control, apci, data } = apduAt(v.file, v.line);
      expect(control).toBe(false);
      // A request is the tool's frame to the device, a response the device's frame from the bus.
      const request = /_(Read|Request)$/.test(v.service);
      expect(code).toBe(request ? CEMI.LDATA_REQ : CEMI.LDATA_IND);
      expect(request ? dst : src).toBe(iaToNum(v.device));
      const decoded = decode(v.service, tpdu, apci, data);
      // The collector's codec agrees with the independent decoder on the captured frame.
      expect(codec(v.service, tpdu, apci, data)).toEqual(decoded);
      // A vector that names only a length carries a device identifier (a serial) not repeated in the fixture.
      const expected: Record<string, unknown> = v.decoded;
      if (expected.valueLength !== undefined) {
        const { value, ...rest } = decoded;
        const redacted: Record<string, unknown> = { ...rest, valueLength: String(value).length / 2 };
        expect(redacted).toEqual(expected);
      } else expect(decoded).toEqual(expected);
    });
  }

  // docs/raw-acquisition.md derives a table's capacity from the device's property description.
  // On both System B bench devices it equals the application's declared association table size.
  test("the described association table capacity equals the application's MaxEntries", () => {
    const apps: Record<string, string> = { "propdesc-response-jung": "M-0004_A-7072-21-99A7-O000A.xml.gz", "propdesc-response-gvs": "M-0085_A-0072-30-69AA.xml.gz" };
    for (const [id, file] of Object.entries(apps)) {
      const v = vectors.find((x) => x.id === id);
      if (!v) throw new Error(`vector ${id} is missing`);
      const xml = gunzipSync(readFileSync(join(import.meta.dir, "../packages/product/test/fixtures/real", file))).toString("utf8");
      expect(parseAppConfig(xml).groupTables.associationMaxEntries).toBe(v.decoded.maxElements as number);
    }
  });
});
