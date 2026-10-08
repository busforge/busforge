// The dry-run previews a dialog runs while it is open. The server does not stop a dry-run whose
// request the client gives up on: every request sent occupies the serial bus to its end, so a second
// run of the same preview delays everything queued behind it (a download preview, a write).
//
// React runs an effect's cleanup and then its setup again with unchanged dependencies (StrictMode on
// mount). That pair must not send the previews a second time: the setup takes over the run its
// cleanup paused. Any other cleanup (a dependency change) and pause() on unmount leave the run stopped:
// it sends no further request, and a result it was still waiting for is dropped.

export type IsLive = () => boolean;
type Body = (live: IsLive) => Promise<void>;
interface Run { key: string; live: boolean; state: "running" | "done" | "stopped" }

export interface PreviewRuns {
  // Effect setup while a preview is wanted: start one for `key` unless one for `key` is running or done.
  ensure(key: string, body: Body): void;
  // Start a new run for `key` regardless (a retry), stopping the current one.
  start(key: string, body: Body): void;
  // Effect cleanup and unmount: pause the current run (also one a retry started). The next ensure()
  // for the same key resumes it; otherwise it stays stopped.
  pause(): void;
  // Effect setup while no preview is wanted: forget the current run, so the next ensure() starts fresh.
  drop(): void;
}

export function previewRuns(): PreviewRuns {
  let current: Run | null = null;
  const start = (key: string, body: Body) => {
    if (current) current.live = false;
    const run: Run = { key, live: true, state: "running" };
    current = run;
    // A dry-run's failure settles on its target (previewEach); anything else that throws is a bug in
    // the dialog, and the targets it left checking stay so. Say so instead of hiding it.
    body(() => run.live)
      .finally(() => { run.state = run.live ? "done" : "stopped"; })
      .catch((e: unknown) => { console.error("preview run failed", e); });
  };
  return {
    ensure(key, body) {
      if (current?.key === key && current.state !== "stopped") current.live = true;
      else start(key, body);
    },
    start,
    pause() { if (current) current.live = false; },
    drop() { if (current) current.live = false; current = null; },
  };
}

// The dialog's effect: a preview while `wanted`, with the cleanup that pauses it.
export function previewEffect(runs: PreviewRuns, wanted: boolean, key: string, body: Body): (() => void) | undefined {
  if (!wanted) { runs.drop(); return undefined; }
  runs.ensure(key, body);
  return () => runs.pause();
}

// Dry-run each target in order (the bus is serial server-side). A stopped run sends no further
// request and settles nothing; a failure settles on its own target, so this never rejects.
export async function previewEach<T, R>(targets: readonly T[], dry: (t: T) => Promise<R>, settle: (t: T, r: { ok: R } | { error: unknown }) => void, live: IsLive): Promise<void> {
  for (const t of targets) {
    if (!live()) return;
    let r: { ok: R } | { error: unknown };
    try { r = { ok: await dry(t) }; } catch (error) { r = { error }; }
    if (!live()) return;
    settle(t, r);
  }
}
