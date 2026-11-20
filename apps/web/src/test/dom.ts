import { afterAll } from "bun:test";
import { GlobalWindow, PropertySymbol } from "happy-dom";

// Preloaded for every web test (bunfig.toml): a happy-dom window whose properties become the globals, so a
// test can mount components with react-dom/client and click them (`mount` in ./render.tsx). It is the whole
// suite, not a per-file opt-in, because bun shares one module cache across test files and libraries decide at
// load time whether a DOM exists (Radix's useLayoutEffect, React's canUseDOM): a DOM installed by one file
// would arrive too late for the modules an earlier file already loaded. happy-dom computes no layout: every
// size and position is 0 unless a test sets it.
const window = new GlobalWindow({ url: "http://localhost/", console: globalThis.console });
const skip = new Set<PropertyKey>(["constructor", "undefined", "NaN", "Infinity", "global", "globalThis"]);
for (const key of Reflect.ownKeys(window)) {
  if (skip.has(key)) continue;
  const desc = Object.getOwnPropertyDescriptor(window, key)!;
  if (Object.getOwnPropertyDescriptor(globalThis, key)?.value === desc.value && desc.value !== undefined) continue;
  Object.defineProperty(globalThis, key, { ...desc, ...(desc.value === window ? { value: globalThis } : {}), configurable: true });
}
(window.document as unknown as Record<symbol, unknown>)[PropertySymbol.defaultView] = globalThis;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => window.happyDOM.close());
