import { test, expect } from "bun:test";
import { devServerSettings } from "./devServer.ts";

test("without environment the dev server keeps its defaults", () => {
  expect(devServerSettings({})).toEqual({ apiTarget: "http://localhost:3000", apiWsTarget: "ws://localhost:3000", port: undefined });
});

test("BUSFORGE_API and BUSFORGE_WEB move the proxy target and the listening port", () => {
  expect(devServerSettings({ BUSFORGE_API: "http://127.0.0.1:3917", BUSFORGE_WEB: "http://localhost:5917" }))
    .toEqual({ apiTarget: "http://127.0.0.1:3917", apiWsTarget: "ws://127.0.0.1:3917", port: 5917 });
});

test("an https API gets a wss WebSocket target", () => {
  const s = devServerSettings({ BUSFORGE_API: "https://busforge.example:8443/" });
  expect(s.apiTarget).toBe("https://busforge.example:8443");
  expect(s.apiWsTarget).toBe("wss://busforge.example:8443");
});

test("a value with a path, query or fragment is refused instead of cut to its origin", () => {
  for (const bad of ["http://localhost:3917/busforge", "http://localhost:3917/?a=1", "http://localhost:3917/#x"]) {
    expect(() => devServerSettings({ BUSFORGE_API: bad })).toThrow("BUSFORGE_API");
  }
  expect(() => devServerSettings({ BUSFORGE_WEB: "http://localhost:5917/app" })).toThrow("BUSFORGE_WEB");
});

test("a malformed or port-less value is refused instead of falling back", () => {
  expect(() => devServerSettings({ BUSFORGE_API: "localhost:3917" })).toThrow("BUSFORGE_API");
  expect(() => devServerSettings({ BUSFORGE_API: "ftp://localhost:3917" })).toThrow("BUSFORGE_API");
  expect(() => devServerSettings({ BUSFORGE_WEB: "http://localhost" })).toThrow("BUSFORGE_WEB");
  expect(() => devServerSettings({ BUSFORGE_WEB: "" })).toThrow("BUSFORGE_WEB");
  expect(() => devServerSettings({ BUSFORGE_WEB: "http://localhost:0" })).toThrow("BUSFORGE_WEB");
  expect(() => devServerSettings({ BUSFORGE_WEB: "https://localhost:5917" })).toThrow("BUSFORGE_WEB");
});
