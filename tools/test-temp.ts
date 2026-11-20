// Temporary directories for tests. `tempDir` creates one inside a per-process root under the system
// temp dir. A watchdog process removes that root once this process is gone, however it ended:
// a pass, a failure, a timeout, SIGTERM or SIGKILL. (`bun test` ends without running `exit` or
// `beforeExit` handlers, so an in-process hook would never fire.) A test needs no `afterAll`, and a
// directory created right before a throw cannot leak. `removeTempDir` releases one earlier.
// oxlint refuses a bare `mkdtemp`/`mkdtempSync` import in test files (.oxlintrc.json); this is the
// one place that calls it.
//
//   bun run tools/test-temp.ts watch <owner pid> <root>   (the watchdog, started by testRoot)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { processLives } from "./process-state.ts";

let root: string | null = null;

function testRoot(): string {
  if (root !== null) return root;
  // Absolute, since the watchdog runs in `/` and a relative TMPDIR would name another directory there.
  root = mkdtempSync(join(resolve(tmpdir()), `busforge-run-${process.pid}-`));
  // The watchdog is this file run by Bun; it polls every second and removes the root after the owner
  // has ended (process-state.ts: a zombie counts as ended). It is backgrounded from a shell that exits
  // at once, so it is no child of this process (Bun ends its children when a test times out) and has
  // no stdio (it never holds the run's output pipes open). It gets its own process group, so a kill
  // of the test run's group does not take it along: `setsid` where the system has it (Linux), else
  // `set -m` (macOS; dash ignores `set -m` without a terminal). It runs in `/`, so Bun loads no `.env`
  // or bunfig of the test's directory.
  const script = [
    'if command -v setsid >/dev/null 2>&1; then setsid "$@" </dev/null >/dev/null 2>&1 &',
    'else set -m; "$@" </dev/null >/dev/null 2>&1 &',
    'fi',
  ].join("\n");
  const spawned = Bun.spawnSync(["sh", "-c", script, "sh", process.execPath, import.meta.path, "watch", String(process.pid), root], { cwd: "/" });
  if (spawned.exitCode !== 0) throw new Error(`temp dir watchdog did not start: ${spawned.stderr.toString()}`);
  return root;
}

// The new directory is named `prefix` plus a random suffix.
export function tempDir(prefix: string): string {
  return mkdtempSync(join(testRoot(), prefix));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

if (import.meta.main) {
  const [command, owner, dir] = process.argv.slice(2);
  // Only a root testRoot made for that owner is removed, never another directory.
  if (command !== "watch" || !/^[1-9]\d*$/.test(owner ?? "") || !dir || dir !== resolve(dir) || !basename(dir).startsWith(`busforge-run-${owner}-`)) {
    console.error("usage: bun run tools/test-temp.ts watch <owner pid> <absolute root busforge-run-<owner pid>-*>");
    process.exit(2);
  }
  // A state that cannot be read now counts as alive and is read again.
  const lives = () => { try { return processLives(Number(owner)); } catch { return true; } };
  while (lives()) await Bun.sleep(1000);
  removeTempDir(dir);
}
