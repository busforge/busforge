import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HeaderWarning } from "./HeaderWarning.tsx";

describe("a standing warning of the device page header", () => {
  test("is a warning mark that opens its points, with their count and the full title", () => {
    const html = renderToStaticMarkup(<HeaderWarning label="Not written" title="What Busforge does not write to this device" items={["Full download: a reason", "Flags: another"]} testId="device-refusals" />);
    expect(new RegExp('<button[^>]*data-testid="device-refusals"').test(html)).toBe(true);
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('title="What Busforge does not write to this device"');
    expect(html).toContain(">2</span>");
  });

  test("shows a count it is given, and none where the count is not known", () => {
    const counted = renderToStaticMarkup(<HeaderWarning label="Links not shown" title="t" items={["seven links"]} count={7} testId="link-gaps-notice" />);
    expect(counted).toContain(">7</span>");
    const unknown = renderToStaticMarkup(<HeaderWarning label="Links not shown" title="t" items={["not counted"]} count={null} testId="link-gaps-notice" />);
    expect(unknown).not.toContain("font-mono");
  });

  test("is not shown when there is nothing to warn about", () => {
    expect(renderToStaticMarkup(<HeaderWarning label="Not compared" title="x" items={[]} testId="readback-unsupported" />)).toBe("");
  });
});
