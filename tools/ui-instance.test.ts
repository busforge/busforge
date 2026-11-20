import { test, expect, setDefaultTimeout } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createState, handleApi } from "../apps/server/src/app.ts";
import { removeTempDir, tempDir } from "./test-temp.ts";
import { droppedLinksDemo } from "./ui-demo-projects.ts";
import { groupHasMembers, parseArgs } from "./ui-instance.ts";

// Timeouts measured (docs/testing.md, "Timeouts of heavy tests"): the start, import and stop of one
// instance take 0.7 s with the file alone and up to 5.3 s while a full check runs (load 33-47);
// twenty times the first is below the 60 s floor.
setDefaultTimeout(60_000);

const TOOL = join(import.meta.dir, "ui-instance.ts");

test("the command line takes one source of a project, and stop needs the port", () => {
  expect(parseArgs(["start"])).toEqual({ command: "start", project: null, passwordStdin: false, demo: null, port: null, webPort: null, stopWith: null });
  expect(parseArgs(["start", "--demo", "dropped-links", "--port", "3917", "--web-port", "5917", "--stop-with", "42"]))
    .toEqual({ command: "start", project: null, passwordStdin: false, demo: "dropped-links", port: 3917, webPort: 5917, stopWith: 42 });
  expect(parseArgs(["start", "--project", "/p/a.knxproj", "--password-stdin"])).toMatchObject({ project: "/p/a.knxproj", passwordStdin: true });
  expect(parseArgs(["status"])).toEqual({ command: "status", port: null });
  expect(parseArgs(["stop", "--port", "3917"])).toEqual({ command: "stop", port: 3917 });
  expect(parseArgs(["watch", "--owner", "42", "--dir", "/t/busforge-ui-1-x"])).toEqual({ command: "watch", owner: 42, dir: "/t/busforge-ui-1-x" });
  for (const bad of [
    [], ["run"], ["stop"], ["start", "--demo", "house"], ["start", "--demo", "openknx", "--project", "a.knxproj"],
    ["start", "--password-stdin"], ["start", "--port", "0"], ["start", "--port", "70000"], ["start", "--port", "3917", "--web-port", "3917"],
    ["start", "--stop-with", "x"], ["start", "--port"], ["start", "--port", "1", "--port", "2"], ["status", "--demo", "openknx"], ["stop", "3917"],
    ["watch", "--owner", "42"], ["watch", "--dir", "/t"], ["watch", "--owner", "0", "--dir", "/t"],
  ]) expect(() => parseArgs(bad)).toThrow(/usage/);
});

// The demos import into a fresh server with exactly the gaps they are built to show.
for (const [many, unresolvedLinks] of [[false, 7], [true, 13]] as const) {
  test(`the dropped-links demo${many ? " with many links" : ""} imports three devices and leaves ${unresolvedLinks} links out`, async () => {
    const dir = tempDir("busforge-ui-demo-");
    const state = createState({ dataDir: dir });
    try {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(droppedLinksDemo(many))], "demo.knxproj"));
      const r = (await handleApi(new Request("http://demo/api/projects/import", { method: "POST", body: form }), state))!;
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ deviceCount: 3, gaCount: 3, devicesWithoutProgram: [{ ia: "1.1.6", name: "Hall actuator" }], unresolvedLinks, linksWithoutSender: 2 });
    } finally {
      state.db.close();
      removeTempDir(dir);
    }
  });
}

// Run the tool with its instances in `tmp`, so this test sees only its own.
async function tool(tmp: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, TOOL, ...args], { env: { ...process.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

const line = (text: string, re: RegExp): RegExpExecArray => {
  const m = re.exec(text);
  if (!m) throw new Error(`no line ${re} in:\n${text}`);
  return m;
};
const instances = (tmp: string) => readdirSync(tmp).filter((n) => n.startsWith("busforge-ui-"));
const groupGone = (pid: number) => !groupHasMembers(pid);

test("an instance starts on free ports with the demo imported, answers on both, refuses a taken port, and stop leaves nothing behind", async () => {
  const tmp = tempDir("busforge-ui-instance-");
  // The watchdog stops the instance should this test process end before its own stop.
  const started = await tool(tmp, ["start", "--demo", "dropped-links", "--stop-with", String(process.pid)]);
  expect(started.err).toBe("");
  expect(started.code).toBe(0);
  const dir = line(started.out, /^instance: (.+)$/m)[1];
  const server = line(started.out, /^server: (http:\/\/127\.0\.0\.1:(\d+)) \(process group (\d+),/m);
  const web = line(started.out, /^web: (http:\/\/127\.0\.0\.1:(\d+)) \(process group (\d+),/m);
  const project = line(started.out, /^project: ([0-9a-f-]{36}) /m)[1];
  const groups = [Number(server[3]), Number(web[3]), Number(line(started.out, /watchdog process group (\d+)\)/)[1])];
  try {
    expect(started.out.match(/^device: /gm)).toHaveLength(3);
    for (const base of [server[1], web[1]]) {
      const p = await (await fetch(`${base}/api/projects/${project}`)).json();
      expect(p.devices.map((d: { ia: string }) => d.ia).sort()).toEqual(["1.1.5", "1.1.6", "1.1.7"]);
    }
    expect((await fetch(`${web[1]}/projects/${project}`)).status).toBe(200);

    const status = await tool(tmp, ["status"]);
    expect(status.out).toContain(`server: ${server[1]} (process group ${server[3]} running)`);
    expect(status.out).toContain(`project: ${project} Main`);

    for (const flag of ["--port", "--web-port"]) {
      const taken = await tool(tmp, ["start", flag, flag === "--port" ? server[2] : web[2]]);
      expect(taken.code).toBe(1);
      expect(taken.err).toMatch(/refused: port \d+ is taken/);
    }
    expect(instances(tmp)).toHaveLength(1);
  } finally {
    const stopped = await tool(tmp, ["stop", "--port", web[2]]);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`removed ${dir}`);
  }
  for (const g of groups) expect(groupGone(g)).toBe(true);
  expect(instances(tmp)).toEqual([]);
  expect((await tool(tmp, ["status"])).out.trim()).toBe("no instances");
  expect((await tool(tmp, ["stop", "--port", server[2]])).err).toContain(`no instance on port ${server[2]}`);
  removeTempDir(tmp);
});

test("a start whose owner process is already gone is refused before anything starts", async () => {
  const tmp = tempDir("busforge-ui-instance-");
  const gone = Bun.spawnSync(["true"]).pid;
  const r = await tool(tmp, ["start", "--stop-with", String(gone)]);
  expect(r.code).toBe(1);
  expect(r.err).toContain(`--stop-with ${gone}: no such process`);
  expect(instances(tmp)).toEqual([]);
  removeTempDir(tmp);
});

test("an import that fails stops the instance it started and keeps nothing", async () => {
  const tmp = tempDir("busforge-ui-instance-");
  const file = join(tmp, "broken.knxproj");
  writeFileSync(file, "not a zip");
  const r = await tool(tmp, ["start", "--project", file, "--stop-with", String(process.pid)]);
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/refused: POST \/api\/projects\/import answered 400: .*INVALID_KNXPROJ/);
  const groups = [...r.err.matchAll(/SIGTERM to process group (\d+)/g)].map((m) => Number(m[1]));
  expect(groups).toHaveLength(3);
  for (const g of groups) expect(groupGone(g)).toBe(true);
  expect(instances(tmp)).toEqual([]);
  expect(existsSync(file)).toBe(true);
  removeTempDir(tmp);
});
