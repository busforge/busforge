import { test, expect, describe, afterEach, setDefaultTimeout } from "bun:test";
import net from "node:net";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSplitter, parseEndpoint, rewriteSearchEndpoint, logLine, startProxy, isSyncRequest } from "./knxproxy.ts";
import { parseCapture, memoryImage } from "./etsdiff.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 0.3 s with the
// file alone (load 5-27) and up to 0.3 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(60_000);

// A KNXnet/IP frame: header (06 10, service, total length) and body.
const frame = (svc: number, body: number[]) => Buffer.from([0x06, 0x10, svc >> 8, svc & 0xff, (6 + body.length) >> 8, (6 + body.length) & 0xff, ...body]);
// SEARCH_RESPONSE_EXTENDED whose control endpoint is UDP 192.0.2.9:3671, then a DIB.
const searchResExt = frame(0x020c, [0x08, 0x01, 192, 0, 2, 9, 0x0e, 0x57, 0x02, 0x02]);
// A tunnelled A_Memory_Write of 2 bytes to 0x4000, from the tool to 1.1.1.
const memWrite = frame(0x0420, [0x04, 0x11, 0x00, 0x00, 0x11, 0x00, 0xb0, 0x60, 0x00, 0x00, 0x11, 0x01, 0x05, 0x42, 0x82, 0x40, 0x00, 0xaa, 0xbb]);

// ETS 6's tunnelled A_SecureService frames to the Jung 400021SE: an S-A_Sync_Req (SCF 0x92) and a
// secured data request (SCF 0x90).
const syncReq = Buffer.from("06100420002c0401000011003060116411cc1803f192004053570a210000000000004a48f6d0b0b0a8863312", "hex");
const securedData = Buffer.from("061004200022040100001100b060116411cc0e03f1900040579904c6de3d6fedbccf", "hex");

describe("frames", () => {
  test("a Sync request is told from the other secured services and from plain frames", () => {
    expect([isSyncRequest(syncReq), isSyncRequest(securedData), isSyncRequest(memWrite), isSyncRequest(searchResExt)]).toEqual([true, false, false, false]);
  });

  test("the splitter frames a stream cut anywhere, and reports where it stops being KNXnet/IP", () => {
    const got: string[] = [];
    const broken: string[] = [];
    const split = makeSplitter((f) => got.push(f.toString("hex")), (r) => broken.push(r.toString("hex")));
    const stream = Buffer.concat([searchResExt, memWrite]);
    for (const piece of [stream.subarray(0, 3), stream.subarray(3, 20), stream.subarray(20)]) split(piece);
    expect(got).toEqual([searchResExt.toString("hex"), memWrite.toString("hex")]);
    split(Buffer.from([0x47, 0x45, 0x54, 0x20])); // not 06 10
    split(memWrite);
    expect(got).toHaveLength(2);
    expect(broken).toEqual(["47455420"]);
  });

  test("a header with a length below its own size breaks the stream instead of looping", () => {
    const broken: number[] = [];
    makeSplitter(() => {}, (r) => broken.push(r.length))(Buffer.from([0x06, 0x10, 0x04, 0x20, 0x00, 0x02]));
    expect(broken).toEqual([6]);
  });

  test("only a search answer's control endpoint is rewritten", () => {
    const to = parseEndpoint("192.0.2.7:3672");
    expect(rewriteSearchEndpoint(searchResExt, to).subarray(6, 14).toString("hex")).toBe("0801c00002070e58");
    expect(rewriteSearchEndpoint(searchResExt, to).subarray(14)).toEqual(searchResExt.subarray(14));
    expect(rewriteSearchEndpoint(memWrite, to)).toBe(memWrite);
    const plainSearch = frame(0x0202, [0x08, 0x01, 192, 0, 2, 9, 0x0e, 0x57]);
    expect(rewriteSearchEndpoint(plainSearch, to).subarray(8, 14).toString("hex")).toBe("c00002070e58");
  });

  test("an endpoint that is not <ipv4>:<port> is refused", () => {
    for (const bad of ["192.0.2.7", "192.0.2.256:3672", "192.0.2.7:0", "host:3672", "192.0.2.7:70000"]) expect(() => parseEndpoint(bad)).toThrow("PROXY_ADVERTISE");
  });

  test("a logged line is what etsdiff reads", () => {
    const text = [logLine("ETS->BRIDGE", memWrite), logLine("BRIDGE->ETS", searchResExt)].join("\n");
    expect(text).toContain("TUNNELLING_REQ req 0.0.0->1.1.1 MEMORY_WRITE");
    expect([...memoryImage(parseCapture(text, 0x1101).writes)]).toEqual([[0x4000, 0xaa], [0x4001, 0xbb]]);
  });
});

describe("the proxy on the wire", () => {
  const log = join(tmpdir(), `knxproxy-${crypto.randomUUID()}.log`);
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach((c) => c()); rmSync(log, { force: true }); });
  const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));

  test("passes frames both ways, logs them, and points the tool's search at itself", async () => {
    const seen: Buffer[] = [];
    const server = net.createServer((c) => c.on("data", (d: Buffer) => { seen.push(d); c.write(searchResExt); }));
    const serverPort = await listen(server);
    const proxy = startProxy({ port: 0, bridgeHost: "127.0.0.1", bridgePort: serverPort, log, tool: "ETS", advertise: parseEndpoint("192.0.2.7:3672") });
    const proxyPort = await listen(proxy);
    closers.push(() => server.close(), () => proxy.close());
    const answer = await new Promise<Buffer>((resolve) => {
      const c = net.connect(proxyPort, "127.0.0.1", () => c.write(memWrite));
      c.on("data", (d: Buffer) => { resolve(d); c.destroy(); });
    });
    expect(Buffer.concat(seen)).toEqual(memWrite);
    expect(answer).toEqual(rewriteSearchEndpoint(searchResExt, parseEndpoint("192.0.2.7:3672")));
    const lines = readFileSync(log, "utf8").split("\n");
    expect(lines.some((l) => l.includes("ETS->BRIDGE TUNNELLING_REQ") && l.endsWith(memWrite.toString("hex")))).toBe(true);
    expect(lines.some((l) => l.includes("BRIDGE->ETS SEARCH_RES_EXT") && l.endsWith(searchResExt.toString("hex")))).toBe(true);
    expect(lines.some((l) => l.includes("--- rewrote control HPAI 0801c00002090e57 -> 0801c00002070e58 ---"))).toBe(true);
  });

  test("with a Sync gap, a second Sync request is held that long after the first, and the frames behind it keep their order", async () => {
    const seen: { at: number; f: string }[] = [];
    const server = net.createServer((c) => c.on("data", makeSplitter((f) => seen.push({ at: Date.now(), f: f.toString("hex") }), () => {})));
    const serverPort = await listen(server);
    const proxy = startProxy({ port: 0, bridgeHost: "127.0.0.1", bridgePort: serverPort, log, tool: "ETS", syncGapMs: 300 });
    const proxyPort = await listen(proxy);
    closers.push(() => server.close(), () => proxy.close());
    const c = net.connect(proxyPort, "127.0.0.1", () => c.write(Buffer.concat([syncReq, securedData, syncReq, memWrite])));
    while (seen.length < 4) await Bun.sleep(20);
    c.destroy();
    expect(seen.map((x) => x.f)).toEqual([syncReq, securedData, syncReq, memWrite].map((f) => f.toString("hex")));
    expect(seen[2].at - seen[0].at).toBeGreaterThanOrEqual(290);
    expect(seen[1].at - seen[0].at).toBeLessThan(200);
    expect(readFileSync(log, "utf8")).toMatch(/--- held a Sync request \d+ ms ---/);
  });

  test("a tool that sends something else is cut, and the log says so", async () => {
    const server = net.createServer(() => {});
    const serverPort = await listen(server);
    const proxy = startProxy({ port: 0, bridgeHost: "127.0.0.1", bridgePort: serverPort, log, tool: "ETS" });
    const proxyPort = await listen(proxy);
    closers.push(() => server.close(), () => proxy.close());
    await new Promise<void>((resolve) => {
      const c = net.connect(proxyPort, "127.0.0.1", () => c.write("GET / HTTP/1.1\r\n\r\n"));
      c.on("close", () => resolve());
    });
    expect(existsSync(log) && readFileSync(log, "utf8")).toContain("ETS sent bytes that are not KNXnet/IP");
  });
});
