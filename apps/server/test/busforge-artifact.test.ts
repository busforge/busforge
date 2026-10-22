import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { gunzipSync } from "node:zlib";
import { packBusforge, unpackBusforge } from "../src/db/busforgeArtifact.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 0.3 s with the
// file alone (load 5-27) and up to 0.3 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(60_000);

const sample = { busforgeExport: 1, project: { name: "Demo" }, devices: [{ id: "1.1.1" }], note: "äöü ß \u{1f600}" };

describe("busforge artifact codec", () => {
  test("plain round-trips and is a bare gzip stream openable with gunzip", async () => {
    const buf = await packBusforge(sample);
    expect(buf.readUInt16BE(0)).toBe(0x1f8b); // gzip magic -> any unzip tool / `gunzip` opens it
    expect(JSON.parse(gunzipSync(buf).toString("utf8"))).toEqual(sample);
    expect(await unpackBusforge(buf)).toEqual(sample);
  });

  test("compresses large repetitive payloads well (the reason we zip)", async () => {
    const big = { busforgeExport: 1, project: { name: "Big" }, blob: "<ApplicationProgram/>".repeat(5000) };
    const buf = await packBusforge(big);
    expect(buf.length).toBeLessThan(Buffer.byteLength(JSON.stringify(big)) / 10);
    expect(await unpackBusforge(buf)).toEqual(big);
  });

  test("encrypted round-trips with the right password and is not a gzip stream", async () => {
    const buf = await packBusforge(sample, "hunter2");
    expect(buf.subarray(0, 4).toString("ascii")).toBe("BF1E");
    expect(buf.readUInt16BE(0)).not.toBe(0x1f8b);
    expect(await unpackBusforge(buf, "hunter2")).toEqual(sample);
  });

  test("encryption is randomized: same input + password yields different bytes", async () => {
    const a = await packBusforge(sample, "pw");
    const b = await packBusforge(sample, "pw");
    expect(a.equals(b)).toBe(false); // fresh salt + iv each time
  });

  test("encrypted artifact without a password is rejected with a coded error", async () => {
    const buf = await packBusforge(sample, "pw");
    expect(unpackBusforge(buf)).rejects.toThrow(expect.objectContaining({ code: "BUSFORGE_PASSWORD_REQUIRED" }));
  });

  test("wrong password is rejected (GCM auth tag fails)", async () => {
    const buf = await packBusforge(sample, "correct");
    expect(unpackBusforge(buf, "wrong")).rejects.toThrow(expect.objectContaining({ code: "BUSFORGE_WRONG_PASSWORD" }));
  });

  test("a tampered ciphertext is rejected (authenticated encryption)", async () => {
    const buf = await packBusforge(sample, "pw");
    buf[buf.length - 1] ^= 0xff; // flip a byte of the ciphertext
    expect(unpackBusforge(buf, "pw")).rejects.toThrow(expect.objectContaining({ code: "BUSFORGE_WRONG_PASSWORD" }));
  });

  test("legacy plaintext .busforge.json is still accepted", async () => {
    const json = Buffer.from(JSON.stringify(sample), "utf8");
    expect(await unpackBusforge(json)).toEqual(sample);
  });

  test("garbage input is rejected", async () => {
    expect(unpackBusforge(Buffer.from("not a busforge file"))).rejects.toThrow(expect.objectContaining({ code: "BUSFORGE_INVALID" }));
  });
});
