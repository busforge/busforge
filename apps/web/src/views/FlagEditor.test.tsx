import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CfgComObjView, DeviceConfigView } from "../api.ts";
import { FlagEditor, FlagEditorPanel } from "./FlagEditor.tsx";

const co = (over: Partial<CfgComObjView> = {}): CfgComObjView => ({
  refId: "M-1_A-1_O-1_R-1", number: 4, name: "Switch", functionText: "", objectSize: "1 Bit", dpt: "1.001",
  flags: { comm: true, read: true, write: true, transmit: false, update: false, readOnInit: false }, priority: "Low", ...over,
});
type Bits = NonNullable<DeviceConfigView["comObjFlagsEditable"]>;
const panel = (c: CfgComObjView, editable: Bits = ["read", "write", "transmit", "priority"]) =>
  renderToStaticMarkup(<TooltipProvider><FlagEditorPanel co={c} editable={editable} onEdit={() => {}} onRevert={() => {}} testId="flags-4" /></TooltipProvider>);

describe("a com-object's flags on the device page", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));

  test("the trigger shows the set flags as ETS's letters", () => {
    const html = renderToStaticMarkup(<TooltipProvider><FlagEditor co={co()} editable={[]} onEdit={() => {}} onRevert={() => {}} testId="flags-4" /></TooltipProvider>);
    expect(html).toContain('data-testid="flags-4"');
    expect(html).toContain("C R W");
  });

  test("only the bits the device's download writes can be edited", () => {
    const html = panel(co());
    const input = (name: string) => html.match(new RegExp(`<input[^>]*data-testid="flags-4-${name}"[^>]*>`))![0];
    expect(input("read")).not.toContain("disabled");
    expect(input("update")).toContain("disabled");
    expect(input("comm")).toContain("disabled");
    expect(html.match(/<select[^>]*>/)![0]).not.toContain("disabled");
  });

  test("a flag the project sets otherwise than the application offers its reset; a pending edit offers the revert", () => {
    const html = panel(co({ overriddenFlags: ["read"], flagsChanged: true }));
    expect(html).toContain('data-testid="flags-4-read-reset"');
    expect(html).not.toContain('data-testid="flags-4-write-reset"');
    expect(html).toContain('data-testid="flags-4-revert"');
    expect(panel(co())).not.toContain('data-testid="flags-4-revert"');
  });

  test("nothing editable says why", () => {
    expect(panel(co(), [])).toContain('data-testid="flags-4-not-editable"');
  });
});
