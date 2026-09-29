import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi } from "../src/app.ts";
import { createProject } from "../src/db/projects.ts";
import { createGroupAddress, createGroupRange } from "../src/db/groupedit.ts";
import { putGroupKeys } from "../src/db/groupKeys.ts";

// The senders a project assigns to a group address, as the group-address overlay shows and edits them.
describe("group address senders API", () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "senders-"));
    const state = createState({ dbPath: ":memory:", dataDir: dir });
    createProject(state.db, "p", "Test", 0);
    const main = createGroupRange(state.db, "p", null, "Secure", 0);
    const mid = createGroupRange(state.db, "p", main, "Jung", 0);
    createGroupAddress(state.db, "p", mid, 1, "Taste 1", "1.001");
    putGroupKeys(state.db, "p", [{ raw: 1, key: Buffer.alloc(16, 1), source: "import" }], state.masterKey);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = (await handleApi(new Request(`http://x/api/projects/p/group-addresses/1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), state))!;
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    return { state, call, close: () => { state.db.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  test("the overlay says whether the address is secured and lists its assigned senders", async () => {
    const s = await setup();
    expect((await s.call("GET", "/devices")).body).toMatchObject({ secured: true, interfaceSenders: [] });
    expect((await s.call("POST", "/senders", { ia: "1.1.100" })).status).toBe(200);
    expect((await s.call("GET", "/devices")).body).toMatchObject({ interfaceSenders: [{ ia: "1.1.100", source: "busforge" }] });
    s.close();
  });

  test("removes a sender, and says so when there was none", async () => {
    const s = await setup();
    await s.call("POST", "/senders", { ia: "1.1.100" });
    expect((await s.call("DELETE", "/senders/1.1.100")).status).toBe(200);
    expect((await s.call("DELETE", "/senders/1.1.100"))).toMatchObject({ status: 404, body: { error: { code: "SENDER_NOT_FOUND" } } });
    expect((await s.call("GET", "/devices")).body).toMatchObject({ interfaceSenders: [] });
    s.close();
  });

  test("refuses what is not an individual address, and an unknown group address", async () => {
    const s = await setup();
    expect(await s.call("POST", "/senders", { ia: "1/1/100" })).toMatchObject({ status: 400, body: { error: { code: "SENDER_INVALID" } } });
    const res = (await handleApi(new Request("http://x/api/projects/p/group-addresses/99/senders", { method: "POST", body: JSON.stringify({ ia: "1.1.1" }) }), s.state))!;
    expect(res.status).toBe(404);
    s.close();
  });
});
