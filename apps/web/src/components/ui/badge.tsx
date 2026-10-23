import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Badges and tags: short status or label marks. One radius (the control radius), one height per
// size, so marks next to each other line up whatever their text. A tone carries meaning only:
// primary for the user's own pending work, ok/danger for proven success or failure, warning for an
// unproven state, info for a derived one, neutral for plain labels (docs/design-system.md).
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-border bg-secondary/60 text-muted-foreground",
        outline: "border-border bg-transparent text-muted-foreground",
        primary: "border-primary/40 bg-primary/10 text-primary",
        ok: "border-ok/40 bg-ok/10 text-ok",
        info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
        warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
        danger: "border-destructive/40 bg-destructive/10 text-destructive",
      },
      size: {
        sm: "h-5 px-1.5 text-[10px] [&>svg]:size-3",
        md: "h-6 px-2 text-xs [&>svg]:size-3.5",
      },
      mono: {
        true: "font-mono",
        false: "",
      },
    },
    defaultVariants: {
      tone: "neutral",
      size: "md",
      mono: false,
    },
  }
)

type BadgeVariants = VariantProps<typeof badgeVariants>

// A static mark. It never looks clickable; use BadgeButton for one that opens something.
function Badge({
  className,
  tone,
  size,
  mono,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & BadgeVariants & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"
  return (
    <Comp
      data-slot="badge"
      data-tone={tone ?? "neutral"}
      className={cn(badgeVariants({ tone, size, mono }), className)}
      {...props}
    />
  )
}

// A badge that opens a detail (a popover, a dialog): the same mark, with the states of a control.
function BadgeButton({
  className,
  tone,
  size,
  mono,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & BadgeVariants) {
  return (
    <button
      data-slot="badge-button"
      data-tone={tone ?? "neutral"}
      type={type}
      className={cn(
        badgeVariants({ tone, size, mono }),
        "cursor-pointer outline-none transition-[filter,box-shadow] hover:not-disabled:brightness-125 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Badge, BadgeButton, badgeVariants }
