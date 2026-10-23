import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";
import { Badge, BadgeButton } from "./badge.tsx";
import { Chip } from "./chip.tsx";
import { TooltipProvider } from "./tooltip.tsx";

const classes = (html: string) => (/class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");
// The single control radius every button, badge and chip shares (docs/design-system.md, "Components").
const CONTROL_RADIUS = "rounded-md";

describe("a button", () => {
  test("shows the pointer, the control radius, a hover only while enabled, and the focus ring", () => {
    for (const variant of ["default", "destructive", "outline", "secondary", "ghost", "link"] as const) {
      const c = classes(renderToStaticMarkup(<Button variant={variant}>Go</Button>));
      expect(c).toContain("cursor-pointer");
      expect(c).toContain(CONTROL_RADIUS);
      expect(c).toContain("focus-visible:ring-[3px]");
      expect(c).toContain("disabled:cursor-not-allowed");
      expect(c.some((x) => x.startsWith("hover:not-disabled:"))).toBe(true);
      expect(c.some((x) => x.startsWith("hover:") && !x.startsWith("hover:not-disabled:"))).toBe(false);
      expect(c).not.toContain("rounded-full");
    }
  });

  test("never submits a form unless asked to", () => {
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<Button type="submit">Go</Button>)).toContain('type="submit"');
  });

  test("keeps the element it is given as a child, with the button's states", () => {
    const html = renderToStaticMarkup(<Button asChild variant="outline"><a href="/x">Link</a></Button>);
    expect(html.startsWith("<a")).toBe(true);
    expect(html).not.toContain("type=");
    expect(classes(html)).toContain("cursor-pointer");
  });

  test("says it is disabled", () => {
    expect(renderToStaticMarkup(<Button disabled>Go</Button>)).toMatch(/<button[^>]* disabled=""/);
    expect(renderToStaticMarkup(<Button>Go</Button>)).not.toMatch(/<button[^>]* disabled=""/);
  });
});

describe("an icon button", () => {
  test("is named by its label and shows it as a tooltip", () => {
    const html = renderToStaticMarkup(<TooltipProvider><IconButton label="Export project"><svg /></IconButton></TooltipProvider>);
    expect(html).toContain('aria-label="Export project"');
    expect(html).toContain('data-slot="icon-button"');
    expect(html).toContain('data-state="closed"');
  });

  test("without a tooltip keeps its name", () => {
    const html = renderToStaticMarkup(<IconButton label="Clear search" tooltip={false}><svg /></IconButton>);
    expect(html).toContain('aria-label="Clear search"');
    expect(html).not.toContain("data-state");
  });
});

describe("a badge", () => {
  test("has one height per size whatever its text or tone, and the control radius", () => {
    const tones = ["neutral", "outline", "primary", "ok", "info", "warning", "danger"] as const;
    for (const [size, height] of [["sm", "h-5"], ["md", "h-6"]] as const) {
      for (const tone of tones) {
        const c = classes(renderToStaticMarkup(<Badge tone={tone} size={size}>never programmed</Badge>));
        expect(c).toContain(height);
        expect(c).toContain(CONTROL_RADIUS);
        expect(c).not.toContain("rounded-full");
      }
    }
  });

  test("a static badge does not look clickable", () => {
    const c = classes(renderToStaticMarkup(<Badge>M-0083</Badge>));
    expect(c).not.toContain("cursor-pointer");
    expect(c.some((x) => x.startsWith("hover:"))).toBe(false);
  });

  test("bus data is set in the mono face", () => {
    expect(classes(renderToStaticMarkup(<Badge mono>M-0083</Badge>))).toContain("font-mono");
    expect(classes(renderToStaticMarkup(<Badge>Secure</Badge>))).not.toContain("font-mono");
  });

  test("a badge that opens something is a button with the states of a control, at the same height", () => {
    const html = renderToStaticMarkup(<BadgeButton tone="warning">Untested</BadgeButton>);
    const c = classes(html);
    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain('type="button"');
    expect(c).toContain("h-6");
    expect(c).toContain("cursor-pointer");
    expect(c).toContain("focus-visible:ring-[3px]");
    expect(c.some((x) => x.startsWith("hover:not-disabled:"))).toBe(true);
  });
});

describe("a chip", () => {
  test("announces its state and carries the selection colour only when active", () => {
    const off = renderToStaticMarkup(<Chip>3 to program</Chip>);
    const on = renderToStaticMarkup(<Chip active>3 to program</Chip>);
    expect(off).toContain('aria-pressed="false"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('data-active="true"');
    expect(classes(on)).toContain("text-primary");
    expect(classes(off)).not.toContain("text-primary");
  });

  test("shows the pointer, the control radius and the focus ring", () => {
    const c = classes(renderToStaticMarkup(<Chip>IP</Chip>));
    expect(c).toContain("cursor-pointer");
    expect(c).toContain(CONTROL_RADIUS);
    expect(c).toContain("focus-visible:ring-[3px]");
    expect(c).toContain("disabled:cursor-not-allowed");
  });
});
