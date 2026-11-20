import { afterAll, afterEach } from "bun:test";
import { BrowserErrorCaptureEnum, GlobalWindow, PropertySymbol } from "happy-dom";

// Preloaded for every web test (bunfig.toml): a happy-dom window whose properties become the globals, so a
// test can mount components with react-dom/client and click them (`mount` in ./render.tsx). It is the whole
// suite, not a per-file opt-in, because bun shares one module cache across test files and libraries decide at
// load time whether a DOM exists (Radix's useLayoutEffect, React's canUseDOM): a DOM installed by one file
// would arrive too late for the modules an earlier file already loaded. happy-dom computes no layout: element
// boxes and scroll offsets are 0 unless a test sets them, and the window is 1024 x 768.
//
// Its error capture is off: by default happy-dom's timers and event dispatch catch an exception and only log it.
const window = new GlobalWindow({ url: "http://localhost/", console: globalThis.console, settings: { errorCapture: BrowserErrorCaptureEnum.disabled } });
const VIEWPORT = { width: 1024, height: 768 };

// Bun's own network, URL, abort and timer globals stay, so a test of the API client and a test that waits
// run on what they ran on before.
const keep = new Set<PropertyKey>([
  "constructor", "undefined", "NaN", "Infinity", "global", "globalThis",
  "fetch", "Request", "Response", "Headers", "WebSocket", "URL", "URLSearchParams", "AbortController", "AbortSignal",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "queueMicrotask",
]);
for (const key of Reflect.ownKeys(window)) {
  if (keep.has(key) && key in globalThis) continue;
  const desc = Object.getOwnPropertyDescriptor(window, key)!;
  if (Object.getOwnPropertyDescriptor(globalThis, key)?.value === desc.value && desc.value !== undefined) continue;
  Object.defineProperty(globalThis, key, { ...desc, ...(desc.value === window ? { value: globalThis } : {}), configurable: true });
}
(window.document as unknown as Record<symbol, unknown>)[PropertySymbol.defaultView] = globalThis;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What one test leaves in the shared document is gone before the next: its mounted roots (`mount` registers
// their unmount here, so a failed assertion leaks none), the body, storage and the window size.
export const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  window.happyDOM.setViewport(VIEWPORT);
});
afterAll(() => window.happyDOM.close());
