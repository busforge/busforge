import { afterEach, expect, test } from "bun:test";
import { ApiError, Client } from "./client.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Range { id: number; rangeStart: number; children: Range[]; addresses: { raw: number }[] }

// A project server holding only its group-address range tree.
function fakeProject() {
  const ranges: Range[] = [];
  const requests: string[] = [];
  let nextId = 1;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname, method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : {};
    requests.push(`${method} ${path}`);
    if (method === "POST" && path.endsWith("/group-ranges")) {
      const parent = body.parentId === null ? undefined : ranges.find((r) => r.id === body.parentId);
      const range: Range = { id: nextId++, rangeStart: parent ? parent.rangeStart | (body.number << 8) : body.number << 11, children: [], addresses: [] };
      (parent ? parent.children : ranges).push(range);
    } else if (method === "POST" && path.endsWith("/group-addresses")) {
      const mid = ranges.flatMap((r) => r.children).find((r) => r.id === body.rangeId)!;
      mid.addresses.push({ raw: mid.rangeStart | body.sub });
    }
    return new Response(JSON.stringify({ groupRanges: ranges }), { status: 200 });
  }) as typeof fetch;
  return { ranges, requests };
}

test("ensureGa refuses an address outside the three-level ranges before any request", async () => {
  const { requests } = fakeProject();
  const client = new Client("http://project.invalid");
  for (const bad of ["40/9/300", "32/0/0", "0/8/0", "0/0/256", "1/2", "a/b/c", ""]) {
    const err = await client.ensureGa("p", bad).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("GA_BAD");
  }
  expect(requests).toEqual([]);
});

test("the other client calls that take a group address refuse one outside the ranges too", async () => {
  const { requests } = fakeProject();
  const client = new Client("http://project.invalid");
  const refusals = [
    client.hasGa("p", "40/9/300"),
    Promise.resolve().then(() => client.link("p", "d", "O-1", "40/9/300")),
    Promise.resolve().then(() => client.setGaSecurity("p", "40/9/300", "off")),
  ];
  for (const r of refusals) expect(((await r.then(() => null, (e: unknown) => e)) as ApiError).code).toBe("GA_BAD");
  expect(requests).toEqual([]);
});

test("ensureGa creates the main range, the middle range and the address a valid address names, once", async () => {
  const { ranges } = fakeProject();
  const client = new Client("http://project.invalid");
  for (const ga of ["31/7/255", "1/2/3", "1/2/3", "1/2/4"]) await client.ensureGa("p", ga);
  const mains = ranges.map((r) => ({ start: r.rangeStart, mids: r.children.map((m) => ({ start: m.rangeStart, raws: m.addresses.map((a) => a.raw) })) }));
  expect(mains).toEqual([
    { start: 31 << 11, mids: [{ start: (31 << 11) | (7 << 8), raws: [0xffff] }] },
    { start: 1 << 11, mids: [{ start: (1 << 11) | (2 << 8), raws: [(1 << 11) | (2 << 8) | 3, (1 << 11) | (2 << 8) | 4] }] },
  ]);
});
