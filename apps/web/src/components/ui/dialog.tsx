import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/60 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

// The frame shared by every dialog and confirmation: centred, never taller than the window, the
// close button in its corner.
const dialogFrame =
  "fixed top-[50%] left-[50%] z-50 max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] rounded-lg border bg-popover text-popover-foreground shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg"

// A confirmation scrolls as a whole when the window is too short, so its buttons stay reachable.
const dialogPanel = cn(dialogFrame, "grid gap-4 overflow-y-auto p-6")

function CloseCorner({ asClose }: { asClose: (button: React.ReactElement) => React.ReactElement }) {
  const { t } = useTranslation()
  return asClose(
    <Button
      variant="ghost"
      size="icon-sm"
      data-slot="dialog-close"
      aria-label={t("common.close")}
      className="absolute top-3 right-3 text-muted-foreground hover:not-disabled:text-foreground"
    >
      <XIcon />
    </Button>
  )
}

// Every dialog can be left: by its close button, Esc, its cancel button, and a click on the
// backdrop. Two narrower cases, both chosen by the caller:
// - `backdropClose={false}` where a stray click would throw away what the user typed;
// - `dismissible={false}` only while an operation runs whose result the dialog has to show: no
//   close button, Esc or backdrop then. The dialog offers the operation's cancel where it has one,
//   and becomes closable again when the operation ends.
function DialogContent({
  className,
  children,
  dismissible = true,
  backdropClose = true,
  onEscapeKeyDown,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  dismissible?: boolean
  backdropClose?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      {/* The frame does not clip: a list portaled into it (the datapoint type picker) may reach past
          its edge. Its body scrolls instead, so the buttons stay reachable on a short window. */}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(dialogFrame, "flex flex-col", className)}
        onEscapeKeyDown={(e) => { onEscapeKeyDown?.(e); if (!dismissible) e.preventDefault() }}
        onPointerDownOutside={(e) => { onPointerDownOutside?.(e); if (!dismissible || !backdropClose) e.preventDefault() }}
        {...props}
      >
        <div data-slot="dialog-body" className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-6">{children}</div>
        {dismissible && <CloseCorner asClose={(b) => <DialogPrimitive.Close asChild>{b}</DialogPrimitive.Close>} />}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pr-8 text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-tight font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  CloseCorner,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogPanel,
}
