// The VBScript subset of parameter calculations.
//
// Older product data writes its calculations in VBScript: assignments, `If`/`ElseIf`/`Else`/`End If` (also the
// single-line form), `Dim`, arithmetic (`+ - * / \ Mod`), concatenation (`&`), comparisons and the bitwise
// `And`/`Or`/`Not`, with Booleans that are -1 and 0 in arithmetic and `True`/`False` as text, as in VBScript. Names
// are case-insensitive. A variable that is neither an input nor declared with `Dim` reads as Empty (0 or the empty
// string) in VBScript, but here reading one before it is assigned is refused: it almost always means a parameter
// name the script expects did not resolve, and 0 would be a silent wrong value. An output is not bound before the
// script sets it, so a script that reads one first is refused too (its value would be what ETS computed last time),
// and so are a `Dim` of a parameter's variable, an overflow and a Boolean result. Everything else is refused.
//
// Ported to TypeScript from bussard (https://github.com/tmbo/bussard), commit
// 0a537ce12a821b18122f292e2c7d5fbbe2e081a4, crates/bussard-model/src/script/vbscript.rs,
// Copyright (c) 2026 Tom Bocklisch, under the MIT License in ./LICENSE, which covers this directory.

import { Budget, Depth, checkText, unsupported, type ScriptValue } from "./common.ts";

export function runVbs(src: string, inputs: ReadonlyArray<readonly [string, ScriptValue]>, outputs: readonly string[], opts: { parseOnly?: boolean } = {}): (ScriptValue | undefined)[] {
  const parser = new Parser(tokenize(src));
  const program = parser.program();
  if (opts.parseOnly) return [];
  const params = new Set([...inputs.map(([n]) => n), ...outputs].map((n) => n.toLowerCase()));
  for (const name of parser.dims) if (params.has(name)) throw unsupported(`it declares ${name}, the variable of one of its parameters`);
  const env = new Map<string, Value>(parser.dims.map((name) => [name, EMPTY]));
  for (const [name, value] of inputs) env.set(name.toLowerCase(), value);
  const interp = new Interp(env, new Set(outputs.map((n) => n.toLowerCase())));
  interp.run(program);
  return outputs.map((name) => {
    const v = env.get(name.toLowerCase());
    // No capture shows how ETS stores a Boolean in a parameter.
    if (typeof v === "boolean") throw unsupported(`output ${name} is a Boolean`);
    return v === undefined || v === EMPTY ? undefined : v;
  });
}

// --- tokens -------------------------------------------------------------------------------------------------------

// `nl`: a line break, which ends a statement and a single-line `If`; `colon`: `:`, which ends a statement but not a
// single-line `If`. Names and keywords are lower-cased.
type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "op"; v: string }
  | { t: "name"; v: string }
  | { t: "kw"; v: string }
  | { t: "nl" }
  | { t: "colon" }
  | { t: "eof" };

const KEYWORDS = new Set(["if", "then", "else", "elseif", "end", "and", "or", "not", "mod", "true", "false", "dim"]);
const OPS = ["<>", "<=", ">=", "+", "-", "*", "/", "\\", "(", ")", "=", "<", ">", "&", ","];

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isAlpha = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c);
const isAlnum_ = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9_]$/.test(c);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
    } else if (c === "'") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      i++;
      out.push({ t: "nl" });
    } else if (c === ":") {
      i++;
      out.push({ t: "colon" });
    } else if (c === "_") {
      // A line continuation: `_` then only spaces up to the line end.
      let j = i + 1;
      while (src[j] === " " || src[j] === "\t") j++;
      if (src[j] === "\n") i = j + 1;
      else if (src[j] === "\r" && src[j + 1] === "\n") i = j + 2;
      else throw unsupported("unexpected '_'");
    } else if (c === '"') {
      let text = "";
      i++;
      for (;;) {
        if (src[i] === '"' && src[i + 1] === '"') { text += '"'; i += 2; }
        else if (src[i] === '"') { i++; break; }
        else if (i >= src.length) throw unsupported("unterminated string");
        else { text += src[i]; i++; }
      }
      out.push({ t: "str", v: text });
    } else if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      const start = i;
      while (isDigit(src[i]) || src[i] === ".") i++;
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (isDigit(src[j])) { i = j; while (isDigit(src[i])) i++; }
      }
      const text = src.slice(start, i);
      if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) throw unsupported(`bad number "${text}"`);
      out.push({ t: "num", v: Number(text) });
    } else if (isAlpha(c)) {
      const start = i;
      while (isAlnum_(src[i])) i++;
      const lower = src.slice(start, i).toLowerCase();
      if (lower === "rem") while (i < src.length && src[i] !== "\n") i++;
      else out.push(KEYWORDS.has(lower) ? { t: "kw", v: lower } : { t: "name", v: lower });
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw unsupported(`unexpected character ${JSON.stringify(c)}`);
      i += op.length;
      out.push({ t: "op", v: op });
    }
  }
  out.push({ t: "nl" }, { t: "eof" });
  return out;
}

// --- syntax -------------------------------------------------------------------------------------------------------

type BinOp = "add" | "sub" | "mul" | "div" | "intdiv" | "mod" | "concat" | "and" | "or";
type CmpOp = "=" | "<>" | "<" | ">" | "<=" | ">=";

type Expr =
  | { e: "lit"; v: Value }
  | { e: "var"; name: string }
  | { e: "neg"; inner: Expr }
  | { e: "not"; inner: Expr }
  | { e: "bin"; op: BinOp; a: Expr; b: Expr }
  | { e: "cmp"; op: CmpOp; a: Expr; b: Expr };

type Stmt =
  | { s: "assign"; name: string; value: Expr }
  // `If` branches (condition, body) and the `Else` body.
  | { s: "if"; branches: [Expr, Stmt[]][]; other: Stmt[] }
  | { s: "dim" };

const describe = (t: Tok): string => ("v" in t ? JSON.stringify(t.v) : t.t === "eof" ? "the end of the script" : t.t === "nl" ? "a line break" : '":"');

class Parser {
  private i = 0;
  private depth = new Depth();
  // The names declared with `Dim`, lower-cased: they read as Empty before an assignment, as in VBScript.
  dims: string[] = [];

  constructor(private readonly toks: Tok[]) {}

  private peek(offset = 0): Tok { return this.toks[this.i + offset] ?? this.toks[this.toks.length - 1]; }
  private next(): Tok { const t = this.peek(); this.i++; return t; }
  private isKw(kw: string, t = this.peek()): boolean { return t.t === "kw" && t.v === kw; }
  private acceptKw(kw: string): boolean { if (this.isKw(kw)) { this.i++; return true; } return false; }
  private acceptOp(op: string): boolean { const t = this.peek(); if (t.t === "op" && t.v === op) { this.i++; return true; } return false; }
  private expectKw(kw: string): void { if (!this.acceptKw(kw)) throw unsupported(`expected "${kw}", got ${describe(this.peek())}`); }
  private skipNewlines(): void { while (this.peek().t === "nl" || this.peek().t === "colon") this.i++; }

  program(): Stmt[] {
    const stmts = this.block([]);
    if (this.peek().t !== "eof") throw unsupported(`unexpected ${describe(this.peek())}`);
    return stmts;
  }

  // Statements up to (not including) one of the `terminators` keywords, or the end of the script when there are none.
  private block(terminators: string[]): Stmt[] {
    const stmts: Stmt[] = [];
    this.skipNewlines();
    for (;;) {
      const t = this.peek();
      if (t.t === "kw" && terminators.includes(t.v)) return stmts;
      if (t.t === "eof") {
        if (terminators.length) throw unsupported("unterminated If");
        return stmts;
      }
      stmts.push(this.statement());
      // A statement ends at a line break or `:`; anything else on its line is not VBScript.
      const end = this.peek();
      if (end.t !== "nl" && end.t !== "colon" && end.t !== "eof") throw unsupported(`unexpected ${describe(end)} after a statement`);
      this.skipNewlines();
    }
  }

  private statement(): Stmt { return this.depth.run(() => this.statementInner()); }

  private statementInner(): Stmt {
    if (this.acceptKw("if")) return this.ifStatement();
    if (this.acceptKw("dim")) {
      for (;;) {
        const t = this.next();
        if (t.t !== "name") throw unsupported("bad Dim");
        this.dims.push(t.v);
        if (!this.acceptOp(",")) return { s: "dim" };
      }
    }
    const t = this.peek(), eq = this.peek(1);
    if (t.t === "name" && eq.t === "op" && eq.v === "=") {
      this.i += 2;
      return { s: "assign", name: t.v, value: this.expr() };
    }
    throw unsupported(`unsupported statement starting ${describe(t)}`);
  }

  private ifStatement(): Stmt {
    const cond = this.expr();
    this.expectKw("then");
    if (this.peek().t !== "nl" && this.peek().t !== "eof") {
      // The single-line form: `If c Then a : b [Else c : d]`. Every statement up to the end of the line belongs to its
      // branch; `:` separates them, it does not end the `If`.
      const body = this.singleLineBranch(true);
      const other = this.acceptKw("else") ? this.singleLineBranch(false) : [];
      return { s: "if", branches: [[cond, body]], other };
    }
    const branches: [Expr, Stmt[]][] = [[cond, this.block(["elseif", "else", "end"])]];
    let other: Stmt[] = [];
    for (;;) {
      if (this.acceptKw("elseif")) {
        const c = this.expr();
        this.expectKw("then");
        branches.push([c, this.block(["elseif", "else", "end"])]);
      } else if (this.acceptKw("else")) {
        other = this.block(["end"]);
      } else {
        this.expectKw("end");
        this.expectKw("if");
        return { s: "if", branches, other };
      }
    }
  }

  // The `:`-separated statements of one branch of a single-line `If`, up to the end of the line, or to its `Else` for
  // the `Then` branch.
  private singleLineBranch(stopAtElse: boolean): Stmt[] {
    const stmts: Stmt[] = [];
    for (;;) {
      while (this.peek().t === "colon") this.i++;
      const t = this.peek();
      if (t.t === "nl" || t.t === "eof" || (stopAtElse && this.isKw("else", t))) return stmts;
      stmts.push(this.statement());
      const end = this.peek();
      if (end.t !== "nl" && end.t !== "colon" && end.t !== "eof" && !(stopAtElse && this.isKw("else", end))) throw unsupported(`unexpected ${describe(end)} after a statement`);
    }
  }

  // Expressions, loosest-binding first (VBScript precedence).
  private expr(): Expr {
    let left = this.andExpr();
    while (this.acceptKw("or")) left = { e: "bin", op: "or", a: left, b: this.andExpr() };
    return left;
  }

  private andExpr(): Expr {
    let left = this.notExpr();
    while (this.acceptKw("and")) left = { e: "bin", op: "and", a: left, b: this.notExpr() };
    return left;
  }

  private notExpr(): Expr {
    if (this.acceptKw("not")) return this.depth.run(() => ({ e: "not", inner: this.notExpr() }));
    return this.comparison();
  }

  private comparison(): Expr {
    let left = this.concat();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || !["=", "<>", "<", ">", "<=", ">="].includes(t.v)) return left;
      this.i++;
      left = { e: "cmp", op: t.v as CmpOp, a: left, b: this.concat() };
    }
  }

  private concat(): Expr {
    let left = this.additive();
    while (this.acceptOp("&")) left = { e: "bin", op: "concat", a: left, b: this.additive() };
    return left;
  }

  private additive(): Expr {
    let left = this.modulo();
    for (;;) {
      const op: BinOp | undefined = this.acceptOp("+") ? "add" : this.acceptOp("-") ? "sub" : undefined;
      if (!op) return left;
      left = { e: "bin", op, a: left, b: this.modulo() };
    }
  }

  private modulo(): Expr {
    let left = this.intDiv();
    while (this.acceptKw("mod")) left = { e: "bin", op: "mod", a: left, b: this.intDiv() };
    return left;
  }

  private intDiv(): Expr {
    let left = this.term();
    while (this.acceptOp("\\")) left = { e: "bin", op: "intdiv", a: left, b: this.term() };
    return left;
  }

  private term(): Expr {
    let left = this.unary();
    for (;;) {
      const op: BinOp | undefined = this.acceptOp("*") ? "mul" : this.acceptOp("/") ? "div" : undefined;
      if (!op) return left;
      left = { e: "bin", op, a: left, b: this.unary() };
    }
  }

  private unary(): Expr {
    return this.depth.run((): Expr => {
      if (this.acceptOp("-")) return { e: "neg", inner: this.unary() };
      if (this.acceptOp("+")) return this.unary();
      return this.atom();
    });
  }

  private atom(): Expr {
    const t = this.next();
    if (t.t === "num") return { e: "lit", v: t.v };
    if (t.t === "str") return { e: "lit", v: t.v };
    if (this.isKw("true", t)) return { e: "lit", v: true };
    if (this.isKw("false", t)) return { e: "lit", v: false };
    if (t.t === "name") {
      const p = this.peek();
      if (p.t === "op" && p.v === "(") throw unsupported(`function call ${t.v}() not supported`);
      return { e: "var", name: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      const e = this.expr();
      if (!this.acceptOp(")")) throw unsupported("expected ')'");
      return e;
    }
    throw unsupported(`unexpected ${describe(t)}`);
  }
}

// --- runtime ------------------------------------------------------------------------------------------------------

// VBScript's Empty: 0 next to a number, "" next to a string. A Boolean is its own subtype: -1 or 0 in arithmetic,
// "True" or "False" as text.
const EMPTY = Symbol("Empty");
type Value = number | string | boolean | typeof EMPTY;

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function num(v: Value): number {
  if (v === EMPTY) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? -1 : 0;
  const t = v.trim();
  const n = DECIMAL.test(t) ? Number(t) : NaN;
  if (!Number.isFinite(n)) throw unsupported(`type mismatch: ${JSON.stringify(v)}`);
  return n;
}

const text = (v: Value): string => (v === EMPTY ? "" : typeof v === "number" ? formatNumber(v) : typeof v === "boolean" ? (v ? "True" : "False") : v);
// An arithmetic result: VBScript raises an overflow where a Double does not hold it.
const finite = (n: number): number => { if (!Number.isFinite(n)) throw unsupported("overflow"); return n; };
const truth = (v: Value): boolean => num(v) !== 0;

// VBScript's text for a number (`CStr`): rounded to 15 significant digits, so `0.1 + 0.2` reads `0.3`, and whole
// numbers without a decimal point. VBScript switches to exponent notation outside about `1e-4 ..< 1e15`; this subset
// refuses those rather than print them differently.
function formatNumber(n: number): string {
  if (n === 0) return "0";
  if (!Number.isFinite(n) || Math.abs(n) < 1e-4 || Math.abs(n) >= 1e15) throw unsupported(`the text of ${n} (VBScript writes it in exponent form)`);
  return String(Number(n.toPrecision(15)));
}

// VBScript rounds the operands of `\`, `Mod`, `And`, `Or` and `Not` to whole numbers, half to even.
function whole(v: Value): number {
  const x = num(v);
  const f = Math.floor(x), diff = x - f;
  const n = diff > 0.5 ? f + 1 : diff < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  if (Math.abs(n) > 2_147_483_647) throw unsupported("overflow");
  return n;
}

class Interp {
  private budget = new Budget();
  private depth = new Depth();
  constructor(private readonly env: Map<string, Value>, private readonly outputs: ReadonlySet<string>) {}

  private concat(s: string): string { this.budget.charge(Math.ceil(s.length / 32)); return checkText(s); }

  run(stmts: Stmt[]): void {
    for (const stmt of stmts) {
      this.budget.tick();
      if (stmt.s === "assign") this.env.set(stmt.name, this.eval(stmt.value));
      else if (stmt.s === "if") {
        const taken = stmt.branches.find(([cond]) => truth(this.eval(cond)));
        this.depth.run(() => this.run(taken ? taken[1] : stmt.other));
      }
    }
  }

  private eval(e: Expr): Value { return this.depth.run(() => this.evalInner(e)); }

  private evalInner(e: Expr): Value {
    this.budget.tick();
    switch (e.e) {
      case "lit": return e.v;
      case "var": {
        const v = this.env.get(e.name);
        if (v === undefined && this.outputs.has(e.name)) throw unsupported(`it reads its result ${e.name} before setting it`);
        if (v === undefined) throw unsupported(`${e.name} is read before it is assigned (not an input or Dim)`);
        return v;
      }
      case "neg": return finite(-num(this.eval(e.inner)));
      case "not": { const v = this.eval(e.inner); return typeof v === "boolean" ? !v : ~whole(v); }
      case "cmp": {
        const a = this.eval(e.a), b = this.eval(e.b);
        // VBScript's rules for comparing Variants: a numeric operand is always less than a string one (never equal, no
        // conversion, no type mismatch); an Empty one is "" next to a string and 0 next to a number.
        let order: number;
        if ((typeof a === "boolean" && typeof b === "string") || (typeof a === "string" && typeof b === "boolean")) throw unsupported("comparison of a Boolean with a string");
        if (typeof a === "string" && typeof b === "string") order = a < b ? -1 : a > b ? 1 : 0;
        else if (typeof a === "number" && typeof b === "string") order = -1;
        else if (typeof a === "string" && typeof b === "number") order = 1;
        else if (a === EMPTY && typeof b === "string") order = b === "" ? 0 : -1;
        else if (typeof a === "string" && b === EMPTY) order = a === "" ? 0 : 1;
        else {
          const x = num(a), y = num(b);
          if (Number.isNaN(x) || Number.isNaN(y)) throw unsupported("comparison with NaN");
          order = x < y ? -1 : x > y ? 1 : 0;
        }
        const holds = { "=": order === 0, "<>": order !== 0, "<": order < 0, ">": order > 0, "<=": order <= 0, ">=": order >= 0 }[e.op];
        return holds;
      }
      case "bin": {
        const a = this.eval(e.a), b = this.eval(e.b);
        switch (e.op) {
          case "concat": return this.concat(text(a) + text(b));
          case "add": return typeof a === "string" && typeof b === "string" ? this.concat(a + b) : finite(num(a) + num(b));
          case "sub": return finite(num(a) - num(b));
          case "mul": return finite(num(a) * num(b));
          case "div": {
            const divisor = num(b);
            if (divisor === 0) throw unsupported("division by zero");
            return finite(num(a) / divisor);
          }
          case "intdiv": case "mod": {
            const x = whole(a), y = whole(b);
            if (y === 0) throw unsupported("division by zero");
            return e.op === "intdiv" ? Math.trunc(x / y) : x % y;
          }
          // Two Booleans give a Boolean, anything else the bitwise number.
          case "and": return typeof a === "boolean" && typeof b === "boolean" ? a && b : whole(a) & whole(b);
          case "or": return typeof a === "boolean" && typeof b === "boolean" ? a || b : whole(a) | whole(b);
        }
      }
    }
    throw unsupported("unknown expression");
  }
}
