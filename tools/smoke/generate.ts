// The Layer-1 generator: a SEEDED, deterministic source of parameter mutations and group addresses
// for the fuzzer. Everything here is reproducible from one 32-bit seed, which the runner records in
// its report so a failing round can be replayed byte-for-byte. It knows nothing about the bus; it
// turns a config view + a fuzz policy into candidate edits the capability drivers then apply.
import type { CfgParamView } from "./client.ts";
import type { FuzzPolicy } from "./spec.ts";

// mulberry32: a tiny, fast, well-distributed 32-bit PRNG. Deterministic given its seed, so a run is
// replayable — the whole point of recording the seed. Returns a float in [0, 1).
export function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One candidate mutation: set `paramRefId` to `value`; `strategy` names how the value was chosen
// (for the report / a failing-round label).
export interface ParamCandidate { paramRefId: string; value: string; strategy: string }

// The controls the parameter IMAGE can represent as a known byte pattern. An enum is an index and a
// number is a scalar, both of which the surgical flash writes and the read-back can verify. The rest
// (text, color, time, ip, display, unsupported) have no image-verifiable mapping the fuzzer can
// assert on, so it SKIPS them rather than write a guess — the project's refuse-don't-pretend rule.
const IMAGE_CONTROLS = new Set(["enum", "number"]);

// Round a raw number to a value the parameter accepts: an integer honouring the ETS step, unless the
// parameter backs a float (then keep one decimal). Clamped to [min, max].
function quantize(raw: number, p: CfgParamView): number {
  const min = p.min ?? 0, max = p.max ?? raw;
  let v = Math.min(max, Math.max(min, raw));
  if (p.float) v = Math.round(v * 10) / 10;
  else { const step = p.step && p.step > 0 ? p.step : 1; v = min + Math.round((v - min) / step) * step; v = Math.round(v); }
  return Math.min(max, Math.max(min, v));
}

// Every value worth trying for ONE parameter, boundary + enum biased:
//   - enum   → each declared option's value
//   - number → min, max, midpoint, and one seeded in-range value (honouring step / float)
// A read-only parameter, a non-image control, or a number without a declared range yields nothing:
// there is no value the fuzzer can set AND verify, so it declines rather than guess a byte.
export function paramCandidates(p: CfgParamView, rnd: () => number): ParamCandidate[] {
  if (p.readOnly || !IMAGE_CONTROLS.has(p.control)) return [];
  if (p.control === "enum") {
    return (p.options ?? []).map((o) => ({ paramRefId: p.refId, value: String(o.value), strategy: `enum:${o.text}` }));
  }
  // number
  if (p.min === undefined || p.max === undefined || p.max <= p.min) return []; // no verifiable range
  const mid = quantize((p.min + p.max) / 2, p);
  const rand = quantize(p.min + rnd() * (p.max - p.min), p);
  const out: ParamCandidate[] = [
    { paramRefId: p.refId, value: String(p.min), strategy: "num:min" },
    { paramRefId: p.refId, value: String(p.max), strategy: "num:max" },
    { paramRefId: p.refId, value: String(mid), strategy: "num:mid" },
    { paramRefId: p.refId, value: String(rand), strategy: "num:rand" },
  ];
  // Distinct values only (a 2-value range collapses min/max/mid); order preserved.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.value) ? false : (seen.add(c.value), true)));
}

// Deterministic Fisher-Yates over a COPY, driven by the seeded PRNG.
function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Pick up to `n` single-parameter mutations from the visible params, preferring DISTINCT parameters
// (broader coverage than many values of one param). Excludes the policy's exclude list, read-only /
// non-image params, and any candidate equal to the parameter's CURRENT value (a no-op proves nothing).
export function pickSweep(params: CfgParamView[], policy: FuzzPolicy, rnd: () => number, n: number): ParamCandidate[] {
  const excluded = new Set(policy.excludeParams ?? []);
  const current = new Map(params.map((p) => [p.refId, p.value]));
  const all: ParamCandidate[] = [];
  for (const p of params) {
    if (excluded.has(p.refId) || [...excluded].some((e) => p.refId.endsWith(e))) continue;
    for (const c of paramCandidates(p, rnd)) if (c.value !== current.get(p.refId)) all.push(c);
  }
  const shuffled = shuffle(all, rnd);
  const picked: ParamCandidate[] = [];
  const usedParams = new Set<string>();
  for (const c of shuffled) { if (usedParams.has(c.paramRefId)) continue; picked.push(c); usedParams.add(c.paramRefId); if (picked.length >= n) break; }
  return picked;
}

// A group-address allocator over the policy's middle group: successive calls yield "main/mid/sub"
// with sub walking up from subStart (default 1). Bounded to the 256-address middle group; throws
// when exhausted rather than silently reusing an address two behaviours would then collide on.
export function gaAllocator(policy: FuzzPolicy): () => string {
  const { main, mid } = policy.gaRange;
  // A 3-level group address is 5/3/8 bits; an out-of-range main/mid would bit-overlap into a wrong
  // address rather than error, so refuse it here (the allocator's refuse-don't-reuse stance).
  if (main < 0 || main > 31) throw new Error(`fuzz gaRange.main ${main} out of range (0..31)`);
  if (mid < 0 || mid > 7) throw new Error(`fuzz gaRange.mid ${mid} out of range (0..7)`);
  let sub = policy.gaRange.subStart ?? 1;
  return () => {
    if (sub > 255) throw new Error(`GA allocator exhausted in ${main}/${mid} (subStart..255 used)`);
    return `${main}/${mid}/${sub++}`;
  };
}
