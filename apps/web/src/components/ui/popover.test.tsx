import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { act } from "react";
import { mount } from "@/test/render";
import { useRoomierSide } from "./popover.tsx";

// happy-dom computes no layout: the trigger's place in the window and the window's height are set here. The
// window is 600 px high; a trigger at `top` is 20 px high.
const happyDOM = (globalThis as unknown as { happyDOM: { setViewport(v: { height: number }): void } }).happyDOM;
let top = 0;
const initialHeight = window.innerHeight;

function Trigger({ open }: { open: boolean }) {
  const { ref, side } = useRoomierSide(open);
  return <button ref={ref} data-side={side} />;
}
const side = (container: HTMLElement) => container.querySelector("button")!.dataset.side;
const scrollEnd = (target: EventTarget) => act(() => void target.dispatchEvent(new Event("scrollend")));

describe("a popover whose content loads after it opens", () => {
  let rect: ReturnType<typeof spyOn>;
  beforeEach(() => {
    happyDOM.setViewport({ height: 600 });
    rect = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, top, 100, 20));
  });
  afterEach(() => {
    rect.mockRestore();
    happyDOM.setViewport({ height: initialHeight });
  });

  test("opens on the side of its trigger with more room", () => {
    top = 450;
    const low = mount(<Trigger open />);
    expect(side(low.container)).toBe("top");
    low.unmount();
    top = 100;
    const high = mount(<Trigger open />);
    expect(side(high.container)).toBe("bottom");
    high.unmount();
  });

  test("takes the roomier side again when a scroll ends while it is open, also a scroll inside the page", () => {
    top = 100;
    const view = mount(<Trigger open />);
    const pane = document.createElement("div");
    document.body.append(pane);
    top = 450;
    scrollEnd(pane);
    expect(side(view.container)).toBe("top");
    top = 100;
    scrollEnd(document);
    expect(side(view.container)).toBe("bottom");
    pane.remove();
    view.unmount();
  });

  test("takes the roomier side again when the window is resized while it is open", () => {
    top = 250;
    const view = mount(<Trigger open />);
    expect(side(view.container)).toBe("bottom");
    act(() => happyDOM.setViewport({ height: 400 }));
    expect(side(view.container)).toBe("top");
    view.unmount();
  });

  test("measures nothing while closed, and measures again when it opens", () => {
    top = 450;
    const view = mount(<Trigger open={false} />);
    expect(side(view.container)).toBe("bottom");
    view.rerender(<Trigger open />);
    expect(side(view.container)).toBe("top");
    view.rerender(<Trigger open={false} />);
    top = 100;
    scrollEnd(document);
    act(() => happyDOM.setViewport({ height: 500 }));
    expect(side(view.container)).toBe("top");
    view.rerender(<Trigger open />);
    expect(side(view.container)).toBe("bottom");
    view.unmount();
  });
});
