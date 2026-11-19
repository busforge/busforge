import * as React from "react"

import { cn } from "@/lib/utils"
import { warningTone } from "@/components/ui/badge"

// A boxed warning note in running text (a dialog, the device page): the warning badge's tone as a
// block, so a warning reads the same whether it is a mark or a sentence (docs/design-system.md).
// Layout (icon row, spacing) is the caller's.
function Notice({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="notice"
      className={cn("rounded-md border px-3 py-2 text-sm", warningTone, className)}
      {...props}
    />
  )
}

export { Notice }
