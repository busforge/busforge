// Temporary directories for tests. `tempDir` creates one inside a per-process root under the system
// temp dir. A small watchdog process removes that root once this process is gone, however it ended:
// a pass, a failure, a timeout, SIGTERM or SIGKILL. (`bun test` ends without running `exit` or
// `beforeExit` handlers, so an in-process hook would never fire.) A test needs no `afterAll`, and a
// directory created right before a throw cannot leak. `removeTempDir` releases one earlier.
// oxlint refuses a bare `mkdtemp`/`mkdtempSync` import in test files (.oxlintrc.json); this is the
// one place that calls it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string | null = null;

function testRoot(): string {
  if (root !== null) return root;
  root = mkdtempSync(join(tmpdir(), `busforge-run-${process.pid}-`));
  // The watchdog polls every second and removes the root after the owner pid is gone. The inner
  // shell is backgrounded from a shell that exits at once, so the watchdog is no child of this
  // process (Bun ends its children when a test times out) and has no stdio (it never holds the
  // run's output pipes open). It gets its own process group, so a kill of the test run's group
  // does not take it along: `setsid` where the system has it (Linux), else `set -m` (macOS; dash
  // ignores `set -m` without a terminal).
  const script = [
    'w=\'while kill -0 "$1" 2>/dev/null; do sleep 1; done; rm -rf "$2"\'',
    'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$w" sh "$1" "$2" </dev/null >/dev/null 2>&1 &',
    'else set -m; sh -c "$w" sh "$1" "$2" </dev/null >/dev/null 2>&1 &',
    'fi',
  ].join("\n");
  const spawned = Bun.spawnSync(["sh", "-c", script, "sh", String(process.pid), root]);
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
