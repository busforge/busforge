import { test, expect, describe } from "bun:test";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mount } from "@/test/render";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";
import { Badge, BadgeButton } from "./badge.tsx";
import { Chip } from "./chip.tsx";
import { Notice } from "./notice.tsx";
import { Checkbox } from "./checkbox.tsx";
import { Input } from "./input.tsx";
import { NativeSelect } from "./native-select.tsx";
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

describe("a notice", () => {
  test("is the warning badge's colours as a box with the control radius, and takes the caller's layout", () => {
    const badge = classes(renderToStaticMarkup(<Badge tone="warning">Untested</Badge>));
    const c = classes(renderToStaticMarkup(<Notice className="flex py-1.5">Left out</Notice>));
    for (const tone of ["border-warning/40", "bg-warning/10", "text-warning"]) {
      expect(badge).toContain(tone);
      expect(c).toContain(tone);
    }
    expect(c).toContain(CONTROL_RADIUS);
    expect(c).toContain("flex");
    expect(c).toContain("py-1.5");
    expect(c).not.toContain("py-2");
  });
  test("in the info tone is the info badge's colours as a box, and no warning", () => {
    const badge = classes(renderToStaticMarkup(<Badge tone="info">Derived</Badge>));
    const c = classes(renderToStaticMarkup(<Notice tone="info">Configured by a plug-in</Notice>));
    for (const tone of ["border-info/40", "bg-info/10", "text-info"]) {
      expect(badge).toContain(tone);
      expect(c).toContain(tone);
    }
    expect(c.some((x) => x.includes("warning"))).toBe(false);
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

describe("a checkbox", () => {
  const input = (html: string) => /<input[^>]*>/.exec(html)![0];

  test("is a native checkbox with the pointer, a hover only while enabled, the focus ring and the disabled look", () => {
    const html = renderToStaticMarkup(<Checkbox checked onChange={() => {}} aria-label="Read" data-testid="x" />);
    const c = classes(html);
    expect(input(html)).toContain('type="checkbox"');
    expect(input(html)).toContain('aria-label="Read"');
    expect(input(html)).toContain('data-testid="x"');
    expect(c).toContain("cursor-pointer");
    expect(c).toContain("focus-visible:ring-[3px]");
    expect(c).toContain("disabled:cursor-not-allowed");
    expect(c).toContain("disabled:opacity-50");
    expect(c.some((x) => x.startsWith("hover:not-disabled:"))).toBe(true);
    expect(c.some((x) => x.startsWith("hover:") && !x.startsWith("hover:not-disabled:"))).toBe(false);
    expect(c).not.toContain("rounded-full");
  });

  test("says it is checked or disabled only when it is", () => {
    expect(input(renderToStaticMarkup(<Checkbox checked onChange={() => {}} />))).toContain(' checked=""');
    expect(input(renderToStaticMarkup(<Checkbox checked={false} onChange={() => {}} />))).not.toContain(' checked=""');
    expect(input(renderToStaticMarkup(<Checkbox checked disabled onChange={() => {}} />))).toContain(' disabled=""');
    expect(input(renderToStaticMarkup(<Checkbox checked onChange={() => {}} />))).not.toContain(' disabled=""');
  });

  test("grows on a touch screen like the other controls", () => {
    expect(classes(renderToStaticMarkup(<Checkbox checked onChange={() => {}} />))).toContain("pointer-coarse:size-5");
  });

  test("is the only checkbox in the app: every other one goes through it", async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("**/*.tsx").scan({ cwd: `${import.meta.dir}/../..`, absolute: true })) {
      if (file.endsWith("/components/ui/checkbox.tsx") || file.endsWith(".test.tsx")) continue;
      if (/type=["']checkbox["']/.test(await Bun.file(file).text())) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  describe("in the page", () => {
    const box = (container: HTMLElement) => container.querySelector("input")!;

    test("is mixed after mounting and after every render, also when something cleared it in between", () => {
      const view = mount(<Checkbox checked={false} indeterminate onChange={() => {}} />);
      expect(box(view.container).indeterminate).toBe(true);
      box(view.container).indeterminate = false;
      view.rerender(<Checkbox checked={false} indeterminate onChange={() => {}} />);
      expect(box(view.container).indeterminate).toBe(true);
      view.rerender(<Checkbox checked={false} onChange={() => {}} />);
      expect(box(view.container).indeterminate).toBe(false);
      view.unmount();
    });

    test("stays mixed and unticked after a click its owner does not take", () => {
      const seen: boolean[] = [];
      const view = mount(<Checkbox checked={false} indeterminate onChange={(e) => seen.push(e.target.checked)} />);
      act(() => box(view.container).click());
      expect(seen).toEqual([true]);
      expect(box(view.container).checked).toBe(false);
      expect(box(view.container).indeterminate).toBe(true);
      view.unmount();
    });

    test("leaves the mixed state once its owner takes the click", () => {
      function Owner() {
        const [state, setState] = useState<boolean | "mixed">("mixed");
        return <Checkbox checked={state === true} indeterminate={state === "mixed"} onChange={(e) => setState(e.target.checked)} />;
      }
      const view = mount(<Owner />);
      act(() => box(view.container).click());
      expect(box(view.container).checked).toBe(true);
      expect(box(view.container).indeterminate).toBe(false);
      view.unmount();
    });
  });
});

describe("a native select", () => {
  const select = (html: string) => /<select[^>]*>/.exec(html)![0];
  const selectClasses = (html: string) => (/class="([^"]*)"/.exec(select(html))?.[1] ?? "").split(" ");
  const wrapperClasses = (html: string) => (/<span[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");
  const render = (props: Partial<React.ComponentProps<typeof NativeSelect>> = {}) =>
    renderToStaticMarkup(
      <NativeSelect value="b" onChange={() => {}} aria-label="Priority" data-testid="x" {...props}>
        <option value="a">A</option>
        <option value="b">B</option>
      </NativeSelect>
    );

  test("is a native select that keeps its options, value and attributes, with the combobox chevron beside it", () => {
    const html = render();
    expect(html).toContain('<option value="b" selected="">B</option>');
    expect(select(html)).toContain('aria-label="Priority"');
    expect(select(html)).toContain('data-testid="x"');
    expect(html).toContain("lucide-chevrons-up-down");
  });

  test("has the pointer, the control radius, a hover only while enabled, the focus ring and the disabled look", () => {
    const c = selectClasses(render());
    expect(c).toContain("cursor-pointer");
    expect(c).toContain(CONTROL_RADIUS);
    expect(c).toContain("focus-visible:ring-[3px]");
    expect(c).toContain("disabled:cursor-not-allowed");
    expect(c).toContain("disabled:opacity-50");
    expect(c.some((x) => x.includes("hover:not-disabled:"))).toBe(true);
    expect(c.some((x) => x.includes("hover:") && !x.includes("hover:not-disabled:"))).toBe(false);
    expect(c).not.toContain("rounded-full");
  });

  test("shows the invalid state of an input and the touch size of an input", () => {
    const c = selectClasses(render());
    const input = classes(renderToStaticMarkup(<Input />));
    for (const x of input.filter((y) => y.includes("aria-invalid:") || y.startsWith("pointer-coarse:h-"))) expect(c).toContain(x);
    expect(c).toContain("pointer-coarse:h-10");
  });

  test("is as high as a control of its size: 36 px, or 32 px small", () => {
    expect(selectClasses(render())).toContain("h-9");
    expect(selectClasses(render())).not.toContain("h-8");
    expect(selectClasses(render({ size: "sm" }))).toContain("h-8");
    expect(selectClasses(render({ size: "sm" }))).not.toContain("h-9");
    // An attribute-variant height would outrank `pointer-coarse:h-10` and keep the select small on a touch screen.
    for (const size of ["default", "sm"] as const) expect(selectClasses(render({ size })).filter((x) => /^(data|aria)-\[.*:h-/.test(x))).toEqual([]);
  });

  test("says it is disabled only when it is", () => {
    expect(select(render({ disabled: true }))).toContain(' disabled=""');
    expect(select(render())).not.toContain(' disabled=""');
  });

  test("takes the caller's layout on its wrapper, not on the select", () => {
    const html = render({ className: "w-56" });
    expect(wrapperClasses(html)).toContain("w-56");
    expect(selectClasses(html)).not.toContain("w-56");
  });

  test("is the only select in the app: every other one goes through it", async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("**/*.tsx").scan({ cwd: `${import.meta.dir}/../..`, absolute: true })) {
      if (file.endsWith("/components/ui/native-select.tsx") || file.endsWith(".test.tsx")) continue;
      if (/<select[\s>]/.test(await Bun.file(file).text())) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
