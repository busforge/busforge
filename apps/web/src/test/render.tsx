import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { cleanups } from "./dom.ts";

// Mounts `ui` into the preloaded happy-dom document (./dom.ts) and runs its effects; `rerender` renders it
// again with new props. Every call goes through `act`, so effects and state updates have run when it returns.
// The root is unmounted after the test; `unmount` does it earlier.
export function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const unmount = () => {
    if (!cleanups.delete(unmount)) return;
    act(() => root.unmount());
    container.remove();
  };
  cleanups.add(unmount);
  act(() => root.render(ui));
  return { container, rerender: (next: ReactNode) => act(() => root.render(next)), unmount };
}
