import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// Mounts `ui` into the preloaded happy-dom document (./dom.ts) and runs its effects; `rerender` renders it
// again with new props, `unmount` removes it. Every call goes through `act`, so effects and state updates
// have run when it returns.
export function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next: ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
