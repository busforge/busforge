// The JavaScript subset of parameter calculations.
//
// Newer product data writes its calculations in JavaScript: `var`/`let`/`const`, assignments (`=`, `+=` …),
// `++`/`--`, `if`, `for`, `while`, `switch`, `break`/`continue`, the conditional operator, arrays, and a whitelist
// of built-ins (the `Math` functions, `parseInt`, `parseFloat`, `Number`, `isNaN`, `Number.prototype.toFixed`).
// Primitive values follow JavaScript's own rules, as this engine computes them. All variables are global, as in a
// top-level script. An output is not bound before the script sets it, so a script that reads one first is refused
// (its value would be what ETS computed last time). Functions, objects, `new`, `typeof`, every other reserved word and everything else are refused,
// and so is source a JavaScript engine would not run: a statement not ended by `;`, `}` or a line break, a legacy
// octal literal, a redeclared `let`/`const`, an assignment to a `const`.
//
// Ported to TypeScript from bussard (https://github.com/tmbo/bussard), commit
// 0a537ce12a821b18122f292e2c7d5fbbe2e081a4, crates/bussard-model/src/script/js.rs,
// Copyright (c) 2026 Tom Bocklisch, under the MIT License in ./LICENSE, which covers this directory.

import { Budget, Depth, MAX_ARRAY, MAX_DEPTH, MAX_TEXT, checkText, unsupported, type ScriptValue } from "./common.ts";

export function runJs(src: string, inputs: ReadonlyArray<readonly [string, ScriptValue]>, outputs: readonly string[], opts: { parseOnly?: boolean } = {}): (ScriptValue | undefined)[] {
  const parser = new Parser(tokenize(src));
  const program = parser.program();
  if (opts.parseOnly) return [];
  checkBlockScoping(parser, inputs.map(([n]) => n), outputs);
  const interp = new Interp(new Map(inputs.map(([n, v]) => [n, v])), parser.constNames, new Set(outputs));
  for (const stmt of program) {
    if (interp.exec(stmt) !== "normal") throw unsupported("break or continue outside a loop");
  }
  return outputs.map((name) => {
    const v = interp.env.get(name);
    if (v === undefined || v === null) return undefined;
    if (typeof v === "number" || typeof v === "string") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    throw unsupported(`output ${name} is not a number or string`);
  });
}

// Refuses a `let`/`const` that this subset's flat environment would not scope as JavaScript does: every variable is
// global here, so a block-scoped name is accepted only when every use of it lies inside a block that declares it, no
// other declaration of it (a `var`, a top-level `let`, a block declaring it around this one) or input or output
// shares the name, and no implicit global of that name exists. A nested `let` used only inside its block
// (`for (let i = 0; …)`, also in two separate loops) behaves the same either way and is accepted.
function checkBlockScoping(parser: Parser, inputs: readonly string[], outputs: readonly string[]): void {
  const shadows = (name: string) => unsupported(`block-scoped ${name} shadows another variable of the same name`);
  for (const name of parser.topLexical) if (inputs.includes(name) || outputs.includes(name)) throw shadows(name);
  parser.lexicalRanges.forEach(([name, start, end], k) => {
    if (inputs.includes(name) || outputs.includes(name) || parser.outerDeclared.has(name)) throw shadows(name);
    // Two blocks declaring the same name, one inside the other.
    if (parser.lexicalRanges.some(([n, s, e], j) => j !== k && n === name && s < end && start < e)) throw shadows(name);
    // A use outside every block declaring it is an implicit global.
    const escapes = parser.refs.some(([n, at]) => n === name && !parser.lexicalRanges.some(([m, s, e]) => m === name && at >= s && at < e));
    if (escapes) throw shadows(name);
  });
}

// --- tokens -------------------------------------------------------------------------------------------------------

// `nl`: a line break precedes the token, which ends a statement (automatic semicolon insertion).
type Tok =
  | { t: "num"; v: number; nl: boolean }
  | { t: "str"; v: string; nl: boolean }
  | { t: "op"; v: string; nl: boolean }
  | { t: "name"; v: string; nl: boolean }
  | { t: "kw"; v: string; nl: boolean }
  | { t: "eof"; nl: boolean };

const KEYWORDS = new Set(["var", "let", "const", "if", "else", "for", "while", "break", "continue", "switch", "case", "default", "true", "false", "null", "undefined"]);
// The reserved words of JavaScript this subset does not implement: as a name they are refused, not read as a
// variable a script never declared.
const RESERVED = new Set(["await", "catch", "class", "debugger", "delete", "do", "enum", "export", "extends", "finally", "function", "implements", "import", "in", "instanceof", "interface", "new", "package", "private", "protected", "public", "return", "static", "super", "this", "throw", "try", "typeof", "void", "with", "yield"]);
// Longest first, so `===` wins over `==` and `=`.
const OPS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=",
  "+", "-", "*", "/", "%", "<", ">", "=", "!", "?", ":", ";", ",", ".", "(", ")", "{", "}", "[", "]"];

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isIdentStart = (c: string | undefined) => c !== undefined && /^[A-Za-z_$]$/.test(c);
const isIdent = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9_$]$/.test(c);
const LINE_BREAK = /^[\n\r\u2028\u2029]$/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, nl = false;
  const at = (k: number): string | undefined => src[k];
  const push = (tok: Tok) => { out.push(tok); nl = false; };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      if (LINE_BREAK.test(c)) nl = true;
      i++;
    } else if (c === "/" && at(i + 1) === "/") {
      while (i < src.length && !LINE_BREAK.test(src[i])) i++;
    } else if (c === "/" && at(i + 1) === "*") {
      i += 2;
      while (!(at(i) === "*" && at(i + 1) === "/")) {
        if (i >= src.length) throw unsupported("unterminated comment");
        if (LINE_BREAK.test(src[i])) nl = true;
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'") {
      let text = "";
      i++;
      for (;;) {
        const d = at(i);
        if (d === "\\") {
          const e = at(i + 1);
          if (e === undefined) throw unsupported("unterminated string");
          if (e === "n") text += "\n";
          else if (e === "t") text += "\t";
          else if (e === "r") text += "\r";
          else if (e === "0" && !isDigit(at(i + 2))) text += "\0";
          else if (e === "\\" || e === "'" || e === '"') text += e;
          // `\x41`, `é`, `\b`, `\v`, `\f`, octal, a line continuation: JavaScript gives them a meaning this subset
          // does not implement, so they are refused, not read as the bare letter.
          else throw unsupported(`string escape \\${e}`);
          i += 2;
        } else if (d === c) {
          i++;
          break;
        } else if (d === undefined || LINE_BREAK.test(d)) {
          throw unsupported("unterminated string");
        } else {
          text += d;
          i++;
        }
      }
      push({ t: "str", v: text, nl });
    } else if (isDigit(c) || (c === "." && isDigit(at(i + 1)))) {
      const start = i;
      if (c === "0" && (at(i + 1) === "x" || at(i + 1) === "X")) {
        i += 2;
        while (isHex(at(i))) i++;
        const digits = src.slice(start + 2, i);
        if (!digits) throw unsupported("bad hex number");
        push({ t: "num", v: Number.parseInt(digits, 16), nl });
      } else {
        // `010` is the octal 8 to a sloppy-mode engine and a syntax error to a strict one.
        if (c === "0" && isDigit(at(i + 1))) throw unsupported(`legacy octal literal ${src.slice(i, i + 4)}`);
        while (isDigit(at(i)) || at(i) === ".") i++;
        if (at(i) === "e" || at(i) === "E") {
          let j = i + 1;
          if (at(j) === "+" || at(j) === "-") j++;
          if (isDigit(at(j))) { i = j; while (isDigit(at(i))) i++; }
        }
        const text = src.slice(start, i);
        const n = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number(text) : NaN;
        if (Number.isNaN(n)) throw unsupported(`bad number "${text}"`);
        push({ t: "num", v: n, nl });
      }
      if (isIdentStart(at(i))) throw unsupported(`a name directly after the number ${src.slice(start, i)}`);
    } else if (isIdentStart(c)) {
      const start = i;
      while (isIdent(at(i))) i++;
      const word = src.slice(start, i);
      if (RESERVED.has(word)) throw unsupported(`${word} not supported`);
      push(KEYWORDS.has(word) ? { t: "kw", v: word, nl } : { t: "name", v: word, nl });
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw unsupported(`unexpected character ${JSON.stringify(c)}`);
      i += op.length;
      push({ t: "op", v: op, nl });
    }
  }
  out.push({ t: "eof", nl: true });
  return out;
}

// --- syntax -------------------------------------------------------------------------------------------------------

type Expr =
  | { e: "num"; v: number }
  | { e: "str"; v: string }
  | { e: "bool"; v: boolean }
  | { e: "null" }
  | { e: "undefined" }
  | { e: "name"; name: string }
  | { e: "array"; items: Expr[] }
  // The comma operator.
  | { e: "seq"; a: Expr; b: Expr }
  // `target op= value`; `op` is undefined for a plain `=`.
  | { e: "assign"; op?: string; target: Expr; value: Expr }
  | { e: "update"; increment: boolean; target: Expr; prefix: boolean }
  | { e: "cond"; cond: Expr; a: Expr; b: Expr }
  | { e: "unary"; op: string; inner: Expr }
  | { e: "binary"; op: string; a: Expr; b: Expr }
  | { e: "index"; array: Expr; index: Expr }
  | { e: "member"; object: Expr; name: string }
  | { e: "call"; callee: Expr; args: Expr[] };

type Stmt =
  | { s: "expr"; expr: Expr }
  // A declaration: whether it is lexical (`let`/`const`), and its names with their initializers.
  | { s: "var"; lexical: boolean; decls: [string, Expr | undefined][] }
  | { s: "block"; body: Stmt[] }
  | { s: "if"; cond: Expr; then: Stmt; other?: Stmt }
  | { s: "for"; init?: Stmt; cond?: Expr; step?: Expr; body: Stmt }
  // The subject and its clauses: a `case` test (undefined for `default`) and the statements that follow it.
  | { s: "switch"; subject: Expr; clauses: [Expr | undefined, Stmt[]][] }
  | { s: "break" }
  | { s: "continue" };

// Binding strength of a binary operator (higher binds tighter).
const PRECEDENCE: Record<string, number> = {
  "||": 1, "&&": 2, "==": 3, "!=": 3, "===": 3, "!==": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
};
const COMPOUND: Record<string, string | undefined> = { "=": undefined, "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%" };

const describe = (t: Tok): string => (t.t === "eof" ? "the end of the script" : JSON.stringify(t.v));

class Parser {
  private i = 0;
  private depth = new Depth();
  // The open blocks, loops and switches: the token index each starts at and the `let`/`const` names declared
  // directly in it.
  private scopes: [number, string[]][] = [];
  // Every `let`/`const` declared inside a block, loop or switch, which this subset makes global, with the token range
  // of its scope (see checkBlockScoping).
  lexicalRanges: [string, number, number][] = [];
  // Names declared by `var` or by a top-level `let`/`const`, and the top-level `let`/`const` names alone.
  outerDeclared = new Set<string>();
  topLexical = new Set<string>();
  private topVar = new Set<string>();
  // The names a `const` declares anywhere: an assignment to one is a TypeError in JavaScript.
  constNames = new Set<string>();
  // Every use of a name, with its token index.
  refs: [string, number][] = [];

  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.i] ?? this.toks[this.toks.length - 1]; }
  private next(): Tok { const t = this.peek(); this.i++; return t; }
  private at(text: string): boolean { const t = this.peek(); return (t.t === "op" || t.t === "kw") && t.v === text; }
  private accept(text: string): boolean { if (this.at(text)) { this.i++; return true; } return false; }
  private expect(text: string): void { if (!this.accept(text)) throw unsupported(`expected "${text}", got ${describe(this.peek())}`); }

  // The end of a statement: `;`, or where automatic semicolon insertion puts one (before `}`, at the end of the
  // script, before a line break). Anything else is a syntax error to a JavaScript engine.
  private endStatement(): void {
    if (this.accept(";")) return;
    const t = this.peek();
    if (t.t === "eof" || t.nl || (t.t === "op" && t.v === "}")) return;
    throw unsupported(`expected ";" before ${describe(t)}`);
  }

  program(): Stmt[] {
    const stmts: Stmt[] = [];
    while (this.peek().t !== "eof") stmts.push(this.statement());
    return stmts;
  }

  private statement(): Stmt { return this.depth.run(() => this.statementInner()); }

  private openScope(start: number): void { this.scopes.push([start, []]); }
  // Closes the innermost block scope at the current token, recording the range of each `let`/`const` it declares.
  private closeScope(): void {
    const scope = this.scopes.pop();
    if (scope) for (const n of scope[1]) this.lexicalRanges.push([n, scope[0], this.i]);
  }

  private statementInner(): Stmt {
    if (this.accept(";")) return { s: "block", body: [] };
    if (this.accept("{")) {
      this.openScope(this.i - 1);
      const body: Stmt[] = [];
      while (!this.accept("}")) {
        if (this.peek().t === "eof") throw unsupported("unterminated block");
        body.push(this.statement());
      }
      this.closeScope();
      return { s: "block", body };
    }
    if (this.at("var") || this.at("let") || this.at("const")) {
      const decl = this.declaration();
      this.endStatement();
      return decl;
    }
    if (this.accept("if")) {
      this.expect("(");
      const cond = this.expr();
      this.expect(")");
      const then = this.statement();
      const other = this.accept("else") ? this.statement() : undefined;
      return { s: "if", cond, then, other };
    }
    if (this.accept("for")) {
      // A `let` in the loop head is scoped to the loop.
      this.openScope(this.i - 1);
      this.expect("(");
      const init: Stmt | undefined = this.at(";") ? undefined
        : this.at("var") || this.at("let") || this.at("const") ? this.declaration()
        : { s: "expr", expr: this.expr() };
      this.expect(";");
      const cond = this.at(";") ? undefined : this.expr();
      this.expect(";");
      const step = this.at(")") ? undefined : this.expr();
      this.expect(")");
      const body = this.statement();
      this.closeScope();
      return { s: "for", init, cond, step, body };
    }
    if (this.accept("while")) {
      this.expect("(");
      const cond = this.expr();
      this.expect(")");
      return { s: "for", cond, body: this.statement() };
    }
    if (this.accept("switch")) return this.switch();
    if (this.accept("break")) { this.endStatement(); return { s: "break" }; }
    if (this.accept("continue")) { this.endStatement(); return { s: "continue" }; }
    const expr = this.expr();
    this.endStatement();
    return { s: "expr", expr };
  }

  private switch(): Stmt {
    this.expect("(");
    const subject = this.expr();
    this.expect(")");
    this.expect("{");
    this.openScope(this.i - 1);
    const clauses: [Expr | undefined, Stmt[]][] = [];
    while (!this.accept("}")) {
      let test: Expr | undefined;
      if (this.accept("case")) test = this.expr();
      else if (this.accept("default")) {
        if (clauses.some(([t]) => t === undefined)) throw unsupported("two default clauses in one switch");
        test = undefined;
      } else throw unsupported(`expected case or default, got ${describe(this.peek())}`);
      this.expect(":");
      const body: Stmt[] = [];
      while (!(this.at("case") || this.at("default") || this.at("}"))) {
        if (this.peek().t === "eof") throw unsupported("unterminated switch");
        body.push(this.statement());
      }
      clauses.push([test, body]);
    }
    this.closeScope();
    return { s: "switch", subject, clauses };
  }

  private declaration(): Stmt {
    const kw = this.next();
    const kind = (kw.t === "kw" ? kw.v : "") as "var" | "let" | "const";
    const lexical = kind !== "var";
    const decls: [string, Expr | undefined][] = [];
    for (;;) {
      const t = this.next();
      if (t.t !== "name") throw unsupported("bad declaration");
      const name = t.v;
      const scope = this.scopes[this.scopes.length - 1];
      if (lexical && scope) {
        if (scope[1].includes(name)) throw unsupported(`${name} is declared twice in one block`);
        scope[1].push(name);
      } else {
        if (lexical ? this.topLexical.has(name) || this.topVar.has(name) : this.topLexical.has(name)) throw unsupported(`${name} is declared twice`);
        (lexical ? this.topLexical : this.topVar).add(name);
        this.outerDeclared.add(name);
      }
      if (kind === "const") this.constNames.add(name);
      const init = this.accept("=") ? this.assignment() : undefined;
      if (kind === "const" && init === undefined) throw unsupported(`const ${name} without a value`);
      decls.push([name, init]);
      if (!this.accept(",")) return { s: "var", lexical, decls };
    }
  }

  private expr(): Expr {
    let e = this.assignment();
    while (this.accept(",")) e = { e: "seq", a: e, b: this.assignment() };
    return e;
  }

  private assignment(): Expr {
    const left = this.conditional();
    const t = this.peek();
    if (t.t !== "op" || !(t.v in COMPOUND)) return left;
    if (left.e !== "name" && left.e !== "index") throw unsupported("invalid assignment target");
    this.i++;
    return { e: "assign", op: COMPOUND[t.v], target: left, value: this.assignment() };
  }

  private conditional(): Expr {
    const cond = this.binary(1);
    if (!this.accept("?")) return cond;
    const a = this.assignment();
    this.expect(":");
    return { e: "cond", cond, a, b: this.assignment() };
  }

  private binary(min: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op") return left;
      const prec = PRECEDENCE[t.v];
      if (prec === undefined || prec < min) return left;
      this.i++;
      left = { e: "binary", op: t.v, a: left, b: this.binary(prec + 1) };
    }
  }

  private unary(): Expr { return this.depth.run(() => this.unaryInner()); }

  private unaryInner(): Expr {
    for (const op of ["!", "-", "+"]) if (this.accept(op)) return { e: "unary", op, inner: this.unary() };
    for (const [op, increment] of [["++", true], ["--", false]] as const) {
      if (this.accept(op)) {
        const target = this.unary();
        if (target.e !== "name" && target.e !== "index") throw unsupported("invalid increment target");
        return { e: "update", increment, target, prefix: true };
      }
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.accept("(")) {
        const args: Expr[] = [];
        if (!this.accept(")")) {
          for (;;) {
            args.push(this.assignment());
            if (this.accept(")")) break;
            this.expect(",");
          }
        }
        e = { e: "call", callee: e, args };
      } else if (this.accept("[")) {
        const index = this.expr();
        this.expect("]");
        e = { e: "index", array: e, index };
      } else if (this.accept(".")) {
        const t = this.next();
        if (t.t !== "name" && t.t !== "kw") throw unsupported(`bad member ${describe(t)}`);
        e = { e: "member", object: e, name: t.v };
      } else if ((this.at("++") || this.at("--")) && !this.peek().nl) {
        // A `++`/`--` after a line break starts the next statement (a restricted production of JavaScript).
        if (e.e !== "name" && e.e !== "index") throw unsupported("invalid increment target");
        const increment = this.at("++");
        this.i++;
        e = { e: "update", increment, target: e, prefix: false };
      } else {
        return e;
      }
    }
  }

  private primary(): Expr {
    const t = this.next();
    switch (t.t) {
      case "num": return { e: "num", v: t.v };
      case "str": return { e: "str", v: t.v };
      case "name":
        this.refs.push([t.v, this.i - 1]);
        return { e: "name", name: t.v };
      case "kw":
        if (t.v === "true" || t.v === "false") return { e: "bool", v: t.v === "true" };
        if (t.v === "null") return { e: "null" };
        if (t.v === "undefined") return { e: "undefined" };
        break;
      case "op":
        if (t.v === "(") {
          const e = this.expr();
          this.expect(")");
          return e;
        }
        if (t.v === "[") {
          const items: Expr[] = [];
          if (!this.accept("]")) {
            for (;;) {
              items.push(this.assignment());
              if (this.accept("]")) break;
              this.expect(",");
            }
          }
          return { e: "array", items };
        }
        break;
      case "eof":
        break;
    }
    throw unsupported(`unexpected ${describe(t)}`);
  }
}

// --- runtime ------------------------------------------------------------------------------------------------------

// The built-ins a script can reach: the `Math` object, the whitelisted functions, and `x.toFixed` bound to its
// number. Primitive values are JavaScript's own; an array is a JavaScript array of values.
class MathObject {}
class Builtin { constructor(readonly name: string) {} }
class ToFixed { constructor(readonly x: number) {} }
type Value = undefined | null | boolean | number | string | Value[] | MathObject | Builtin | ToFixed;

const MATH = new MathObject();
const MATH_FUNCTIONS = new Set(["log", "exp", "pow", "sqrt", "abs", "floor", "ceil", "round", "min", "max"]);
const GLOBAL_FUNCTIONS = new Set(["parseInt", "parseFloat", "Number", "isNaN"]);
const builtins = new Map<string, Builtin>();
const builtin = (name: string): Builtin => builtins.get(name) ?? builtins.set(name, new Builtin(name)).get(name)!;

type Primitive = undefined | null | boolean | number | string;
const isPrimitive = (v: Value): v is Primitive => v === null || typeof v !== "object";

// JavaScript's ToPrimitive of what a script holds: an array becomes its text, a built-in its text.
function toPrimitive(v: Value, depth = 0): Primitive {
  if (isPrimitive(v)) return v;
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) throw unsupported("array nested too deeply (or containing itself)");
    let out = "";
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ",";
      const item = v[k];
      if (item !== undefined && item !== null) out += String(toPrimitive(item, depth + 1));
      if (out.length > MAX_TEXT * 4) break;
    }
    return checkText(out);
  }
  return v instanceof MathObject ? "[object Math]" : "function";
}
const text = (v: Value): string => String(toPrimitive(v));
// JavaScript's ToNumber; an array too large or too deep to print is not a number either.
function num(v: Value): number {
  try { return Number(toPrimitive(v)); } catch { return NaN; }
}
const truthy = (v: Value): boolean => (isPrimitive(v) ? Boolean(v) : true);

function looseEq(a: Value, b: Value): boolean {
  if (!isPrimitive(a) && !isPrimitive(b)) return a === b;
  // eslint-disable-next-line eqeqeq -- the script's `==` is JavaScript's
  return toPrimitive(a) == toPrimitive(b);
}

function arithmetic(op: string, a: Value, b: Value): Value {
  if (op === "+") {
    const sum = (toPrimitive(a) as never as number) + (toPrimitive(b) as never as number);
    return typeof sum === "string" ? checkText(sum) : sum;
  }
  const x = num(a), y = num(b);
  switch (op) {
    case "-": return x - y;
    case "*": return x * y;
    case "/": return x / y;
    case "%": return x % y;
  }
  throw unsupported(`operator ${op}`);
}

function compare(op: string, a: Value, b: Value): boolean {
  const x = toPrimitive(a) as never as number, y = toPrimitive(b) as never as number;
  switch (op) {
    case "<": return x < y;
    case ">": return x > y;
    case "<=": return x <= y;
    default: return x >= y;
  }
}

function callBuiltin(name: string, args: Value[]): Value {
  const arg = (k: number) => (k < args.length ? num(args[k]) : NaN);
  switch (name) {
    case "parseInt": return Number.parseInt(text(args[0]), args.length > 1 ? num(args[1]) : undefined);
    case "parseFloat": return Number.parseFloat(text(args[0]));
    case "Number": return args.length ? num(args[0]) : 0;
    case "isNaN": return Number.isNaN(arg(0));
    case "log": return Math.log(arg(0));
    case "exp": return Math.exp(arg(0));
    case "sqrt": return Math.sqrt(arg(0));
    case "abs": return Math.abs(arg(0));
    case "floor": return Math.floor(arg(0));
    case "ceil": return Math.ceil(arg(0));
    case "round": return Math.round(arg(0));
    case "pow": return Math.pow(arg(0), arg(1));
    case "min": return Math.min(...args.map(num));
    case "max": return Math.max(...args.map(num));
  }
  throw unsupported(`${name} not supported`);
}

type Flow = "normal" | "break" | "continue";

class Interp {
  private budget = new Budget();
  private depth = new Depth();
  constructor(readonly env: Map<string, Value>, private readonly constNames: ReadonlySet<string>, private readonly outputs: ReadonlySet<string>) {}

  private lookup(name: string): Value {
    if (this.env.has(name)) return this.env.get(name);
    if (name === "Math") return MATH;
    if (GLOBAL_FUNCTIONS.has(name)) return builtin(name);
    if (name === "NaN") return NaN;
    if (name === "Infinity") return Infinity;
    if (this.outputs.has(name)) throw unsupported(`it reads its result ${name} before setting it`);
    throw unsupported(`undefined variable ${name}`);
  }

  private block(stmts: Stmt[]): Flow {
    for (const stmt of stmts) {
      const flow = this.exec(stmt);
      if (flow !== "normal") return flow;
    }
    return "normal";
  }

  exec(stmt: Stmt): Flow { return this.depth.run(() => this.execInner(stmt)); }

  private execInner(stmt: Stmt): Flow {
    this.budget.tick();
    switch (stmt.s) {
      case "expr": this.eval(stmt.expr); return "normal";
      case "var":
        for (const [name, init] of stmt.decls) {
          if (init) this.env.set(name, this.eval(init));
          // A `let` is a fresh binding each time it runs (every loop iteration), so it starts undefined.
          else if (stmt.lexical) this.env.set(name, undefined);
          // A `var` keeps the value it already has.
          else if (!this.env.has(name)) this.env.set(name, undefined);
        }
        return "normal";
      case "block": return this.block(stmt.body);
      case "if":
        if (truthy(this.eval(stmt.cond))) return this.exec(stmt.then);
        return stmt.other ? this.exec(stmt.other) : "normal";
      case "for":
        if (stmt.init) this.exec(stmt.init);
        for (;;) {
          this.budget.tick();
          if (stmt.cond && !truthy(this.eval(stmt.cond))) break;
          if (this.exec(stmt.body) === "break") break;
          if (stmt.step) this.eval(stmt.step);
        }
        return "normal";
      case "switch": {
        // The first case strictly equal to the subject, else `default`; execution falls through until a `break`.
        // A `continue` belongs to an enclosing loop.
        const value = this.eval(stmt.subject);
        let start = -1;
        for (let k = 0; k < stmt.clauses.length; k++) {
          const test = stmt.clauses[k][0];
          if (test !== undefined && value === this.eval(test)) { start = k; break; }
        }
        if (start < 0) start = stmt.clauses.findIndex(([test]) => test === undefined);
        if (start >= 0) {
          for (const [, body] of stmt.clauses.slice(start)) {
            const flow = this.block(body);
            if (flow === "break") break;
            if (flow === "continue") return "continue";
          }
        }
        return "normal";
      }
      case "break": return "break";
      case "continue": return "continue";
    }
  }

  private store(target: Expr, value: Value): void {
    if (target.e === "name") {
      if (this.constNames.has(target.name)) throw unsupported(`assignment to the constant ${target.name}`);
      this.env.set(target.name, value);
      return;
    }
    if (target.e !== "index") throw unsupported("invalid assignment target");
    const items = this.eval(target.array);
    if (!Array.isArray(items)) throw unsupported("indexed assignment to a non-array");
    const k = num(this.eval(target.index));
    if (!(Number.isInteger(k) && k >= 0 && k < MAX_ARRAY)) throw unsupported(`bad array index ${k}`);
    while (items.length < k) items.push(undefined);
    items[k] = value;
  }

  private eval(e: Expr): Value { return this.depth.run(() => this.evalInner(e)); }

  private evalInner(e: Expr): Value {
    this.budget.tick();
    switch (e.e) {
      case "num": return e.v;
      case "str": return e.v;
      case "bool": return e.v;
      case "null": return null;
      case "undefined": return undefined;
      case "name": return this.lookup(e.name);
      case "array": return e.items.map((item) => this.eval(item));
      case "seq": this.eval(e.a); return this.eval(e.b);
      case "assign": {
        // JavaScript reads the target of `x op= y` before it evaluates `y`.
        const old = e.op !== undefined ? this.eval(e.target) : undefined;
        let value = this.eval(e.value);
        if (e.op !== undefined) value = arithmetic(e.op, old, value);
        this.store(e.target, value);
        return value;
      }
      case "update": {
        const old = num(this.eval(e.target));
        const next = e.increment ? old + 1 : old - 1;
        this.store(e.target, next);
        return e.prefix ? next : old;
      }
      case "cond": return truthy(this.eval(e.cond)) ? this.eval(e.a) : this.eval(e.b);
      case "unary": {
        const v = this.eval(e.inner);
        return e.op === "!" ? !truthy(v) : e.op === "-" ? -num(v) : num(v);
      }
      case "binary": {
        if (e.op === "&&") { const a = this.eval(e.a); return truthy(a) ? this.eval(e.b) : a; }
        if (e.op === "||") { const a = this.eval(e.a); return truthy(a) ? a : this.eval(e.b); }
        const a = this.eval(e.a), b = this.eval(e.b);
        switch (e.op) {
          case "==": return looseEq(a, b);
          case "!=": return !looseEq(a, b);
          case "===": return a === b;
          case "!==": return a !== b;
          case "<": case ">": case "<=": case ">=": return compare(e.op, a, b);
        }
        return arithmetic(e.op, a, b);
      }
      case "index": {
        const array = this.eval(e.array), k = num(this.eval(e.index));
        if (Array.isArray(array)) return Number.isInteger(k) && k >= 0 ? array[k] : undefined;
        if (typeof array === "string") return Number.isInteger(k) && k >= 0 && k < array.length ? array[k] : undefined;
        throw unsupported("indexing a non-array");
      }
      case "member": {
        const object = this.eval(e.object);
        if (object instanceof MathObject) {
          if (e.name === "PI") return Math.PI;
          if (e.name === "E") return Math.E;
          if (MATH_FUNCTIONS.has(e.name)) return builtin(e.name);
          throw unsupported(`Math.${e.name} not supported`);
        }
        if (e.name === "length" && (Array.isArray(object) || typeof object === "string")) return object.length;
        if (e.name === "toFixed" && typeof object === "number") return new ToFixed(object);
        throw unsupported(`.${e.name} not supported`);
      }
      case "call": {
        const callee = this.eval(e.callee);
        const args = e.args.map((a) => this.eval(a));
        if (callee instanceof Builtin) return callBuiltin(callee.name, args);
        if (callee instanceof ToFixed) {
          const digits = args.length ? num(args[0]) : 0;
          const d = Number.isNaN(digits) ? 0 : Math.trunc(digits);
          if (d < 0 || d > 100) throw unsupported("toFixed digits out of range");
          return callee.x.toFixed(d);
        }
        throw unsupported("call of a non-function");
      }
    }
  }
}
