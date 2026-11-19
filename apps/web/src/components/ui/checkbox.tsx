import * as React from "react"

import { cn } from "@/lib/utils"

// A native checkbox in the app's look: the control border and fill, an amber box with a dark tick when
// checked and a dash when indeterminate, the pointer on hover, the focus ring on keyboard focus. Being a
// native input it keeps its label, form and keyboard behaviour; the tick and the dash are drawn by
// `index.css` ([data-slot="checkbox"]).
//
// `indeterminate` is the state of a value that is neither checked nor unchecked. React does not hold the
// property and a click clears it, so it is set again after every render and every click: a click that is
// refused or leaves the value as it was keeps the box indeterminate.
function Checkbox({
  className,
  indeterminate = false,
  onChange,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "ref"> & { indeterminate?: boolean }) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  })
  return (
    <input
      ref={ref}
      type="checkbox"
      data-slot="checkbox"
      onChange={(e) => {
        onChange?.(e)
        e.currentTarget.indeterminate = indeterminate
      }}
      className={cn(
        "relative size-4 shrink-0 appearance-none overflow-hidden rounded-sm border border-input bg-input/30 shadow-xs transition-[color,background-color,border-color,box-shadow] outline-none pointer-coarse:size-5",
        "hover:not-disabled:border-ring hover:not-disabled:bg-accent",
        "checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary hover:not-disabled:checked:bg-primary/85 hover:not-disabled:indeterminate:bg-primary/85",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/30",
        "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Checkbox }
