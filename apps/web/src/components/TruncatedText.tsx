import { useLayoutEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Whether a one-line box shows less than its text. The widths are compared unrounded: scrollWidth and
// clientWidth are whole pixels, so text that overflows by less than one would read as not cut while
// its ellipsis shows.
export function isCut(textWidth: number, boxWidth: number): boolean {
  return textWidth > boxWidth + 0.01;
}

function measureCut(el: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(el);
  return isCut(range.getBoundingClientRect().width, el.getBoundingClientRect().width);
}

// One line of text that ends in an ellipsis where its box is too narrow. While it is cut, hovering it,
// focusing it (it is a tab stop only then) or a tap on a touch screen shows the whole text in a
// tooltip; text that fits opens none, since the tooltip would only repeat it. Copy, search and screen
// readers get the whole text.
export function TruncatedText({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(measureCut(el));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return (
    // Measured again on opening: a late web font changes the text's width without resizing its box.
    <Tooltip open={open} onOpenChange={(next) => setOpen(next && !!ref.current && measureCut(ref.current))}>
      <TooltipTrigger asChild tapToOpen>
        <span ref={ref} tabIndex={cut ? 0 : undefined} className={cn("min-w-0 truncate", className)} data-testid={testId}>{text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
