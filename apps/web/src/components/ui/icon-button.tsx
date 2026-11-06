import * as React from "react"
import type { VariantProps } from "class-variance-authority"

import { Button, type buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type IconSize = "icon" | "icon-xs" | "icon-sm" | "icon-lg"

// A button that shows only an icon. Its label is required: it is the accessible name and, unless
// `tooltip` is false, the tooltip on hover and keyboard focus, so the icon is never the only hint.
function IconButton({
  label,
  tooltip = true,
  variant = "ghost",
  size = "icon",
  tooltipClassName,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "aria-label"> &
  Pick<VariantProps<typeof buttonVariants>, "variant"> & {
    label: string
    tooltip?: boolean
    // Hides the tooltip where the button shows its label as text (e.g. `xl:hidden`).
    tooltipClassName?: string
    size?: IconSize
  }) {
  const button = (
    <Button data-slot="icon-button" variant={variant} size={size} aria-label={label} {...props}>
      {children}
    </Button>
  )
  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className={tooltipClassName}>{label}</TooltipContent>
    </Tooltip>
  )
}

export { IconButton }
