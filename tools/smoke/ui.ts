// The UI drive channel: it exercises the SAME lifecycle steps as the API client, but through the
// real web app in a real browser (Playwright + Chromium), so the user-facing path — the one a
// human actually clicks — is what the regression proves, with its own failure modes (dynamic
// parameter visibility, the param editors, the flash/commission dialogs). Assertions still go
// through the API (the single source of truth the UI renders); the browser is DRIVEN, never asked
// to confirm itself. See docs/testing.md.
//
// The web app is already instrumented for this: config rows carry `data-testid="param-<refId>"`
// and the GA picker `data-testid="link-<comObjNumber>"`, the commission dialog carries
// `commission-*`. No UI change was needed. Requires `bun run dev:web` (Vite) up.
import { chromium, type Browser, type Page } from "playwright";

// The web app's two flash targets (see FlashDialog.tsx). Kept local so this driver stays
// decoupled from the web bundle; a rename on either side is caught by the runner's own use.
export type FlashTarget = "params" | "ga";
// Every dialog in the app is a Radix AlertDialog; its content carries this stable slot attribute
// (role="alertdialog" is also set, but the slot is guaranteed by the shared component). The drivers
// scope their "is the bus op still running?" polling to it, never to the whole page.
const DIALOG = '[data-slot="alert-dialog-content"]';

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
    // The light trigger mounts AND opens the popover in one click (setActive+setOpen); a second
    // click would toggle it shut. Type the address to filter, then pick the single match. The
    // option label renders both the GA name and its address, so match the address as a substring.
    await page.click(trigger);
    const search = page.getByPlaceholder(/gruppenadresse|group address|suchen|search/i);
    await search.waitFor({ state: "visible", timeout: 10_000 });
    await search.fill(gaAddress);
    // Match the address but NOT a longer one that shares this prefix: filtering "1/1/1" still leaves
    // "1/1/10", "1/1/11", … in the list, so forbid a digit or slash right after (tail-anchor).
    await page.getByRole("option", { name: new RegExp(gaAddress.replace(/[/]/g, "\\/") + "(?![0-9/])") }).first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
  }

  // ── flash / commission / click-through drivers ─────────────────────────────
  // These drive the real programming dialogs. Each dialog runs a bus operation server-side; the
  // driver's job is to steer the flow and wait for it to SETTLE (so the single-channel bench tunnel
  // is free again before the runner reads back over the API). The verified/correct verdict is the
  // API read-back's (the browser is driven, never asked to confirm itself); the driver only fails
  // loud when the UI path itself surfaces an error, which an API read alone would not attribute to
  // the UI. Outcome testids (flash-part-ok/fail, commission-ok/fail, …) mark the settled states.

  // Open the flash dialog for a target. "both" is the primary programme button; a single target
  // uses the split-button menu where it exists (a device with only one flashable target has no
  // menu, and its main button already flashes that target).
  private async openFlash(target: FlashTarget | "both"): Promise<void> {
    const page = this.req();
    if (target === "both" || !(await page.$('[data-testid="flash-menu"]'))) {
      await page.click('[data-testid="program-device"]');
      await page.waitForSelector(DIALOG, { timeout: 10_000 });
      return;
    }
    // The flash split-button's menu is a Radix DropdownMenu: the target item mounts in a portal only
    // after the trigger opens it, with an entrance transition. Clicking trigger and item back-to-back
    // races that mount, and a click that lands while the menu is still animating in can be dropped or
    // dismiss the menu (the bench symptom: a 30 s timeout on flash-only-params). Open, wait for the
    // item to be actually visible, then select it; if the dialog does not appear the open did not take
    // (a swallowed click), so retry the whole open-and-select a few times before failing loud.
    const item = page.locator(`[data-testid="flash-only-${target}"]`);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.click('[data-testid="flash-menu"]');
        await item.waitFor({ state: "visible", timeout: 5_000 });
        await item.click();
        await page.waitForSelector(DIALOG, { timeout: 10_000 });
        return;
      } catch (e) {
        lastErr = e;
        await page.keyboard.press("Escape").catch(() => undefined); // close a half-open menu before retrying
        await page.waitForTimeout(300);
      }
    }
    throw new Error(`openFlash: could not open the ${target} flash dialog via the split-button menu — ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  // A surgical flash: open, confirm the previewed diff, wait for the write to verify. Throws if the
  // dialog offers no flash (in sync, or refused as com-object-table stale — use flashDownload then).
  async flash(target: FlashTarget | "both" = "both"): Promise<void> {
    const page = this.req();
    await this.openFlash(target);
    // Dismiss the dialog whether this settles or throws: a dialog left open on a failure covers the
    // page with a modal overlay that intercepts every click, so the NEXT capability would fail on the
    // overlay, not on its own merits (a cascade that hides the real first failure).
    try {
      // Wait for EVERY target's preview to settle before deciding. The dialog dry-runs the targets
      // SEQUENTIALLY and shows the flash button as soon as the FIRST target has a diff, while a later
      // target is still checking; clicking then would flash only that first target and miss the rest.
      // awaitSettled gates on no checking spinner, and flash-part-insync marks an already-in-sync target
      // so an all-in-sync dialog settles too (rather than hanging on a button that never appears).
      try {
        await this.awaitSettled('[data-testid="confirm-flash"], [data-testid="flash-needs-download"], [data-testid="flash-part-fail"], [data-testid="flash-part-insync"]');
      } catch { throw new Error(`flash: the dialog never settled a preview — ${await this.dialogText()}`); }
      if (await page.$('[data-testid="flash-needs-download"]')) throw new Error("flash: refused as com-object-table stale; use flashDownload()");
      if (await page.$('[data-testid="flash-part-fail"]')) throw new Error(`flash: dry-run failed — ${await this.dialogText()}`);
      if (!(await page.$('[data-testid="confirm-flash"]'))) throw new Error(`flash: nothing to program (every target already in sync) — ${await this.dialogText()}`);
      await page.click('[data-testid="confirm-flash"]');
      await this.awaitSettled('[data-testid="flash-part-ok"], [data-testid="flash-part-fail"]');
      if (await page.$('[data-testid="flash-part-fail"]')) throw new Error(`flash: not verified — ${await this.dialogText()}`);
      if (!(await page.$('[data-testid="flash-part-ok"]'))) throw new Error("flash: no verified target after the write");
    } finally { await this.dismiss().catch(() => undefined); }
  }

  // The FlashDialog full-download route: a change that rewrites the com-object table is refused as a
  // surgical flash (COM_OBJECT_TABLE_STALE_USE_DOWNLOAD) and the dialog offers a full download on the
  // device's existing address. The caller must have made that change first (params/links).
  async flashDownload(target: FlashTarget = "params"): Promise<void> {
    const page = this.req();
    await this.openFlash(target);
    try { // dismiss in finally: a dialog left open on failure blocks the next capability (see flash()).
      try { await page.waitForSelector('[data-testid="flash-needs-download"]', { timeout: 60_000 }); }
      catch { throw new Error(`flashDownload: no full-download offer (change does not alter the table?) — ${await this.dialogText()}`); }
      await page.click('[data-testid="flash-needs-download"]');
      // The offer dry-runs the download first; confirm it once the preview is ready.
      await page.waitForSelector('[data-testid="confirm-download"], [data-testid="flash-dl-fail"], [data-testid="flash-download-retry"]', { timeout: 180_000 });
      if (!(await page.$('[data-testid="confirm-download"]'))) throw new Error(`flashDownload: preview failed — ${await this.dialogText()}`);
      await page.click('[data-testid="confirm-download"]');
      await this.awaitSettled('[data-testid="flash-dl-ok"], [data-testid="flash-dl-fail"]');
      if (await page.$('[data-testid="flash-dl-fail"]')) throw new Error(`flashDownload: not verified — ${await this.dialogText()}`);
    } finally { await this.dismiss().catch(() => undefined); }
  }

  // Commission from the device menu: scan for programming mode, assign the IA, full download. The
  // scan needs the operator to have pressed the programming button; onPrompt is called each time we
  // are still waiting for exactly one device, and the driver rescans until one appears (or times out).
  async commission(onPrompt: (msg: string) => void = (m) => console.log(m)): Promise<void> {
    const page = this.req();
    await page.click('[data-testid="device-menu"]');
    await page.click('[data-testid="commission-device"]');
    await page.waitForSelector(DIALOG, { timeout: 10_000 });
    await page.waitForTimeout(500); // let the dialog's own scan-on-open start before we inspect it
    try { // dismiss in finally: a dialog left open on failure blocks the next capability (see flash()).
      const deadline = Date.now() + 300_000;
      for (;;) {
        // Wait out any in-flight scan (the dialog spins while scanning), then decide on its result.
        await this.awaitSettled('[data-testid="commission-assign"], [data-testid="commission-rescan"]');
        if (await page.$('[data-testid="commission-assign"]')) break; // exactly one device in prog mode
        if (Date.now() > deadline) throw new Error("commission: no single device in programming mode within the wait window");
        onPrompt("press the programming button on the device (exactly one), then re-scanning…");
        await page.click('[data-testid="commission-rescan"]');
        await page.waitForTimeout(1500);
      }
      await page.click('[data-testid="commission-assign"]');
      // The download CTA appears only after the assign VERIFIED and its preview dry-run is ready; if it
      // never does, the assign or preview failed (its line shows the reason).
      await page.waitForSelector('[data-testid="commission-download"], [data-testid="commission-fail"], [data-testid="commission-recheck"]', { timeout: 180_000 });
      if (!(await page.$('[data-testid="commission-download"]'))) throw new Error(`commission: assign/preview failed — ${await this.dialogText()}`);
      await page.click('[data-testid="commission-download"]');
      await this.awaitSettled('[data-testid="commission-ok"], [data-testid="commission-fail"]');
      if (await page.$('[data-testid="commission-fail"]')) throw new Error(`commission: not verified — ${await this.dialogText()}`);
    } finally { await this.dismiss().catch(() => undefined); }
  }

  // Trigger a read-back through the config page's own button (the read-back UI surface) and wait for
  // it to finish (the button spins while the read runs). The decode/drift assertion is the caller's,
  // read from the API; this only drives the button and waits out the bus read.
  async readBack(): Promise<void> {
    const page = this.req();
    await page.click('[data-testid="read-back"]');
    // Wait for the read to START (the button's spinner mounts) so the finish-check below cannot see
    // the pre-spinner frame and resolve immediately; if the read is instant the appear-wait simply
    // times out and we fall through.
    await page.waitForSelector('[data-testid="read-back"] .animate-spin', { timeout: 10_000 }).catch(() => undefined);
    // The button holds a spinner for the whole read; wait for it to clear (a large device reads for
    // minutes on the single-channel bench, hence the generous budget).
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="read-back"]');
      return !!b && !b.querySelector(".animate-spin");
    }, undefined, { timeout: 600_000, polling: 500 });
  }

  // Assert every parameter and com-object the API exposes has a rendered, visible row. The expected
  // refs/numbers come from the API config (allParams / allComObjects), so this proves the UI renders
  // exactly what the source of truth holds, no hidden husks. Fails on the first row that is missing.
  async clickThrough(expectParams: string[], expectLinks: number[]): Promise<void> {
    const page = this.req();
    for (const ref of expectParams) {
      const loc = page.locator(`[data-testid="param-${ref}"]`).first();
      if (!(await loc.count())) throw new Error(`click-through: parameter row not rendered: ${ref}`);
      if (!(await loc.isVisible())) throw new Error(`click-through: parameter row present but hidden: ${ref}`);
    }
    for (const num of expectLinks) {
      const loc = page.locator(`[data-testid="link-${num}"]`).first();
      if (!(await loc.count())) throw new Error(`click-through: link row not rendered for com-object ${num}`);
      if (!(await loc.isVisible())) throw new Error(`click-through: link row present but hidden for com-object ${num}`);
    }
  }

  // Wait until a bus op in the open dialog has SETTLED: no spinner is left running AND at least one
  // terminal outcome line (the given ok/fail testids) is present. A long download can run for
  // minutes, so the budget is generous; the poll is scoped to the dialog so a spinner elsewhere on
  // the page cannot hold it open.
  private async awaitSettled(terminalSelector: string): Promise<void> {
    const page = this.req();
    await page.waitForFunction(
      ({ dialog, terminal }) => {
        const d = document.querySelector(dialog);
        if (!d) return false;
        return !d.querySelector(".animate-spin") && !!d.querySelector(terminal);
      },
      { dialog: DIALOG, terminal: terminalSelector },
      { timeout: 600_000, polling: 500 },
    );
  }

  // Read the open dialog's text, condensed, for a failure message. Best-effort: a closed/absent
  // dialog yields a placeholder rather than throwing over the real error being reported.
  private async dialogText(): Promise<string> {
    const page = this.req();
    const txt = await page.textContent(DIALOG).catch(() => null);
    return txt ? txt.trim().replace(/\s+/g, " ").slice(0, 300) : "(no dialog)";
  }

  // Close a finished dialog so its tunnel is released before the next bus op. Escape triggers the
  // AlertDialog's onOpenChange (allowed once no bus op is running); if it lingers, we do not block.
  private async dismiss(): Promise<void> {
    const page = this.req();
    await page.keyboard.press("Escape");
    await page.waitForSelector(DIALOG, { state: "detached", timeout: 10_000 }).catch(() => undefined);
  }
}
