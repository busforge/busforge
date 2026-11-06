import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
  )
}

// The open state of the surrounding Tooltip, for a trigger that opens it by tap (a touch screen has
// no hover to open it).
const TapState = React.createContext<{ open: boolean; set: (open: boolean) => void } | null>(null)

function Tooltip({ open: openProp, onOpenChange, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [own, setOwn] = React.useState(false)
  const open = openProp ?? own
  const set = (next: boolean) => {
    if (openProp === undefined) setOwn(next)
    onOpenChange?.(next)
  }
  return (
    <TapState.Provider value={{ open, set }}>
      <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={set} {...props} />
    </TapState.Provider>
  )
}

// `tapToOpen`: on a touch screen a tap opens and closes the tooltip. Only for a trigger whose sole
// job is the tooltip (an info mark); an action button's tap stays its action.
function TooltipTrigger({ tapToOpen = false, onPointerDown, onClick, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger> & { tapToOpen?: boolean }) {
  const tap = React.useContext(TapState)
  // Radix closes an open tooltip on the trigger's pointerdown, before the click: the click toggles
  // from the state the tap started in.
  const openAtPress = React.useRef(false)
  const coarse = () => window.matchMedia("(pointer: coarse)").matches
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerDown={(e) => {
        openAtPress.current = !!tap?.open
        onPointerDown?.(e)
      }}
      onClick={(e) => {
        onClick?.(e)
        if (!tapToOpen || !tap || e.defaultPrevented || !coarse()) return
        // Radix also closes the tooltip on a click of its trigger unless the click is prevented.
        e.preventDefault()
        tap.set(!openAtPress.current)
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit max-w-xs rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
