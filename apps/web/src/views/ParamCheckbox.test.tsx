import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import { ParamCheckbox } from "./ParamCheckbox.tsx";

const render = (value: string, disabled?: boolean) =>
  renderToStaticMarkup(<ParamCheckbox value={value} disabled={disabled} label="Read" onChange={() => {}} testId="param-1" />);
const input = (html: string) => html.match(/<input[^>]*>/)![0];

describe("a number parameter ETS draws as a checkbox", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en } }, lng: "en", interpolation: { escapeValue: false } }));

  test("1 is ticked, 0 unticked, and neither names a value outside the type", () => {
    expect(input(render("1"))).toContain("checked");
    expect(input(render("0"))).not.toContain("checked");
    expect(render("0")).not.toContain("param-1-outside");
    expect(render("1")).not.toContain("param-1-outside");
  });

  test("a value that is neither 0 nor 1 is shown as such, not as a box state", () => {
    const html = render("2");
    expect(input(html)).not.toContain("checked");
    expect(html).toContain('data-testid="param-1-outside"');
    expect(html).toContain("2 (no value of this parameter)");
  });

  test("a read-only parameter shows a disabled box", () => {
    expect(input(render("1", true))).toContain("disabled");
    expect(input(render("1"))).not.toContain("disabled");
  });
});
