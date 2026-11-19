import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TruncatedText, isCut } from "./TruncatedText.tsx";

describe("a line of text cut with an ellipsis", () => {
  test("holds the whole text in one truncating span", () => {
    const name = "BE-02001.02 Universal Interface 2-fold, flush mounted, Contact inputs";
    const html = renderToStaticMarkup(<TooltipProvider><TruncatedText text={name} className="text-xl" testId="device-name" /></TooltipProvider>);
    const span = html.match(/<span[^>]*data-testid="device-name"[^>]*>([^<]*)<\/span>/);
    expect(span?.[1]).toBe(name);
    expect(span?.[0]).toMatch(/class="[^"]*\btruncate\b[^"]*"/);
  });

  test("counts as cut only where its text is wider than its box, by any fraction of a pixel", () => {
    expect(isCut(300, 300)).toBe(false);
    expect(isCut(120, 300)).toBe(false);
    expect(isCut(300.4, 300)).toBe(true);
    expect(isCut(612, 300)).toBe(true);
  });
});
