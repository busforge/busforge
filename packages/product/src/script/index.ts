// The script languages of <ParameterCalculation>s: the subset of JavaScript and VBScript that product data
// uses, tokenised, parsed and walked here, never handed to an engine. There is no I/O and no host access, only a
// whitelist of built-ins, and a step budget stops a runaway loop. A construct outside the subset, or a run-time
// error such as a VBScript division by zero, throws ScriptError rather than yielding a guessed value, so a caller
// never writes a value it could not compute.
//
// Ported to TypeScript from bussard (https://github.com/tmbo/bussard), commit
// 0a537ce12a821b18122f292e2c7d5fbbe2e081a4, crates/bussard-model/src/script/ (mod.rs, js.rs, vbscript.rs),
// Copyright (c) 2026 Tom Bocklisch, under the MIT License in ./LICENSE, which covers this directory.

import { runJs } from "./js.ts";
import { runVbs } from "./vbscript.ts";
import { ScriptError, type ScriptValue } from "./common.ts";

export { ScriptError, type ScriptValue } from "./common.ts";

// Runs `script`, written in `language` (`JavaScript` or `VBScript`, any case), with `inputs` as its variables, and
// returns the final value of each of `outputs`, in order: undefined for one the script leaves unset. An output is
// unset until the script sets it, and reading it before refuses. Names follow the language: case-insensitive in
// VBScript, case-sensitive in JavaScript.
export function runScript(language: string, script: string, inputs: ReadonlyArray<readonly [string, ScriptValue]>, outputs: readonly string[]): (ScriptValue | undefined)[] {
  const lang = language.toLowerCase();
  if (lang === "javascript") return runJs(script, inputs, outputs);
  if (lang === "vbscript") return runVbs(script, inputs, outputs);
  throw new ScriptError("language", `unsupported script language "${language}"`);
}

// Whether `script` parses within the subset of `language`, without running it: the reason it does not, else null.
export function scriptRefusal(language: string, script: string): string | null {
  const lang = language.toLowerCase();
  if (lang !== "javascript" && lang !== "vbscript") return `unsupported script language "${language}"`;
  try {
    // A parse alone: outputs and inputs do not change what the parser accepts.
    if (lang === "javascript") runJs(script, [], [], { parseOnly: true });
    else runVbs(script, [], [], { parseOnly: true });
    return null;
  } catch (e) {
    if (e instanceof ScriptError) return e.message;
    throw e;
  }
}
