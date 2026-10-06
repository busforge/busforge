// The channel-aware write primitives shared by the capability drivers and the behaviour verifiers.
// Each does the SAME thing over `api` (production endpoints) or `ui` (the real web app in Chromium);
// the caller picks once and every step follows. A refusal is a real outcome and is thrown, never
// retried away — that is the regression the smoke framework exists to catch. See /GLOSSARY.md.
import { ApiError, type Client, type FlashResult } from "./client.ts";
import type { UiDriver } from "./ui.ts";
import type { Channel } from "./spec.ts";

export interface ChanCtx {
  client: Client;
  ui: UiDriver | null; // present iff channel === "ui"
  pid: string;
  did: string;
  channel: Channel;
  log: (m: string) => void;
  settle: (ms: number) => Promise<void>;
}

const STALE = "COM_OBJECT_TABLE_STALE_USE_DOWNLOAD";
export const isStale = (e: unknown): boolean =>
  (e instanceof ApiError && e.code === STALE) || (e instanceof Error && /com-object-table stale/i.test(e.message));
// The UI flash driver throws when the dialog offers nothing to write (every target already in sync);
// the API path returns `unchanged` gracefully for the same case. Recognise the UI throw so both
// channels treat "nothing to program" as a no-op, not a failure.
const isInSync = (e: unknown): boolean => e instanceof Error && /nothing to program|already in sync/i.test(e.message);

// Set a parameter: UI drives the editor, API hits the params endpoint.
export async function setParamChan(ctx: ChanCtx, paramRefId: string, value: string): Promise<void> {
  if (ctx.channel === "ui") await ctx.ui!.setParam(paramRefId, value);
  else await ctx.client.setParam(ctx.pid, ctx.did, paramRefId, value);
}

// Link a com-object to a group address. The GA is ensured as a project group address first (the UI
// picker only offers those; harmless on the API path), then linked by number (UI) or ref (API). On
// the ui channel the page must be reloaded after ensureGa: the app reads the project's group-address
// list once at load, so a GA created afterwards is absent from the picker's cache and the option
// would never appear (a 30 s click timeout). The reload re-fetches the list; the linkable state (the
// baseline params) is persisted, so it survives the reload.
export async function linkChan(ctx: ChanCtx, obj: { refId: string; number: number }, ga: string): Promise<void> {
  await ctx.client.ensureGa(ctx.pid, ga);
  if (ctx.channel === "ui") { await ctx.ui!.gotoDevice(ctx.pid, ctx.did); await ctx.ui!.linkGa(obj.number, ga); }
  else await ctx.client.link(ctx.pid, ctx.did, obj.refId, ga);
}

// Flash the parameter segment. Returns whether the change was written as a structural flash (it alters
// the com-object table and the family writes that with the group tables in one bracket), or ROUTED to a
// full download because the family cannot (the server refuses the surgical flash as stale, and
// exercising that routing is part of the contract). A UI flash's success IS the server's verified
// verdict (the driver throws on a not-verified dialog); the API path checks FlashResult.verified.
export async function flashParamsChan(ctx: ChanCtx, label: string): Promise<{ result?: FlashResult; routed: boolean; structural: boolean }> {
  if (ctx.channel === "ui") {
    try { const { structural } = await ctx.ui!.flash("params"); return { routed: false, structural }; }
    catch (e) {
      if (isInSync(e)) return { routed: false, structural: false }; // nothing to write, same as the API `unchanged` path
      if (!isStale(e)) throw e;
      ctx.log(`${label}: alters the com-object table → full download (ui)`);
      await ctx.ui!.flashDownload("params");
      return { routed: true, structural: false };
    }
  }
  try {
    const dry = await ctx.client.flashDry(ctx.pid, ctx.did);
    if (dry.kind !== "dryRun") return { result: dry, routed: false, structural: false }; // in sync: nothing to write
    const result = await ctx.client.flashReal(ctx.pid, ctx.did, (p) => ctx.log(`${label} ${p}`));
    if (result.kind !== "flashed" || result.verified !== true) throw new Error(`${label}: not verified (${result.kind}, verified=${result.verified})`);
    return { result, routed: false, structural: result.structural === true };
  } catch (e) {
    if (!isStale(e)) throw e;
    ctx.log(`${label}: alters the com-object table → full download (api)`);
    const result = await ctx.client.downloadReal(ctx.pid, ctx.did, (p) => ctx.log(`${label} download ${p}`));
    if (result.kind !== "flashed" || result.verified !== true) throw new Error(`${label}: routed download not verified (${result.kind}, verified=${result.verified})`);
    return { result, routed: true, structural: false };
  }
}

// Flash the group/association tables. UI success is the verified verdict; API checks it explicitly.
export async function flashGaChan(ctx: ChanCtx, label: string): Promise<void> {
  if (ctx.channel === "ui") { await ctx.ui!.flash("ga"); return; }
  const r = await ctx.client.flashGaReal(ctx.pid, ctx.did, (p) => ctx.log(`${label} ${p}`));
  if (r.kind !== "flashed" || r.verified !== true) throw new Error(`${label}: flash-ga not verified (${r.kind}, verified=${r.verified})`);
}
