import type { AppState } from "./app.ts";

// A signal must not cut a write short: a download interrupted mid-bracket can leave the device
// reset. A repeated signal does not skip the wait either. Only SIGKILL (Docker sends it when the
// stop grace period runs out) ends the process mid-write, and the next start reports that write
// as interrupted.
export function installShutdown(state: Pick<AppState, "queue" | "bus" | "db">, say: (why: string, e?: unknown) => void): void {
  let stopping = false;
  const describeActiveWrites = () => state.queue.activeWrites().map((t) => `${t.kind} of ${t.ia} (${t.deviceName}, task ${t.id})`).join(", ");
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (stopping) {
        const w = describeActiveWrites();
        say(`received ${sig} again, ${w ? `still finishing ${w}; SIGKILL stops it now and leaves that device's state unknown` : "already exiting"}`);
        return;
      }
      stopping = true;
      const w = describeActiveWrites();
      say(`received ${sig}, ${w ? `finishing ${w} before exiting` : "exiting"}`);
      Promise.resolve().then(() => state.queue.shutdown())
        .then(() => state.bus.close())
        .then(() => { state.db.close(); process.exit(0); })
        .catch((e) => { say("shutdown cleanup failed", e); process.exit(1); });
    });
  }
}
