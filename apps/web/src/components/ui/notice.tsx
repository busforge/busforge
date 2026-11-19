import * as React from "react"

import { cn } from "@/lib/utils"
import { infoTone, warningTone } from "@/components/ui/badge"

// A boxed note in running text (a dialog, the device page): a badge's tone as a block, so a warning
// reads the same whether it is a mark or a sentence (docs/design-system.md). `warning` by default;
// `info` for a derived state that is no warning. Layout (icon row, spacing) is the caller's.
function Notice({ className, tone = "warning", ...props }: React.ComponentProps<"div"> & { tone?: "warning" | "info" }) {
  return (
    <div
      data-slot="notice"
      className={cn("rounded-md border px-3 py-2 text-sm", tone === "info" ? infoTone : warningTone, className)}
      {...props}
    />
  )
}

export { Notice }
