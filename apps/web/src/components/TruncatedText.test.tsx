import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TruncatedText } from "./TruncatedText.tsx";

describe("a line of text cut with an ellipsis", () => {
  test("holds the whole text on one truncating line, with no tooltip until it is asked for", () => {
    const name = "BE-02001.02 Universal Interface 2-fold, flush mounted, Contact inputs";
    const html = renderToStaticMarkup(<TooltipProvider><TruncatedText text={name} className="text-xl" testId="device-name" /></TooltipProvider>);
    expect(new RegExp(`<span[^>]*class="min-w-0 truncate text-xl"[^>]*data-testid="device-name"[^>]*>${name}</span>`).test(html)).toBe(true);
    expect(html).not.toContain('data-slot="tooltip-content"');
  });
});
