import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import type { DeviceChanges } from "../api.ts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChangePill } from "./ChangePill.tsx";

const changes = (c: Partial<DeviceChanges>): DeviceChanges => ({ params: 0, links: 0, neverProgrammed: false, ...c });
const render = (el: React.ReactElement) => renderToStaticMarkup(<TooltipProvider>{el}</TooltipProvider>);
const tag = (html: string, testId: string) => new RegExp(`<(\\w+)[^>]*data-testid="${testId}"`).exec(html)?.[1];
const noop = () => {};

describe("the state marks of a device", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en } }, lng: "en", interpolation: { escapeValue: false } }));

  test("are plain marks in a device row, which opens nothing", () => {
    const html = render(<ChangePill changes={changes({ neverProgrammed: true })} />);
    expect(tag(html, "never-programmed")).toBe("span");
    expect(html).toContain('title="No configuration of this project');
  });

  test("in the header each opens what clears it, and the pointer and hover say so", () => {
    const targets = { never: { action: "Open Commission", onClick: noop }, changes: { action: "Open flashing", onClick: noop }, security: { action: "Open GA flashing", onClick: noop } };
    expect(tag(render(<ChangePill size="md" targets={targets} changes={changes({ neverProgrammed: true })} />), "never-programmed")).toBe("button");
    const html = render(<ChangePill size="md" targets={targets} changes={changes({ params: 2, security: "changed" })} />);
    expect(tag(html, "device-changes")).toBe("button");
    expect(tag(html, "security-changed")).toBe("button");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("h-6");
  });

  test("a mark whose remedy the device does not offer stays a plain mark", () => {
    const html = render(<ChangePill size="md" targets={{ changes: { action: "Open flashing", onClick: noop } }} changes={changes({ params: 1, security: "unknown" })} />);
    expect(tag(html, "device-changes")).toBe("button");
    expect(tag(html, "security-unknown")).toBe("span");
  });

  test("a clean device shows nothing", () => {
    expect(render(<ChangePill changes={changes({})} targets={{ changes: { action: "x", onClick: noop } }} />)).toBe("");
  });

  test("in the header a clean device says it is programmed, as a plain mark of the same height", () => {
    const html = render(<ChangePill size="md" showProgrammed changes={changes({})} />);
    expect(tag(html, "programmed")).toBe("span");
    expect(html).toContain("h-6");
    expect(html).toContain(" Programmed</span>");
  });

  test("the programmed mark gives way to what the device still needs, and is never claimed without a state", () => {
    expect(render(<ChangePill size="md" showProgrammed changes={changes({ neverProgrammed: true })} />)).not.toContain('data-testid="programmed"');
    expect(render(<ChangePill size="md" showProgrammed changes={changes({ params: 1 })} />)).not.toContain('data-testid="programmed"');
    expect(render(<ChangePill size="md" showProgrammed changes={changes({ security: "unknown" })} />)).not.toContain('data-testid="programmed"');
    expect(render(<ChangePill size="md" showProgrammed />)).toBe("");
  });
});
