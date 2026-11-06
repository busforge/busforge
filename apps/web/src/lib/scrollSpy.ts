import { useCallback, useEffect, useRef, useState } from "react";
import { reachedChrome, scrollToSection } from "./stickyChrome.ts";

// How long the page has to stand still after a jump before the scroll position decides again.
const SETTLE_MS = 200;

// Scroll-spy over a page's section headings. The active section is the last whose heading has
// reached the sticky chrome, so exactly one is active and it never flickers. A jump to a section makes
// it active until the scroll it started settles, also where the page cannot scroll the heading up to
// the chrome (the last sections of a short page). `first` is active before any heading has reached
// the chrome; `version` changes whenever the set of sections does.
export function useScrollSpy(first: string | null, version: unknown) {
  const refs = useRef(new Map<string, HTMLElement>());
  const jumping = useRef(false);
  const settle = useRef(0);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      let best: string | null = null;
      let bestTop = -Infinity;
      refs.current.forEach((el, id) => {
        const top = el.getBoundingClientRect().top;
        if (reachedChrome(top) && top > bestTop) { bestTop = top; best = id; }
      });
      setActive(best ?? first);
    };
    const onScroll = () => {
      if (jumping.current) {
        window.clearTimeout(settle.current);
        settle.current = window.setTimeout(() => { jumping.current = false; }, SETTLE_MS);
        return;
      }
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); window.clearTimeout(settle.current); };
  }, [first, version]);

  const registerRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(id, el); else refs.current.delete(id);
  }, []);

  const jump = useCallback((id: string) => {
    const el = refs.current.get(id);
    if (!el) return;
    jumping.current = true;
    setActive(id);
    window.clearTimeout(settle.current);
    // Released by the scroll settling, or at once where the page does not move.
    settle.current = window.setTimeout(() => { jumping.current = false; }, SETTLE_MS * 3);
    scrollToSection(el);
  }, []);

  return { active, registerRef, jump };
}
