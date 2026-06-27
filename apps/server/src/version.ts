import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// Build/version info shown in the UI footer so it is always visible which build is
// installed on a given system. There is no package.json version; the source of truth is
// the git tag the release pipeline creates (vX.Y.Z), plus the commit and build time.
//
// In a deployed container the info is BAKED IN at image-build time: the Dockerfile writes
// version.json from build args (the build context excludes .git, so it cannot be read at
// runtime). In local dev there is no version.json, so we fall back to reading the working
// copy's git state and mark it as a dev build.
export interface VersionInfo {
  version: string; // git describe (e.g. "v0.5.0-3-gd5956ae") or "dev"
  commit: string; // short commit sha
  builtAt: string | null; // ISO 8601 build timestamp, or null for a dev build
}

function fromFile(): VersionInfo | null {
  // import.meta.dir = .../apps/server/src; version.json sits at the image/app root.
  const candidates = [join(import.meta.dir, "..", "..", "..", "version.json"), join(process.cwd(), "version.json")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const v = JSON.parse(readFileSync(path, "utf8")) as Partial<VersionInfo>;
      if (v.version) return { version: v.version, commit: v.commit ?? "unknown", builtAt: v.builtAt ?? null };
    } catch {
      // A malformed version.json should not take the server down; fall through to git/dev.
    }
  }
  return null;
}

function fromGit(): VersionInfo {
  const git = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, { cwd: import.meta.dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
    } catch {
      return null; // not a git checkout (or git unavailable): a plain dev build
    }
  };
  const describe = git("describe --tags --always --dirty");
  const commit = git("rev-parse --short=7 HEAD");
  return { version: describe ? `${describe} (dev)` : "dev", commit: commit ?? "unknown", builtAt: null };
}

let cached: VersionInfo | null = null;
// Resolved once and cached: the build info cannot change while the process runs.
export function versionInfo(): VersionInfo {
  return (cached ??= fromFile() ?? fromGit());
}
