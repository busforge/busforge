// What the two script interpreters of <ParameterCalculation>s share (see index.ts): their bounds, their error and
// their step counter.
//
// Ported to TypeScript from bussard (https://github.com/tmbo/bussard), commit
// 0a537ce12a821b18122f292e2c7d5fbbe2e081a4, crates/bussard-model/src/script/mod.rs,
// Copyright (c) 2026 Tom Bocklisch, under the MIT License in ./LICENSE, which covers this directory.

// How many statements and expression nodes one script run may evaluate before it is refused as a runaway loop.
// Real calculations stay far below: the largest bussard saw (a 218-entry thermistor table) takes a few thousand.
export const MAX_STEPS = 2_000_000;
// How deeply statements and expressions may nest: product data stays at a handful of levels, and the bound keeps a
// hostile `((((…` or `Not Not …` from overflowing the stack of the recursive parsers and interpreters.
export const MAX_DEPTH = 100;
// The longest string a script may build, in UTF-16 code units, and the most elements an array may hold: the bounds
// keep a loop that doubles a string from exhausting memory within the step budget.
export const MAX_TEXT = 65_536;
export const MAX_ARRAY = 65_536;

// A value a script reads or produces: both languages compute with one floating-point number type.
export type ScriptValue = number | string;

// Why a script could not be run: `language` for a declared language that is neither VBScript nor JavaScript,
// `unsupported` for a construct outside the subset or a run-time failure (an unknown variable, a VBScript division
// by zero, the step budget).
export class ScriptError extends Error {
  constructor(public readonly kind: "language" | "unsupported", message: string) {
    super(message);
    this.name = "ScriptError";
  }
}
export const unsupported = (message: string): ScriptError => new ScriptError("unsupported", message);

export function checkText(text: string): string {
  if (text.length > MAX_TEXT) throw unsupported(`string longer than ${MAX_TEXT} characters`);
  return text;
}

// The nesting of a recursive parser or interpreter; refused past MAX_DEPTH.
export class Depth {
  private n = 0;
  run<T>(f: () => T): T {
    if (++this.n > MAX_DEPTH) { this.n--; throw unsupported(`nested more than ${MAX_DEPTH} levels deep`); }
    try { return f(); } finally { this.n--; }
  }
}

// The step counter of one run.
export class Budget {
  private n = 0;
  tick(): void { if (++this.n > MAX_STEPS) throw unsupported("step budget exceeded"); }
}
