import { Zap } from "lucide-react";
import type { DeviceChanges } from "../api.ts";

export const changeTotal = (c?: DeviceChanges) => (c ? c.params + c.links : 0);

const changeTitle = (c: DeviceChanges) =>
  [c.params && `${c.params} parameter${c.params > 1 ? "s" : ""}`, c.links && `${c.links} group address${c.links > 1 ? "es" : ""}`]
    .filter(Boolean).join(", ") + " changed since last programming";

// Amber pill flagging a device with unprogrammed edits. Renders nothing when clean.
export function ChangePill({ changes }: { changes?: DeviceChanges }) {
  const n = changeTotal(changes);
  if (!n || !changes) return null;
  return (
    <span
      title={changeTitle(changes)}
      className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary"
    >
      <Zap className="size-3" /> {n} change{n > 1 ? "s" : ""}
    </span>
  );
}
