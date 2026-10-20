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
import type { DeviceReadbackInfo } from "../../packages/product/src/index.ts";

// The web app's two flash targets (see FlashDialog.tsx). Kept local so this driver stays
// decoupled from the web bundle; a rename on either side is caught by the runner's own use.
export type FlashTarget = "params" | "ga";
// Every dialog in the app is a Radix AlertDialog; its content carries this stable slot attribute
// (role="alertdialog" is also set, but the slot is guaranteed by the shared component). The drivers
// scope their "is the bus op still running?" polling to it, never to the whole page.
const DIALOG = '[data-slot="alert-dialog-content"]';

// Whether a text names the group address as a whole: "1/3/2" is not named by "1/3/21" or "11/3/2".
export function namesAddress(text: string, gaAddress: string): boolean {
  return new RegExp("(?<![0-9/])" + gaAddress.replace(/[/]/g, "\\/") + "(?![0-9/])").test(text);
}

// How a display parameter's row (TypeNone: a heading or note, no value) shows the parameter's name:
// in its text; only as the row's tooltip, as a grid cell carries its label (the page sets that from
// the name, so it proves the row exists, not that the name is on screen); "blank" for a parameter
// without a name, whose row shows nothing; null when the row shows another text. Whitespace is
// compared collapsed, as an author's line breaks and indent spaces render.
export function displayNameShown(rowText: string, rowTitle: string | null, name: string): "text" | "tooltip" | "blank" | null {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const want = norm(name);
  if (want === "") return "blank";
  if (norm(rowText).includes(want)) return "text";
  return norm(rowTitle ?? "") === want ? "tooltip" : null;
}

// The language the page renders in, as the web app sets it on <html lang>: the click-through's expected
// names (a display parameter's heading) come from the server in this language, since a catalogue names
// a parameter differently per language.
export function pageLanguage(htmlLang: string): "en" | "de" {
  if (htmlLang === "en" || htmlLang === "de") return htmlLang;
  throw new Error(`click-through: the page names no language it renders in (html lang "${htmlLang}")`);
}

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

  async pageLang(): Promise<"en" | "de"> { return pageLanguage(await this.req().evaluate(() => document.documentElement.lang)); }

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
    // click would toggle it shut.
    await page.click(trigger);
    await this.pickGa(gaAddress);
  }

  // Add a group address behind a com-object's `ownCount` own addresses through the device page's
  // editor: with one address its "add another" button opens the add picker, with several the add
  // picker is on the list. Done when the editor lists the address at position `ownCount`; a secured
  // address the edit would turn plain opens a confirmation instead, which stops the run.
  async addGa(comObjNumber: number, gaAddress: string, ownCount: number): Promise<void> {
    const page = this.req();
    await page.waitForSelector(`[data-testid="link-${comObjNumber}"]`, { timeout: 15_000 });
    const more = page.locator(`[data-testid="link-${comObjNumber}-more"]`);
    if (await more.count()) await more.click();
    else await page.click(`[data-testid="link-${comObjNumber}-add"]`);
    await this.pickGa(gaAddress);
    const placed = page.locator(`[data-testid="link-${comObjNumber}-ga-${ownCount}"]`).filter({ hasText: gaAddress });
    const removable = page.locator(`[data-testid="link-${comObjNumber}-remove-${ownCount}"]:not([disabled])`);
    const plain = page.locator('[data-testid="confirm-plain-link"]');
    for (const until = Date.now() + 15_000; Date.now() < until; await page.waitForTimeout(250)) {
      if (await plain.count()) throw new Error(`adding ${gaAddress} to object ${comObjNumber}: the editor asks to turn a secured address plain`);
      if (await placed.count() && await removable.count()) return;
    }
    throw new Error(`adding ${gaAddress} to object ${comObjNumber}: the editor does not list it behind the object's ${ownCount} own address(es) within 15 s`);
  }

  // Remove the address at `index` from a com-object's list in the device page's editor, after checking
  // it is the one listed there. Done when the server stored the edit; a refusal stops the run with its
  // code.
  async removeGa(comObjNumber: number, gaAddress: string, index: number): Promise<void> {
    const page = this.req();
    // The row's text runs the address's name and the address together; the remove button names the
    // address alone in its label.
    const button = page.locator(`[data-testid="link-${comObjNumber}-remove-${index}"]`);
    await button.waitFor({ state: "visible", timeout: 15_000 });
    const label = (await button.getAttribute("aria-label")) ?? "";
    if (!namesAddress(label, gaAddress)) throw new Error(`removing ${gaAddress} from object ${comObjNumber}: the remove button at position ${index} is labelled "${label}"`);
    await this.stored("/links", () => button.click(), `removing ${gaAddress} from object ${comObjNumber}`);
  }

  // Set one flag of a com-object in the device page's flag editor (a popover on the object's row). Done
  // when the server stored the edit; a refusal stops the run with its code. The popover is closed again
  // so it covers nothing.
  async setFlag(comObjNumber: number, flag: string, want: boolean): Promise<void> {
    const page = this.req();
    const box = page.locator(`[data-testid="flags-${comObjNumber}-${flag}"]`);
    await page.click(`[data-testid="flags-${comObjNumber}"]`);
    await box.waitFor({ state: "visible", timeout: 10_000 });
    try {
      if ((await box.isChecked()) !== want) await this.stored("/comobject-flags", () => box.click(), `setting the ${flag} flag of object ${comObjNumber}`);
    } finally {
      await page.keyboard.press("Escape");
      await box.waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    }
  }

  // Run an edit and wait for the device page's PUT to `path` it sends; a refused one throws with the
  // server's error code, which the page itself only shows as a toast.
  private async stored(path: string, act: () => Promise<void>, what: string): Promise<void> {
    const page = this.req();
    const res = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname.endsWith(path), { timeout: 15_000 });
    res.catch(() => undefined);
    await act();
    const r = await res.catch(() => null);
    if (!r) throw new Error(`${what}: the page sent no edit within 15 s`);
    if (!r.ok()) {
      const body = (await r.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new Error(`${what}: the server refused it (${body?.error?.code ?? r.status()}: ${body?.error?.message ?? ""})`);
    }
  }

  // Type the address into the open picker's search to filter, then pick the single match. The
  // option label renders both the GA name and its address, so match the address as a substring.
  private async pickGa(gaAddress: string): Promise<void> {
    const page = this.req();
    const search = page.getByPlaceholder(/gruppenadresse|group address|suchen|search/i);
    await search.waitFor({ state: "visible", timeout: 10_000 });
    await search.fill(gaAddress);
    // Match the address but NOT a longer one that contains it: filtering "1/1/1" still leaves
    // "1/1/10" and "11/1/1" in the list, so forbid a digit or slash on either side.
    await page.getByRole("option", { name: new RegExp("(?<![0-9/])" + gaAddress.replace(/[/]/g, "\\/") + "(?![0-9/])") }).first().click();
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

  // A surgical or structural flash: open, confirm the previewed diff, wait for the write to verify.
  // Returns whether the preview was a structural write. Throws if the dialog offers no flash (in sync,
  // or refused as com-object-table stale — use flashDownload then).
  async flash(target: FlashTarget | "both" = "both"): Promise<{ structural: boolean }> {
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
      const structural = !!(await page.$('[data-testid="flash-part-structural"]'));
      await page.click('[data-testid="confirm-flash"]');
      await this.awaitSettled('[data-testid="flash-part-ok"], [data-testid="flash-part-fail"]');
      if (await page.$('[data-testid="flash-part-fail"]')) throw new Error(`flash: not verified — ${await this.dialogText()}`);
      if (!(await page.$('[data-testid="flash-part-ok"]'))) throw new Error("flash: no verified target after the write");
      return { structural };
    } finally { await this.dismiss().catch(() => undefined); }
  }

  // The FlashDialog's full download on the device's existing address: offered as the way forward when
  // the surgical flash is refused (COM_OBJECT_TABLE_STALE_USE_DOWNLOAD, a never-programmed device), and
  // otherwise as the full-download action next to the flash.
  async flashDownload(target: FlashTarget = "params"): Promise<void> {
    const page = this.req();
    await this.openFlash(target);
    try { // dismiss in finally: a dialog left open on failure blocks the next capability (see flash()).
      const offer = '[data-testid="flash-needs-download"], [data-testid="flash-full-download"]';
      try { await this.awaitSettled(offer); }
      catch { throw new Error(`flashDownload: the dialog offers no full download — ${await this.dialogText()}`); }
      await page.click((await page.$('[data-testid="flash-needs-download"]')) ? '[data-testid="flash-needs-download"]' : '[data-testid="flash-full-download"]');
      // The offer dry-runs the download first; confirm it once the preview is ready. The offer shows
      // only after the dialog's own previews have answered, so nothing waits ahead of it on the bus; a
      // download preview that reads the unit (partial form) takes about 105 s on a Data Secure device.
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
  // Returns what the read covered, taken from the response the page itself received (null if none).
  async readBack(): Promise<DeviceReadbackInfo | null> {
    const page = this.req();
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/read-back"), { timeout: 600_000 });
    response.catch(() => undefined);
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
    // The spinner clears when the response arrived; if it cleared without one, do not wait out the
    // full read budget for a response that is not coming.
    const late = new Promise<null>((r) => setTimeout(() => r(null), 15_000));
    const body = await Promise.race([response.then((r) => (r.ok() ? r.json() : null)).catch(() => null), late]) as { readback?: DeviceReadbackInfo } | null;
    return body?.readback ?? null;
  }

  // Assert every parameter and com-object the API exposes has a rendered, visible row. The expected
  // refs/numbers come from the API config (allParams / allComObjects), so this proves the UI renders
  // exactly what the source of truth holds, no hidden husks. Fails on the first row that is missing.
  // A display parameter (`display` = its name) has no value: its value cell stays empty, and its row
  // must be visible and show the name. Returns how many display rows carry the name only as a
  // tooltip, and how many have no name to show, for the run's detail.
  async clickThrough(expectParams: { refId: string; display?: string }[], expectLinks: number[]): Promise<{ tooltipOnly: number; blank: number }> {
    const page = this.req();
    const shown = { tooltipOnly: 0, blank: 0 };
    for (const { refId: ref, display } of expectParams) {
      const loc = page.locator(`[data-testid="param-${ref}"]`).first();
      if (!(await loc.count())) throw new Error(`click-through: parameter row not rendered: ${ref}`);
      if (display !== undefined) {
        const row = loc.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-l-2 ')][1]");
        if (!(await row.count())) throw new Error(`click-through: display parameter row container not found: ${ref}`);
        if (!(await row.isVisible())) throw new Error(`click-through: display parameter row present but hidden: ${ref}`);
        const how = displayNameShown(await row.innerText(), await row.getAttribute("title"), display);
        if (how === null) throw new Error(`click-through: display parameter row does not show its name: ${ref}`);
        if (how === "tooltip") shown.tooltipOnly++;
        if (how === "blank") shown.blank++;
        continue;
      }
      if (!(await loc.isVisible())) throw new Error(`click-through: parameter row present but hidden: ${ref}`);
    }
    for (const num of expectLinks) {
      const loc = page.locator(`[data-testid="link-${num}"]`).first();
      if (!(await loc.count())) throw new Error(`click-through: link row not rendered for com-object ${num}`);
      if (!(await loc.isVisible())) throw new Error(`click-through: link row present but hidden for com-object ${num}`);
    }
    return shown;
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
