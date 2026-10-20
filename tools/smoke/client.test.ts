import { test, expect, afterEach } from "bun:test";
import { gaToNum } from "../../packages/knx/src/index.ts";
import { ApiError, Client } from "./client.ts";

const fetchWas = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchWas; });

// A server holding one project with a secure and a plain device, and group keys for `keyed` addresses.
function serve(keyed: string[]) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    asked.push(path);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/projects/p") return json({ groupRanges: [], devices: [{ id: "sec", secure: true }, { id: "plain", secure: false }] });
    const m = /^\/api\/projects\/p\/group-addresses\/(\d+)\/devices$/.exec(path);
    if (m) {
      const raw = Number(m[1]);
      if (raw === gaToNum("9/9/9")) return json({ error: { code: "GA_NOT_FOUND", message: "group address not found" } }, 404);
      return json({ secured: keyed.some((g) => gaToNum(g) === raw) });
    }
    return json({ error: { code: "NOT_FOUND", message: path } }, 404);
  }) as typeof fetch;
  return asked;
}

test("an address is secured on a Data Secure device where the project holds its key", async () => {
  serve(["1/2/1"]);
  expect(await new Client("http://x").securedOn("p", "sec", "1/2/1")).toBe(true);
});

test("an address without a key is not secured, on a Data Secure device either", async () => {
  serve(["1/2/1"]);
  expect(await new Client("http://x").securedOn("p", "sec", "1/2/2")).toBe(false);
});

test("nothing is secured on a plain device, whatever the address", async () => {
  const asked = serve(["1/2/1"]);
  expect(await new Client("http://x").securedOn("p", "plain", "1/2/1")).toBe(false);
  expect(asked).toEqual(["/api/projects/p"]);
});

test("an address the project does not hold is refused, not taken as secured or plain", async () => {
  serve([]);
  const e = await new Client("http://x").securedOn("p", "sec", "9/9/9").then(() => null, (x: unknown) => x);
  expect(e instanceof ApiError && e.code).toBe("GA_NOT_FOUND");
});
