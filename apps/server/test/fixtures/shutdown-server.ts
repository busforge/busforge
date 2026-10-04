// A server process for the shutdown tests: the real state, the real signal handling, and a write
// whose duration the test controls instead of a device.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createState } from "../../src/app.ts";
import { installShutdown } from "../../src/shutdown.ts";

const state = createState({ dataDir: process.env.DATA_DIR! });
if (process.env.FAIL_BUS_CLOSE) state.bus.close = async () => { throw new Error("bus close failed"); };
// A second connection holding a read snapshot from before the job's writes blocks a complete checkpoint.
const reader = process.env.HOLD_READER ? new Database(join(process.env.DATA_DIR!, "busforge.db")) : null;
if (reader) { reader.exec("BEGIN"); reader.query("SELECT count(*) FROM tasks").get(); }
installShutdown(state, (why, e) => console.error(why, e instanceof Error ? e.message : ""));
const jobMs = Number(process.env.JOB_MS ?? 0);
const meta = (deviceId: string) => ({ projectId: "p1", deviceId, deviceName: deviceId, ia: "1.1.1", kind: "download" as const, writes: true });

if (jobMs > 0) {
  const running = state.queue.submit(meta("d1"), async (progress, _signal, commit) => {
    progress("writing");
    console.log(`RUNNING ${running.id} ${queued.id}`);
    await Bun.sleep(jobMs);
    const r = { kind: "flashed", verified: true };
    commit(r, () => {});
    return r;
  });
  const queued = state.queue.submit(meta("d2"), async () => undefined);
} else {
  console.log("IDLE");
}
setInterval(() => reader, 60_000); // stands in for the HTTP server keeping the process alive, and keeps the reader from being collected
