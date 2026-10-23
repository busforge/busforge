import * as React from "react"

import { cn } from "@/lib/utils"

// A toggle for a filter or a choice among a few: off it reads as a quiet control, on it carries
// the amber selection. `active` is announced as aria-pressed.
function Chip({
  className,
  active = false,
  type = "button",
  ...props
}: Omit<React.ComponentProps<"button">, "aria-pressed"> & { active?: boolean }) {
  return (
    <button
      data-slot="chip"
      data-active={active || undefined}
      aria-pressed={active}
      type={type}
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        active
          ? "border-primary/50 bg-primary/15 text-primary hover:not-disabled:bg-primary/25"
          : "border-border bg-transparent text-muted-foreground hover:not-disabled:border-muted-foreground/40 hover:not-disabled:bg-accent hover:not-disabled:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Chip }
