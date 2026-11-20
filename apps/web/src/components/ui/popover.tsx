import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

// Every popover keeps 16 px off each window edge: where its trigger sits near an edge it moves to keep
// the gap, and it is never wider than the window less the gap on both sides, nor taller than the room
// left on its side (Radix's available width and height are the window's less the collision padding).
// Content taller than that scrolls inside, with a shadow on each edge that has more behind it. A min
// width wins over the width cap in CSS, so a caller's min width is min(its width, the available width).
// A caller may set a lower max height. One with a fixed head over a long list makes the content a flex
// column and the list `min-h-0` with its own scroll, so the list shrinks and the head stays in view.
function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding = 16,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 max-h-(--radix-popover-content-available-height) w-72 max-w-(--radix-popover-content-available-width) scroll-shadow-y overflow-y-auto origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

// The side of its trigger with more room in the window, taken when `open` turns true: `ref` goes on the
// trigger, `side` on the content. For a popover whose content loads after it opens: Radix picks the side
// by the content's height at that moment, and the height being capped to the room on that side, the
// grown content still fits there and keeps the side, however little room it has.
function useRoomierSide(open: boolean) {
  const ref = React.useRef<HTMLButtonElement>(null)
  const [side, setSide] = React.useState<"top" | "bottom">("bottom")
  React.useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setSide(r.top > window.innerHeight - r.bottom ? "top" : "bottom")
  }, [open])
  return { ref, side }
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
  useRoomierSide,
}
