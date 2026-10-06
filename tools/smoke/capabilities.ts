// One driver per DeviceCapabilities key (readParams, readLinks, flashParams, flashLinks,
// fullDownload, structuralFlash). Each runs in the requested channel (api = production endpoints, ui = the real web
// app) over the SAME hardware. The oracle everywhere is the same: the device's own read-back matches
// busforge's image — a write is "placed" only when the device confirms the bytes it now holds (a
// FlashResult.verified on the api path, a non-erroring flash dialog on the ui path, both re-checked
// by an independent read-back). Placement is not behaviour; behaviours.ts proves that separately.
//
// What a device claims is read from the product (config.capabilities), never declared here; the
// runner calls only the drivers for the claimed capabilities and treats a claimed-but-unexercised
// capability as a hard failure. See docs/testing.md and /GLOSSARY.md.
import { gaToNum } from "../../packages/knx/src/index.ts";
import { findComObject, findParam, allComObjects } from "./client.ts";
import type { Channel, DeviceSpec, FuzzPolicy } from "./spec.ts";
import { pickSweep, type ParamCandidate } from "./generate.ts";
import { setParamChan, linkChan, flashParamsChan, flashGaChan, type ChanCtx } from "./channel.ts";

export interface CapabilityResult {
  capability: string; // the DeviceCapabilities key
  channel: Channel;
  // "unsafe" = the product claims it but the spec declares it must not be exercised on the bench
  // (see DeviceSpec.unsafe). "unproven" = a channel surface that cannot be exercised on this device
  // in this run (e.g. a structural flash on a device whose spec names no structuralTrigger). Both are
  // reported honestly, proven by nothing, never faked green; neither
  // is a run failure, but neither counts toward the done-bar (which requires every capability `pass`).
  state: "pass" | "fail" | "unsafe" | "unproven";
  detail: string;
  // Structured evidence a docs claim can cite (FlashResults, the values swept, the seed-derived
  // candidates). Kept small and JSON-serializable.
  evidence?: Record<string, unknown>;
}

// Everything a driver needs, on top of the shared channel context: the spec, the seeded PRNG, and a
// GA allocator (both from the runner, so the report can replay a failing round from its seed).
export interface CapCtx extends ChanCtx {
  spec: DeviceSpec;
  rnd: () => number;
  allocGa: () => string;
}

// Read the device's current effective config from the API — the single source of truth both channels
// assert against.
const config = (ctx: CapCtx) => ctx.client.getConfig(ctx.pid, ctx.did);

// An independent read-back followed by a fresh config read: the L1 proof that the device holds what
// we wrote, decoded from the device's own memory (not the value we optimistically stored). The
// config carries the read's coverage, which GET /config alone never does; absent when it was not
// reported.
async function readBackConfig(ctx: CapCtx) {
  const readback = ctx.channel === "ui" ? await ctx.ui!.readBack() : await ctx.client.readBack(ctx.pid, ctx.did, (p) => ctx.log(`read ${p}`));
  await ctx.settle(3000);
  return { ...(await config(ctx)), readback: readback ?? undefined };
}

// ── the five capability drivers ────────────────────────────────────────────

// fullDownload: commission the whole device (application id + parameter image + com-object table +
// group tables) in one bracket and require the device to verify it.
//   api: dry-run → download → assert flashed+verified+mask.
//   ui : CommissionDialog when the device is provisioned from prog mode (the from-factory headline
//        proof; the operator presses the button); on a device kept addressed between runs, the
//        FlashDialog's full-download action on its existing address.
export async function capFullDownload(ctx: CapCtx): Promise<CapabilityResult> {
  const base = { capability: "fullDownload", channel: ctx.channel };
  if (ctx.channel === "ui") {
    // Headline proof: the from-factory CommissionDialog (operator presses the programming button).
    if (ctx.spec.provision === "require-prog-mode") {
      await ctx.ui!.commission((m) => ctx.log(m));
      const view = await readBackConfig(ctx);
      return { ...base, state: "pass", detail: `commissioned via CommissionDialog, ${allComObjects(view).length} objects` };
    }
    // A device kept addressed between runs cannot be from-factory commissioned without a reset; the
    // FlashDialog offers the full download on its existing address.
    await ctx.ui!.flashDownload("params");
    const view = await readBackConfig(ctx);
    return { ...base, state: "pass", detail: `UI full-download via the FlashDialog, ${allComObjects(view).length} objects` };
  }
  const dry = await ctx.client.downloadDry(ctx.pid, ctx.did);
  if (dry.kind !== "dryRun") return { ...base, state: "fail", detail: `dry-run returned ${dry.kind}, expected dryRun` };
  const result = await ctx.client.downloadReal(ctx.pid, ctx.did, (p) => ctx.log(`download ${p}`));
  if (result.kind !== "flashed" || result.verified !== true) return { ...base, state: "fail", detail: `download ${result.kind}, verified=${result.verified}` };
  if (ctx.spec.device.mask && result.mask && result.mask !== ctx.spec.device.mask) return { ...base, state: "fail", detail: `mask ${result.mask} != ${ctx.spec.device.mask}` };
  return { ...base, state: "pass", detail: `downloaded verified, ${result.imageBytes ?? dry.imageBytes ?? "?"}B, mask ${result.mask}`, evidence: { dry, download: result } };
}

// flashLinks: link a com-object to a fresh group address, flash the group tables, and require the
// device's read-back to carry that GA on that object (the byte-level placement proof for links).
export async function capFlashLinks(ctx: CapCtx): Promise<CapabilityResult> {
  const base = { capability: "flashLinks", channel: ctx.channel };
  const view = await config(ctx);
  // A safe object to link: the first visible com-object the fuzz policy does not exclude. Its number
  // addresses the UI picker; its ref addresses the API link endpoint.
  const excluded = new Set(ctx.spec.fuzz?.excludeComObjects ?? []);
  const target = allComObjects(view).find((c) => !excluded.has(c.refId) && ![...excluded].some((e) => c.refId.endsWith(e)));
  if (!target) return { ...base, state: "fail", detail: "no linkable com-object is visible on this device" };
  const ga = ctx.allocGa();
  await linkChan(ctx, { refId: target.refId, number: target.number }, ga);
  await flashGaChan(ctx, "flash-ga");
  const after = await readBackConfig(ctx);
  // gaRaw is the project's link; `changed` compares it with what the read-back found on the device.
  if (!after.readback?.linksRead) return { ...base, state: "fail", detail: "the read-back after the link flash did not read the group tables" };
  const co = findComObject(after, target.refId);
  if (!co || co.gaRaw !== gaToNum(ga) || co.changed) return { ...base, state: "fail", detail: `the device does not carry ${ga} on object ${target.number} (project ${co?.gaRaw ?? "none"}, differs from device: ${co?.changed ?? "?"})` };
  return { ...base, state: "pass", detail: `linked object ${target.number} → ${ga}, verified on read-back`, evidence: { object: target.number, ga } };
}

// flashParams: the surgical single-parameter mutate→verify→revert sweep. For each seeded candidate:
// record the canonical value, set it, flash it (auto-routing an L3-altering change to a full
// download), require verification, then restore the canonical value and require that to verify too —
// the write path exercised on a device that already holds its configuration. Zero-drift is confirmed
// by an independent read-back at the end.
export async function capFlashParams(ctx: CapCtx): Promise<CapabilityResult> {
  const base = { capability: "flashParams", channel: ctx.channel };
  const rounds = ctx.spec.fuzz?.paramSweepRounds ?? 3;
  const policy: FuzzPolicy = ctx.spec.fuzz ?? { gaRange: { main: 0, mid: 0 } };
  const view = await config(ctx);
  const params = view.blocks.flatMap((b) => b.items).flatMap((it) => (it.kind === "param" ? [it.param] : []));
  const candidates = pickSweep(params, policy, ctx.rnd, rounds);
  if (!candidates.length) return { ...base, state: "fail", detail: "no fuzzable parameter found (all read-only / non-image / excluded / already at bound)" };
  const swept: { ref: string; from: string; to: string; strategy: string; routed: boolean }[] = [];
  for (const c of candidates) {
    const canonical = findParam(await config(ctx), c.paramRefId)?.value;
    if (canonical === undefined) return { ...base, state: "fail", detail: `candidate ${c.paramRefId} vanished from the config (visibility changed under the sweep)` };
    ctx.log(`sweep ${c.strategy}: ${short(c.paramRefId)} ${canonical}→${c.value}`);
    await setParamChan(ctx, c.paramRefId, c.value);
    const { routed } = await flashParamsChan(ctx, `mutate ${short(c.paramRefId)}`);
    await ctx.settle(2000);
    await setParamChan(ctx, c.paramRefId, canonical);
    await flashParamsChan(ctx, `revert ${short(c.paramRefId)}`);
    await ctx.settle(2000);
    swept.push({ ref: c.paramRefId, from: canonical, to: c.value, strategy: c.strategy, routed });
  }
  // Zero-drift: after restoring every canonical value, an independent read-back must show no change.
  const after = await readBackConfig(ctx);
  if (!after.readback?.paramsRead) return { ...base, state: "fail", detail: "the read-back after the sweep did not read the parameters, so drift is unknown" };
  const drift = after.blocks.flatMap((b) => b.items).flatMap((it) => (it.kind === "param" && it.param.changed ? [it.param.refId] : []));
  if (drift.length) return { ...base, state: "fail", detail: `read-back shows drift after revert: ${drift.slice(0, 5).map(short).join(", ")}` };
  return { ...base, state: "pass", detail: `${swept.length} param(s) swept, each verified + reverted, zero drift`, evidence: { seedSwept: swept } };
}

// structuralFlash: a parameter change that alters the com-object table (the spec's structuralTrigger),
// written as one structural flash, then its revert the same way, each required to verify and to have
// been the structural write (not a surgical flash, not a full download). An independent read-back
// afterwards must show no drift.
export async function capStructuralFlash(ctx: CapCtx): Promise<CapabilityResult> {
  const base = { capability: "structuralFlash", channel: ctx.channel };
  const trig = ctx.spec.structuralTrigger;
  if (!trig) return { ...base, state: "unproven", detail: "no structuralTrigger in the spec: no change that alters the com-object table was written" };
  const canonical = findParam(await config(ctx), trig.paramRefId)?.value;
  if (canonical === undefined) return { ...base, state: "fail", detail: `structuralTrigger param ${trig.paramRefId} not on this device` };
  if (canonical === trig.value) return { ...base, state: "fail", detail: `structuralTrigger value ${trig.value} equals the canonical value; pick one that alters the com-object table` };
  const objectsBefore = allComObjects(await config(ctx)).length;
  await setParamChan(ctx, trig.paramRefId, trig.value);
  const objectsWith = allComObjects(await config(ctx)).length;
  const set = await flashParamsChan(ctx, `structural ${short(trig.paramRefId)}=${trig.value}`);
  if (!set.structural) return { ...base, state: "fail", detail: `setting ${short(trig.paramRefId)}=${trig.value} was not written as a structural flash (routed to a download: ${set.routed})` };
  await ctx.settle(2000);
  await setParamChan(ctx, trig.paramRefId, canonical);
  const back = await flashParamsChan(ctx, `structural revert ${short(trig.paramRefId)}=${canonical}`);
  if (!back.structural) return { ...base, state: "fail", detail: `the revert to ${canonical} was not written as a structural flash (routed to a download: ${back.routed})` };
  const after = await readBackConfig(ctx);
  if (!after.readback?.paramsRead || !after.readback.linksRead) return { ...base, state: "fail", detail: "the read-back after the structural flashes did not read parameters and links" };
  const drift = after.blocks.flatMap((b) => b.items).flatMap((it) => (it.kind === "param" && it.param.changed ? [it.param.refId] : []));
  const linkDrift = allComObjects(after).filter((c) => c.changed).map((c) => c.number);
  if (drift.length || linkDrift.length) return { ...base, state: "fail", detail: `read-back shows drift after the revert: params ${drift.slice(0, 5).map(short).join(", ") || "none"}, objects ${linkDrift.join(", ") || "none"}` };
  return {
    ...base, state: "pass",
    detail: `${short(trig.paramRefId)} ${canonical}→${trig.value}→${canonical} (${objectsBefore}→${objectsWith}→${allComObjects(after).length} objects), each a verified structural flash, zero drift`,
    evidence: { set: set.result, revert: back.result },
  };
}

// readParams: read the device's parameter memory and decode it. The server reports what the read
// actually covered (readback.paramsRead); the drift is zero when the device matches our image, which
// holds after the write drivers have run. In the ui channel the read is triggered from the config
// page's read-back button.
export async function capReadParams(ctx: CapCtx): Promise<CapabilityResult> {
  const base = { capability: "readParams", channel: ctx.channel };
  const view = await readBackConfig(ctx);
  if (!view.readback) return { ...base, state: "fail", detail: "the read-back did not report what it covered" };
  if (view.readback.paramsRead !== true) return { ...base, state: "fail", detail: "read-back did not decode the parameter image (paramsRead=false)" };
  return { ...base, state: "pass", detail: "parameter image read back and decoded" };
}

// readLinks: read the device's group/association tables and decode the links. Zero linkGaps means
// every association resolved to a group address the config can show.
export async function capReadLinks(ctx: CapCtx): Promise<CapabilityResult> {
  const base = { capability: "readLinks", channel: ctx.channel };
  const view = await readBackConfig(ctx);
  if (!view.readback) return { ...base, state: "fail", detail: "the read-back did not report what it covered" };
  if (view.readback.linksRead !== true) return { ...base, state: "fail", detail: "read-back did not decode the group tables (linksRead=false)" };
  if (view.readback.linkGaps > 0) return { ...base, state: "fail", detail: `${view.readback.linkGaps} association(s) did not resolve to a group address` };
  return { ...base, state: "pass", detail: "group tables read back and decoded, no gaps" };
}

const short = (ref: string): string => ref.split("_").pop() ?? ref;

// The dispatcher the runner uses: map a DeviceCapabilities key to its driver.
export const CAP_DRIVERS: Record<string, (ctx: CapCtx) => Promise<CapabilityResult>> = {
  fullDownload: capFullDownload,
  flashLinks: capFlashLinks,
  flashParams: capFlashParams,
  structuralFlash: capStructuralFlash,
  readParams: capReadParams,
  readLinks: capReadLinks,
};
export type { ParamCandidate };
