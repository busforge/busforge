import { useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// One line of text that ends in an ellipsis where its box is too narrow. While it is cut, hovering it
// (a tap on a touch screen) shows the whole text in a tooltip; text that fits opens none, since the
// tooltip would only repeat it. Whether it is cut is read at the moment the tooltip would open, so a
// window resize or a late font needs no observer. Copy, search and screen readers get the whole text.
export function TruncatedText({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const cut = () => { const el = ref.current; return !!el && el.scrollWidth > el.clientWidth; };
  return (
    <Tooltip open={open} onOpenChange={(next) => setOpen(next && cut())}>
      <TooltipTrigger asChild tapToOpen>
        <span ref={ref} className={cn("min-w-0 truncate", className)} data-testid={testId}>{text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
