// The UI drive channel: it exercises the SAME lifecycle steps as the API client, but through the
// real web app in a real browser (Playwright + Chromium), so the user-facing path — the one a
// human actually clicks — is what the regression proves, with its own failure modes (dynamic
// parameter visibility, the param editors, the flash/commission dialogs). Assertions still go
// through the API (the single source of truth the UI renders); the browser is DRIVEN, never asked
// to confirm itself. See docs/e2e-smoke-framework.md §5.
//
// The web app is already instrumented for this: config rows carry `data-testid="param-<refId>"`
// and the GA picker `data-testid="link-<comObjNumber>"`, the commission dialog carries
// `commission-*`. No UI change was needed. Requires `bun run dev:web` (Vite) up.
import { chromium, type Browser, type Page } from "playwright";

export class UiDriver {
  private browser: Browser | null = null;
  private page: Page | null = null;
  constructor(private readonly base = process.env.BUSFORGE_WEB ?? "http://localhost:5173") {}

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage();
  }
  async close(): Promise<void> {
    if (this.browser) { try { await this.browser.close(); } catch { /* already gone */ } this.browser = null; this.page = null; }
  }
  private req(): Page { if (!this.page) throw new Error("UI driver not launched"); return this.page; }

  // Navigate to a device's configuration page and wait for it to render.
  async gotoDevice(projectId: string, deviceId: string): Promise<void> {
    const page = this.req();
    await page.goto(`${this.base}/projects/${projectId}/devices/${deviceId}`, { waitUntil: "networkidle" });
    // The config view is up once its search box (always present) is in the DOM.
    await page.waitForSelector('[data-testid="config-search"]', { timeout: 15_000 });
  }

  // Set a parameter through its editor. An enum is a native <select> (selectOption); a number or
  // text parameter is an <input> that commits on blur. The param may be revealed only after an
  // earlier one is set, so wait for its control to appear.
  async setParam(refId: string, value: string): Promise<void> {
    const page = this.req();
    const sel = `[data-testid="param-${refId}"]`;
    await page.waitForSelector(sel, { timeout: 15_000 });
    const tag = await page.$eval(sel, (el) => el.tagName.toLowerCase());
    if (tag === "select") {
      await page.selectOption(sel, value);
    } else {
      await page.fill(sel, value);
      await page.press(sel, "Tab"); // blur to commit (onBlur mutation)
    }
    // The edit is a mutation that re-renders the config (dynamic visibility); let it settle.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
  }

  // Link a com-object to a group address through the GA picker. The GA must already exist as a
  // project group address (the runner creates it), so it appears as an option to select.
  async linkGa(comObjNumber: number, gaAddress: string): Promise<void> {
    const page = this.req();
    const trigger = `[data-testid="link-${comObjNumber}"]`;
    await page.waitForSelector(trigger, { timeout: 15_000 });
    await page.click(trigger);           // open the popover
    await page.click(trigger);           // GaCombobox mounts the popover on first click; a second opens it
    await page.getByRole("option", { name: new RegExp(`^${gaAddress.replace(/[/]/g, "\\/")}\\b`) }).first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
  }
}
