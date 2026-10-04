import type { AppState } from "./app.ts";
import { closeDb } from "./db/schema.ts";

// A signal must not cut a write short: a download interrupted mid-bracket can leave the device
// reset. A repeated signal does not skip the wait either. Only SIGKILL (Docker sends it when the
// stop grace period runs out) ends the process mid-write, and the next start reports that write
// as interrupted. The database is checkpointed on every exit through here, a failed step included,
// so busforge.db holds every committed write.
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
      void (async () => {
        let code = 0;
        try {
          try { await state.queue.shutdown(); await state.bus.close(); }
          catch (e) { code = 1; say("shutdown cleanup failed", e); }
          try { closeDb(state.db); }
          catch (e) { code = 1; say("closing the database failed", e); }
        } finally {
          process.exit(code);
        }
      })();
    });
  }
}
