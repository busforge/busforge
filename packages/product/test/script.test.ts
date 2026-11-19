import { test, expect, describe } from "bun:test";
import { runScript, scriptRefusal, ScriptError, type ScriptValue } from "../src/script/index.ts";

// The interpreter of <ParameterCalculation> scripts. Most cases are ported from bussard's tests of the code this
// interpreter is ported from (https://github.com/tmbo/bussard, commit 0a537ce, crates/bussard-model/src/script/,
// Copyright (c) 2026 Tom Bocklisch, MIT License: packages/product/src/script/LICENSE); they pin the language
// semantics, not a device.

const js = (src: string, inputs: [string, ScriptValue][] = [], outputs = ["x"]) => runScript("JavaScript", src, inputs, outputs);
const vb = (src: string, inputs: [string, ScriptValue][] = [], outputs = ["x"]) => runScript("VBScript", src, inputs, outputs);
const one = (out: (ScriptValue | undefined)[]) => out[0];
const refused = (f: () => unknown) => expect(f).toThrow(ScriptError);

test("runScript dispatches by language, in any case, and refuses another", () => {
  expect(runScript("JavaScript", "var y = x * 3;", [["x", 2]], ["y"])).toEqual([6]);
  expect(runScript("vbscript", "Y = X * 3", [["x", 2]], ["y"])).toEqual([6]);
  expect(() => runScript("Python", "y = 1", [], ["y"])).toThrow(expect.objectContaining({ kind: "language" }));
  expect(scriptRefusal("JavaScript", "x = 1;")).toBeNull();
  expect(scriptRefusal("JavaScript", "function f() {}")).toContain("function");
});

describe("JavaScript", () => {
  test("control flow and arrays", () => {
    const src = `
      var a = [];  // comment
      for (i = 0; i < 5; i++) { a[i] = i * i; }
      var total = 0, k = 0;
      while (k < a.length) { total += a[k]; k++; }
      /* block comment */
      if (total > 20) { big = 1; } else { big = 0; }
      var flag = total == 30 ? 'yes' : 'no';`;
    expect(js(src, [], ["total", "big", "flag"])).toEqual([30, 1, "yes"]);
  });

  test("a switch falls through, and a continue in it reaches the loop", () => {
    const src = `
      var r = 0;
      switch (x) { case 0: r = 10; break; case 1: r = 20; case 2: r = r + 1; break; default: r = 99; }
      for (var i = 0; i < 3; i++) { switch (i) { case 1: continue; default: r = r + 100; } }`;
    for (const [x, want] of [[0, 210], [1, 221], [2, 201], [5, 299]]) expect(one(js(src, [["x", x]], ["r"]))).toBe(want);
    // case matching is strict: the string "1" is not the number 1.
    expect(one(js(src, [["x", "1"]], ["r"]))).toBe(299);
  });

  test("conversions and equality are JavaScript's", () => {
    expect(one(js("x = 1 + '2';"))).toBe("12");
    expect(one(js("x = '6' * '7';"))).toBe(42);
    expect(one(js("x = null + 1;"))).toBe(1);
    expect(one(js("x = (undefined == null) && ('1' == 1) && !('1' === 1) ? 1 : 0;"))).toBe(1);
    expect(one(js("x = isNaN('abc') && !isNaN('12') ? 1 : 0;"))).toBe(1);
    expect(one(js("x = '' + [1, 2, 3];"))).toBe("1,2,3");
    expect(js("x = 7 % -3; m = -7 % 3;", [], ["x", "m"])).toEqual([1, -1]);
    expect(one(js("x = 1 / 0 === Infinity ? 1 : 0;"))).toBe(1);
    expect(one(js("x = 0.1 + 0.2;"))).toBe(0.30000000000000004);
    expect(one(js("x = true;"))).toBe(1);
    expect(one(js("x = undefined;"))).toBeUndefined();
  });

  test("built-ins", () => {
    expect(one(js("x = Math.round(2.5) + Math.round(-2.5);"))).toBe(1);
    expect(one(js("x = Math.pow(2, 10);"))).toBe(1024);
    expect(one(js("x = Math.max(1, 7, 3) - Math.min(4, 2);"))).toBe(5);
    expect(one(js("x = parseInt('  42px');"))).toBe(42);
    expect(one(js("x = parseInt('ff', 16) + parseInt('0x10');"))).toBe(271);
    expect(one(js("x = parseFloat('3.5e2xyz');"))).toBe(350);
    expect(one(js("x = Number('12.5') * 2;"))).toBe(25);
    expect(one(js("x = Math.log(Math.E);"))).toBeCloseTo(1, 12);
    expect(one(js("x = (1.005).toFixed(2) + '|' + (2.5).toFixed(0) + '|' + (0.125).toFixed(2) + '|' + (-1.5).toFixed(0) + '|' + (99.996).toFixed(2);"))).toBe("1.00|3|0.13|-2|100.00");
    expect(one(js("x = (21.456).toFixed(1);"))).toBe("21.5");
    expect(one(js("x = '' + 1e21 + '|' + 1.5e-7 + '|' + 0.000001;"))).toBe("1e+21|1.5e-7|0.000001");
  });

  test("refuses what the subset does not implement", () => {
    for (const src of ["function f() { return 1; }", "x = new Date();", "x = typeof y;", "x = Math.random();", "x = {a: 1};",
      "x = y;", "while (true) {}", "x = 'abc'.toUpperCase();", "x = this;", "x = 1 in y;"]) refused(() => js(src));
  });

  test("refuses source a JavaScript engine would not run", () => {
    // A statement not ended by `;`, `}` or a line break.
    refused(() => js("x = 1 y = 2;"));
    refused(() => js("if (1) x = 1 else x = 2;"));
    // A line break ends it: the same statements on two lines run.
    expect(js("x = 1\ny = 2", [], ["x", "y"])).toEqual([1, 2]);
    expect(one(js("if (1) x = 1; else x = 2;"))).toBe(1);
    // `010` is octal to a sloppy engine and an error to a strict one.
    refused(() => js("x = 010;"));
    expect(one(js("x = 0.5 + 0;"))).toBe(0.5);
    refused(() => js("const x = 1; x = 2;"));
    refused(() => js("let x = 1; let x = 2;"));
    refused(() => js("x = 1n;"));
  });

  test("a ++ after a line break starts the next statement, as automatic semicolon insertion has it", () => {
    expect(js("var a = 1, b = 1;\na\n++b", [], ["a", "b"])).toEqual([1, 2]);
  });

  test("refuses string escapes outside the subset", () => {
    expect(one(js(String.raw`x = "a\n\t\"\\\'b\0";`))).toBe("a\n\t\"\\'b\0");
    for (const esc of [String.raw`\x41`, String.raw`\u00e9`, String.raw`\b`, String.raw`\v`, String.raw`\f`, String.raw`\07`, String.raw`\q`]) refused(() => js(`x = "${esc}";`));
  });

  test("refuses deep nesting without overflowing the stack", () => {
    refused(() => js(`x = ${"(".repeat(10_000)}1${")".repeat(10_000)};`));
    refused(() => js(`x = ${"!".repeat(10_000)}1;`));
    refused(() => js(`${"{".repeat(10_000)}x = 1;${"}".repeat(10_000)}`));
  });

  test("refuses a string or array past its bound, and an array holding itself", () => {
    refused(() => js("var x = \"ab\"; for (var i = 0; i < 30; i++) { x += x; }"));
    refused(() => js("var x = []; x[70000] = 1;"));
    refused(() => js("var a = [1]; a[0] = a; var x = a + \"\";"));
  });

  test("a block-scoped name that would shadow another variable is refused", () => {
    refused(() => js("if (true) { let x = 1; } var y = x;", [["x", 5]], ["y"]));
    refused(() => js("var t = 2; for (let t = 0; t < 1; t++) {} var y = t;", [], ["y"]));
    // A loop counter used only in its loop behaves the same either way.
    expect(one(js("var y = 0; for (let i = 0; i < 3; i++) { const d = i * 2; y += d; }", [], ["y"]))).toBe(6);
    // An implicit global that a nested `let` shadows would be clobbered by it.
    refused(() => js("tmp = x * 2; if (x > 3) { let tmp = 0; } y = tmp;", [["x", 5]], ["y"]));
    refused(() => js("var y = 0; { let a = 1; { let a = 2; } y = a; }", [], ["y"]));
    expect(one(js("var y = 0; for (let i = 0; i < 2; i++) { y += i; } for (let i = 0; i < 3; i++) { y += i; }", [], ["y"]))).toBe(4);
    // A top-level `let` of an input or output name.
    refused(() => js("let x = 2;", [], ["x"]));
  });

  test("a let without a value is fresh each iteration, a var keeps its value", () => {
    expect(one(js("var count = 0;\nfor (var i = 0; i < 5; i++) { let m; if (i % 2 == 0) { m = 1; } if (m === 1) { count++; } }", [], ["count"]))).toBe(3);
    expect(one(js("var count = 0;\nfor (var i = 0; i < 5; i++) { var m; if (i == 0) { m = 1; } if (m === 1) { count++; } }", [], ["count"]))).toBe(5);
  });

  test("the step budget stops a runaway loop", () => {
    refused(() => js("for (;;) { x = 1; }"));
  });
});

describe("VBScript", () => {
  test("a number compares less than a string", () => {
    const src = "If label = 2 Then\n  r = 1\nElse\n  r = 0\nEnd If\nlt = (2 < label)";
    for (const label of ["2", "on"]) expect(vb(src, [["label", label]], ["r", "lt"])).toEqual([0, -1]);
  });

  test("If, ElseIf, Else, with names in any case", () => {
    const src = "If Mode = 1 Then\n  Fan = 4\nElseIf mode = 2 Then\n  fan = 5\nElse\n  FAN = 0\nEnd If";
    expect(one(vb(src, [["mode", 1]], ["fan"]))).toBe(4);
    expect(one(vb(src, [["MODE", 2]], ["Fan"]))).toBe(5);
    expect(one(vb(src, [["mode", 7]], ["fan"]))).toBe(0);
  });

  test("the single-line If, a line continuation, comments and colons", () => {
    const src = "If a > 1 And _\n   b < 3 Then x = 1 Else x = 2\n' a comment\ny = 7 : z = 8 Rem another";
    expect(one(vb(src, [["a", 2], ["b", 1]]))).toBe(1);
    expect(one(vb(src, [["a", 0], ["b", 1]]))).toBe(2);
    expect(one(vb(src, [["a", 0], ["b", 0]], ["z"]))).toBe(8);
  });

  test("the statements after a single-line If's colon are its branch's", () => {
    const src = "a = 0 : b = 0\nIf c Then a = 1 : b = 2 Else a = 3 : b = 4\nd = 5";
    expect(vb(src, [["c", 0]], ["a", "b", "d"])).toEqual([3, 4, 5]);
    expect(vb(src, [["c", -1]], ["a", "b", "d"])).toEqual([1, 2, 5]);
    expect(one(vb("b = 0\nIf c Then a = 1 : b = 2", [["c", 0]], ["b"]))).toBe(0);
  });

  test("arithmetic and precedence; \\ and Mod round half to even first", () => {
    expect(one(vb("x = 2 + 3 * 4 - 6 / 2"))).toBe(11);
    expect(one(vb("x = 7.5 \\ 2"))).toBe(4);
    expect(one(vb("x = 6.5 Mod 4"))).toBe(2);
    expect(one(vb("x = -7 Mod 3"))).toBe(-1);
    expect(one(vb("x = -(2 + 3)"))).toBe(-5);
  });

  test("logic is bitwise with True = -1", () => {
    expect(one(vb("x = (1 < 2) And (3 > 2)"))).toBe(-1);
    expect(one(vb("x = Not True"))).toBe(0);
    expect(one(vb("x = 12 And 10"))).toBe(8);
    expect(one(vb("x = 12 Or 3"))).toBe(15);
    expect(one(vb("x = Not 0"))).toBe(-1);
  });

  test("concatenation, and an output left unset", () => {
    expect(vb("s = \"a\"\"b\" & n", [["n", 3]], ["s", "m"])).toEqual(["a\"b3", undefined]);
  });

  test("an output read before the script sets it is refused, in either language", () => {
    refused(() => vb("x = x + 1"));
    refused(() => js("x = x + 1;"));
    expect(one(vb("x = 1\nx = x + 1"))).toBe(2);
  });

  test("a name read before it is assigned is refused, a Dim one reads Empty", () => {
    refused(() => vb("x = never + 1"));
    expect(one(vb("Dim t\nx = t + 1"))).toBe(1);
  });

  test("numbers print with 15 significant digits, exponent forms are refused", () => {
    expect(one(vb("s = (0.1 + 0.2) & \"|\" & 2.5 & \"|\" & 7", [], ["s"]))).toBe("0.3|2.5|7");
    refused(() => vb("s = 1E+20 & \"\"", [], ["s"]));
  });

  test("refuses deep nesting and long strings", () => {
    for (const src of [`x = ${"(".repeat(10_000)}1${")".repeat(10_000)}`, `x = ${"Not ".repeat(10_000)}1`, `x = ${"-".repeat(10_000)}1`,
      `s = "ab"\n${"s = s & s\n".repeat(20)}`]) refused(() => vb(src, [], ["x", "s"]));
  });

  test("refuses what the subset does not implement", () => {
    for (const src of ["Function f()\nEnd Function", "x = Abs(-1)", "For i = 1 To 3\nNext", "x = 1 / 0", "x = 1 Mod 0", "If x Then\ny = 1", "x = 1 $ 2", "x = 1 y = 2"]) refused(() => vb(src));
  });
});
