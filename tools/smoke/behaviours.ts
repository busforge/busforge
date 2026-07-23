// One verifier per BehaviourSpec kind. A behaviour is the real correctness proof: after the framework
// configures the device (enable params + link the object to a RANDOM group address + flash) it
// OBSERVES the bus with the witness tunnel and requires the device to actually act — transmit its
// heartbeat, answer a read, or drive an output from an input. A byte-matched read-back cannot prove
// this (a wrongly-but-consistently encoded value reads back green); only the bus can. See
// /CONTEXT.md "Behaviour".
//
// The configuration goes through the active channel (api / ui); the witness is always the independent
// tunnel. The witness may connect ONLY between server bus operations (the bench bridge has one tunnel
// channel), so every flash here completes and releases the bus BEFORE the witness connects.
import { findComObject } from "./client.ts";
import type { Witness } from "./witness.ts";
import type { BehaviourSpec, DeviceSpec, Enable } from "./spec.ts";
import { setParamChan, linkChan, flashParamsChan, flashGaChan, type ChanCtx } from "./channel.ts";

export interface BehaviourCtx extends ChanCtx {
  witness: Witness;
  spec: DeviceSpec;
  allocGa: () => string;
}
export interface BehaviourResult {
  kind: string; label: string; state: "pass" | "fail"; detail: string;
  gas?: Record<string, string>; // the random GAs allocated, for the report
}

// Apply a behaviour's enable parameters, then flash them (routing an object-revealing change to a
// full download if the surgical flash refuses it as stale). No-op if the behaviour needs no enable.
async function applyEnable(ctx: BehaviourCtx, enable: Enable | undefined, label: string): Promise<void> {
  if (!enable?.length) return;
  for (const e of enable) await setParamChan(ctx, e.paramRefId, e.value);
  await flashParamsChan(ctx, `${label} enable`);
  await ctx.settle(2000);
}

// Resolve a com-object's live number from the current config (it must be visible now that its enable
// params are set); throws if it is not, which is a genuine setup failure, not a silent skip.
async function resolveObject(ctx: BehaviourCtx, refId: string): Promise<{ refId: string; number: number }> {
  const co = findComObject(await ctx.client.getConfig(ctx.pid, ctx.did), refId);
  if (!co) throw new Error(`com-object ${refId} is not visible (enable params wrong?)`);
  return { refId, number: co.number };
}

export async function verifyBehaviour(ctx: BehaviourCtx, b: BehaviourSpec): Promise<BehaviourResult> {
  const head = { kind: b.kind, label: b.label };
  try {
    if (b.kind === "heartbeat" || b.kind === "output") {
      let ga: string;
      if (b.ga) {
        ga = b.ga; // observe-only: the object was linked in baseline configure and committed by the fullDownload
      } else {
        await applyEnable(ctx, b.enable, b.label);
        const obj = await resolveObject(ctx, b.comObjRefId);
        ga = ctx.allocGa();
        await linkChan(ctx, obj, ga);
        await flashGaChan(ctx, b.label);
        await ctx.settle(3000); // let the flash's tunnel fully release before the witness connects
      }
      await ctx.witness.connect();
      try {
        const v = b.kind === "heartbeat" ? await ctx.witness.listen(ga, b.windowMs) : await ctx.witness.groupRead(ga);
        if (v === null) return { ...head, state: "fail", detail: b.kind === "heartbeat" ? `no telegram on ${ga} within ${b.windowMs}ms` : `no GroupValueResponse on ${ga}`, gas: { object: ga } };
        if (b.expectValue && v !== b.expectValue) return { ...head, state: "fail", detail: `${ga} = 0x${v}, expected 0x${b.expectValue}`, gas: { object: ga } };
        return { ...head, state: "pass", detail: `${ga} answered 0x${v}`, gas: { object: ga } };
      } finally { await ctx.witness.close(); }
    }
    // inputToOutput
    if (b.steps.length < 2) return { ...head, state: "fail", detail: `inputToOutput needs ≥2 transition steps to prove causation, got ${b.steps.length}` };
    // Observe-only requires BOTH GAs; one without the other would silently fall through to the
    // allocate-link-flash mode and ignore the fixed address it was given — refuse that half-state.
    if (!!b.inGa !== !!b.outGa) return { ...head, state: "fail", detail: "inputToOutput must set BOTH inGa and outGa (observe-only) or NEITHER (allocate)" };
    let gaIn: string, gaOut: string;
    if (b.inGa && b.outGa) {
      gaIn = b.inGa; gaOut = b.outGa; // observe-only (linked in baseline configure + fullDownload)
    } else {
      await applyEnable(ctx, b.enable, b.label);
      const inObj = await resolveObject(ctx, b.inObjRefId);
      const outObj = await resolveObject(ctx, b.outObjRefId);
      gaIn = ctx.allocGa(); gaOut = ctx.allocGa();
      await linkChan(ctx, inObj, gaIn);
      await linkChan(ctx, outObj, gaOut);
      await flashGaChan(ctx, b.label);
      await ctx.settle(3000);
    }
    await ctx.witness.connect();
    try {
      // Drive each transition and require the output to TRACK it. Because the steps move to different
      // values, a stuck output cannot pass every step (it holds one value while the expected value changes).
      for (const s of b.steps) {
        await ctx.witness.groupWrite(gaIn, s.write);
        await ctx.settle(500);
        const v = await ctx.witness.groupRead(gaOut);
        if (v !== s.expect) return { ...head, state: "fail", detail: `${gaOut} = ${v === null ? "no response" : "0x" + v}, expected 0x${s.expect} after writing 0x${s.write} to ${gaIn}`, gas: { in: gaIn, out: gaOut } };
      }
      return { ...head, state: "pass", detail: `${b.steps.length} transitions tracked on ${gaIn}→${gaOut}`, gas: { in: gaIn, out: gaOut } };
    } finally { await ctx.witness.close(); }
  } catch (e) {
    return { ...head, state: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}
