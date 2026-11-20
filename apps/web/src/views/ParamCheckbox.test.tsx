import { test, expect, describe, beforeAll } from "bun:test";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mount } from "@/test/render";
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
    expect(input(render("1"))).toContain(' checked=""');
    expect(input(render("0"))).not.toContain(' checked=""');
    expect(render("0")).not.toContain("param-1-outside");
    expect(render("1")).not.toContain("param-1-outside");
  });

  test("a value that is neither 0 nor 1 is shown as such, not as a box state", () => {
    const html = render("2");
    expect(input(html)).not.toContain(' checked=""');
    expect(html).toContain('data-testid="param-1-outside"');
    expect(html).toContain("2 (no value of this parameter)");
  });

  test("a read-only parameter shows a disabled box", () => {
    expect(input(render("1", true))).toContain(' disabled=""');
    expect(input(render("1"))).not.toContain(' disabled=""');
  });

  // A stand-in for the device page: it renders again while the write is under way and when it ends, and keeps the
  // project's value when the server refuses the write (409).
  function Page({ initial, accept, writes }: { initial: string; accept: boolean; writes: string[] }) {
    const [value, setValue] = useState(initial);
    const [saving, setSaving] = useState(false);
    const write = async (next: string) => {
      writes.push(next);
      setSaving(true);
      try {
        await Promise.resolve(); // the request
        if (!accept) throw Object.assign(new Error("refused"), { status: 409 });
        setValue(next);
      } catch {
        // the page shows a toast; the value stays
      } finally {
        setSaving(false);
      }
    };
    return (
      <div data-saving={saving}>
        <ParamCheckbox value={value} label="Read" onChange={(v) => void write(v)} testId="param-1" />
      </div>
    );
  }
  const box = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-testid="param-1"]')!;
  const saving = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-saving]")!.dataset.saving;

  test("a value outside the type stays neither ticked nor unticked when the write of a click is refused", async () => {
    const writes: string[] = [];
    const view = mount(<Page initial="2" accept={false} writes={writes} />);
    expect(box(view.container).indeterminate).toBe(true);
    await act(async () => box(view.container).click());
    expect(writes).toEqual(["1"]);
    expect(saving(view.container)).toBe("false");
    expect(box(view.container).checked).toBe(false);
    expect(box(view.container).indeterminate).toBe(true);
    expect(view.container.querySelector('[data-testid="param-1-outside"]')).not.toBeNull();
  });

  test("a click whose write is taken sets 1, then 0, and no longer names a value outside the type", async () => {
    const writes: string[] = [];
    const view = mount(<Page initial="2" accept writes={writes} />);
    await act(async () => box(view.container).click());
    expect(saving(view.container)).toBe("false");
    expect(box(view.container).checked).toBe(true);
    expect(box(view.container).indeterminate).toBe(false);
    expect(view.container.querySelector('[data-testid="param-1-outside"]')).toBeNull();
    await act(async () => box(view.container).click());
    expect(box(view.container).checked).toBe(false);
    expect(box(view.container).indeterminate).toBe(false);
    expect(writes).toEqual(["1", "0"]);
  });
});
