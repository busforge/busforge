import type { FlashTarget } from "../views/FlashDialog.tsx";

// Which dialog clears each state mark of the device page header, or none where the device offers no
// remedy (the mark then stays a plain mark).
export type ChangeRemedy = { open: "flash"; targets: FlashTarget[] } | { open: "commission" };
export type ChangeRemedies = { never?: ChangeRemedy; changes?: ChangeRemedy; security?: ChangeRemedy };

export function changeRemedies(flashTargets: FlashTarget[], canFullDownload: boolean): ChangeRemedies {
  const flash = flashTargets.length > 0 ? { open: "flash" as const, targets: flashTargets } : undefined;
  return {
    // A never-programmed device is cleared by whatever the flash dialog offers it: the full download
    // where Busforge runs one (no programming button needed for a device already at its address), a
    // flash where the family allows it, or the reason ETS is needed. Commission, which starts from the
    // programming button, only where nothing can be flashed but a full download can be run.
    never: flash ?? (canFullDownload ? { open: "commission" } : undefined),
    changes: flash,
    // The group-address flash rewrites the security object, also where it was unknown.
    security: flashTargets.includes("ga") ? { open: "flash", targets: ["ga"] } : undefined,
  };
}
