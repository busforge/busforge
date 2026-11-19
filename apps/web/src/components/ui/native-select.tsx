import * as React from "react"
import { ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

// A native `<select>` in the app's look: the control border and fill, the combobox chevron, the pointer,
// the hover and the focus ring of every control, the invalid state of `Input`. It stays a native element
// on purpose: a device page holds hundreds of enum parameters, and mounting that many popover selects is
// the page's main render cost, where the browser draws a native one for free.
//
// `className` places the control (width, margin) and lands on the wrapper that carries the chevron;
// every other prop, `ref` and `style` included, goes to the `<select>` itself.
function NativeSelect({
  className,
  size = "default",
  children,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <span data-slot="native-select-wrapper" className={cn("relative inline-flex min-w-0", className)}>
      <select
        data-slot="native-select"
        className={cn(
          "peer w-full min-w-0 cursor-pointer appearance-none rounded-md border border-input bg-transparent pr-8 pl-3 text-sm shadow-xs transition-[color,box-shadow] outline-none dark:bg-input/30",
          size === "sm" ? "h-8" : "h-9",
          "pointer-coarse:h-10 pointer-coarse:text-base",
          "hover:not-disabled:bg-accent/50 dark:hover:not-disabled:bg-input/50",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          "disabled:cursor-not-allowed disabled:opacity-50 [&_option]:bg-popover [&_option]:text-popover-foreground",
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground peer-disabled:opacity-50" />
    </span>
  )
}

export { NativeSelect }
