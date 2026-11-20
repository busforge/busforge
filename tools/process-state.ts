// Process state for tools/test-temp.ts and tools/ui-instance.ts: whether a process has ended, its
// process group and its start time. Linux has /proc; macOS has `ps` and no /proc. A container without
// an init process (the CI image, whose PID 1 is `tail -f /dev/null`) reaps no orphan, so an ended
// process there stays a zombie until the container ends, and `kill -0` still succeeds on it: a zombie
// counts as ended.
import { existsSync, readFileSync } from "node:fs";

export const PROC = existsSync("/proc/self/stat");

// State, process group and start time from /proc/<pid>/stat; the fields after the command name,
// which may hold spaces, start behind its closing parenthesis.
// Null when there is no such process; a file that is there but cannot be read is refused.
function procStat(pid: number): { state: string; pgrp: number; start: string } | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return null;
    throw e;
  }
  const f = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: f[0], pgrp: Number(f[2]), start: f[19] };
}

// procStat of a process that has not ended: null for none of that id and for a zombie.
export function liveStat(pid: number): { pgrp: number; start: string } | null {
  const st = procStat(pid);
  return st === null || st.state === "Z" ? null : st;
}

export const signalZero = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

// Whether the process exists and has not ended. Without /proc a zombie is not told apart; on macOS
// launchd reaps every orphan.
export const processLives = (pid: number): boolean => (PROC ? liveStat(pid) !== null : signalZero(pid));
