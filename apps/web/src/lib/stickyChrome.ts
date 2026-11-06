import { useLayoutEffect, type RefObject } from "react";

// The sticky chrome at the top of a page, each part published as a CSS variable on the root: the
// project bar (`--bar-h`), a page header the page pins (`--page-header-h`), and the section jump
// pinned on narrow windows (`--section-nav-h`). Sticky sidebars sit below the chrome, and a jump to
// a section lands just under it, at every window width.
export type ChromeVar = "--bar-h" | "--page-header-h" | "--section-nav-h";

// Publishes under `name` the height of whichever of the elements is sticky at the current width
// (the project bar pins as a whole on wide windows, only its tabs on narrow ones); 0 where none is.
export function useStickyVar(refs: readonly RefObject<HTMLElement | null>[], name: ChromeVar): void {
  useLayoutEffect(() => {
    const els = refs.map((r) => r.current).filter((el): el is HTMLElement => !!el);
    if (!els.length) return;
    const root = document.documentElement.style;
    const set = () => {
      const h = els.reduce((sum, el) => sum + (getComputedStyle(el).position === "sticky" ? el.offsetHeight : 0), 0);
      root.setProperty(name, `${h}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    for (const el of els) ro.observe(el);
    window.addEventListener("resize", set);
    return () => { ro.disconnect(); window.removeEventListener("resize", set); root.removeProperty(name); };
    // The refs are stable objects (a fresh array each render), their elements read once mounted.
  }, [name]);
}

const CHROME_VARS: readonly ChromeVar[] = ["--bar-h", "--page-header-h", "--section-nav-h"];

// How far from the viewport top the sticky chrome reaches.
export function chromeHeight(): number {
  const s = getComputedStyle(document.documentElement);
  return CHROME_VARS.reduce((sum, v) => sum + (parseFloat(s.getPropertyValue(v)) || 0), 0);
}

// Gap between the chrome and a section heading scrolled to it.
const GAP = 12;

export function scrollToSection(el: HTMLElement | undefined): void {
  if (!el) return;
  window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - chromeHeight() - GAP, behavior: "smooth" });
}

// Scroll-spy: whether a section heading at `top` (viewport px) has reached the chrome.
export const reachedChrome = (top: number) => top <= chromeHeight() + GAP * 2;
