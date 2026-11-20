// The image build context check of `bun run check`, without Docker: the files Docker would send as
// the build context (the repository filtered through `.dockerignore`, with BuildKit's matching rules)
// are judged by the same rule the Dockerfile's `source` stage applies with `find`. The rule is read
// from the Dockerfile itself, so there is one rule: a `.dockerignore` that lets a test, a fixture or
// a tool through fails here, with the list of files, instead of in the image build on CI.
//
//   bun run tools/image-context.ts [repository root]
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---- .dockerignore, as moby/patternmatcher reads it and BuildKit matches it ----

export interface IgnorePattern {
  readonly source: string; // the cleaned pattern, without `!`
  readonly exception: boolean;
  readonly match: (path: string) => boolean;
}

function cleanPath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!p.startsWith("/")) out.push("..");
      continue;
    }
    out.push(part);
  }
  return out.join("/") || ".";
}

// Docker's translation of a pattern into a regular expression: `*` and `?` stay within one path
// component, `**` spans any number of them (none included).
function ignoreRegex(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        re += i + 1 >= pattern.length ? ".*" : "(.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += /[.+()|{}$]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`${re}$`);
}

// A pattern that starts with `**` and has no other wildcard is a plain suffix to Docker (`**foo`
// excludes `x/barfoo`; `**/foo` also excludes `foo`). Bracket expressions and escapes are refused.
function ignoreMatcher(pattern: string): (path: string) => boolean {
  if (/[[\\]/.test(pattern)) throw new Error(`.dockerignore: pattern ${JSON.stringify(pattern)} uses a bracket or escape, which tools/image-context.ts does not read`);
  const suffix = pattern.slice(2);
  if (pattern.startsWith("**") && !/[*?]/.test(suffix)) return (path) => path.endsWith(suffix) || (suffix.startsWith("/") && path === suffix.slice(1));
  const re = ignoreRegex(pattern);
  return (path) => re.test(path);
}

export function parseDockerignore(text: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];
  for (const line of text.replace(/^﻿/, "").split("\n")) {
    if (line.startsWith("#")) continue;
    let p = line.trim();
    if (p === "") continue;
    const exception = p.startsWith("!");
    if (exception) p = p.slice(1).trim();
    if (p === "") throw new Error(".dockerignore: a lone \"!\" is an illegal exclusion pattern");
    p = cleanPath(p);
    patterns.push({ source: p, exception, match: ignoreMatcher(p) });
  }
  return patterns;
}

// One step of BuildKit's walk (patternmatcher's MatchesUsingParentResults): a pattern is evaluated
// only when it could change the outcome so far (an exception while the path is excluded, an exclusion
// while it is not), a pattern the parent directory matched counts as matched, and every other one is
// matched against the path itself. `parent` holds, per pattern, whether it matched the parent.
function matchStep(patterns: readonly IgnorePattern[], path: string, parent: readonly boolean[]): { out: boolean; matched: boolean[] } {
  let out = false;
  const matched = patterns.map((p, i) => {
    let m = parent[i]!;
    if (p.exception !== out) return m;
    if (!m) m = p.match(path);
    if (m) out = !p.exception;
    return m;
  });
  return { out, matched };
}

// Whether Docker leaves `path` (relative, `/`-separated) out of the context.
export function excluded(patterns: readonly IgnorePattern[], path: string): boolean {
  let state = { out: false, matched: patterns.map(() => false) };
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) state = matchStep(patterns, parts.slice(0, i).join("/"), state.matched);
  return state.out;
}

// Whether some exception could match a path below the excluded directory `dir` directly, so the walk
// has to enter it. Below an excluded directory only such a direct match takes a path back: the
// exclusion that decided `dir` is inherited, and every later exception did not match `dir`.
function exceptionBelow(patterns: readonly IgnorePattern[], dir: string): boolean {
  const dirParts = dir.split("/");
  return patterns.some((p) => {
    if (!p.exception) return false;
    const parts = p.source.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.includes("**")) return true;
      if (i >= dirParts.length) return true;
      if (!ignoreRegex(parts[i]!).test(dirParts[i]!)) return false;
    }
    return false;
  });
}

// The entries of the build context, relative and sorted: every file Docker sends, every directory it
// sends, and the parent directories of both.
export function contextEntries(root: string, patterns: readonly IgnorePattern[]): string[] {
  const entries = new Set<string>();
  const addWithParents = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) entries.add(parts.slice(0, i).join("/"));
  };
  const walk = (dir: string, parent: readonly boolean[]) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = dir === "" ? name : `${dir}/${name}`;
      const isDir = lstatSync(join(root, path)).isDirectory();
      const { out, matched } = matchStep(patterns, path, parent);
      if (!out) addWithParents(path);
      if (isDir && (!out || exceptionBelow(patterns, path))) walk(path, matched);
    }
  };
  walk("", patterns.map(() => false));
  return [...entries].sort();
}

// ---- the Dockerfile's rule ----

export interface LeakRule {
  readonly names: readonly string[]; // `find -name`: matched against the entry's own name
  readonly paths: readonly string[]; // `find -path`: matched against `./<entry>`
  readonly onlyDir: string; // `find ./<onlyDir> -mindepth 1 ! -name <onlyKeep>`
  readonly onlyKeep: string;
}

// The words of a `find` expression with no expansion in it: quotes are removed, and an expansion
// (`$`, a backquote, an escape) or an unquoted glob, which the shell would expand first, is refused.
function shellWords(text: string): string[] {
  if (/[$`\\]/.test(text)) throw new Error(`Dockerfile: the context check's find expression holds a shell expansion or escape, which tools/image-context.ts does not read`);
  const words: string[] = [];
  for (const m of text.matchAll(/'([^']*)'|"([^"]*)"|([^\s'"]+)/g)) {
    if (m[3] !== undefined && /[*?[]/.test(m[3])) throw new Error(`Dockerfile: unquoted glob ${JSON.stringify(m[3])} in the context check, which the shell would expand`);
    words.push(m[1] ?? m[2] ?? m[3]!);
  }
  return words;
}

// fnmatch as `find -name` and `find -path` use it: `*` and `?` match any character, `/` and a leading
// `.` included. Bracket expressions are refused.
function findRegex(pattern: string): RegExp {
  if (pattern.includes("[")) throw new Error(`Dockerfile: find pattern ${JSON.stringify(pattern)} uses a bracket expression, which tools/image-context.ts does not read`);
  const re = pattern.replace(/[^*?]/g, (c) => (/[\w/-]/.test(c) ? c : `\\${c}`)).replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "s");
}

// The `find` expressions of the `RUN leaked=$(find ...)` instruction. Only the shape the Dockerfile
// has is understood; any other is refused, so a changed check cannot be read as a weaker one.
export function parseLeakRule(dockerfile: string): LeakRule {
  const instructions = dockerfile.replace(/\\\n/g, " ").split("\n");
  const runs = instructions.filter((l) => /^RUN\s+leaked=\$\(find /.test(l));
  if (runs.length !== 1) throw new Error(`Dockerfile: expected one "RUN leaked=$(find ..." instruction, found ${runs.length}`);
  const run = runs[0]!;
  const finds = run.match(/\bfind\s/g)?.length ?? 0;
  const main = run.match(/leaked=\$\(find \. \\\( (.*?) \\\) -print; /);
  const only = run.match(/ find \.\/([\w.-]+) -mindepth 1 ! -name ([\w.-]+) -print\);/);
  if (finds !== 2 || !main || !only) {
    throw new Error("Dockerfile: the context check no longer has the shape tools/image-context.ts reads; update both together");
  }
  const words = shellWords(main[1]!);
  const names: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < words.length; i += 3) {
    const [primary, value, or] = [words[i], words[i + 1], words[i + 2]];
    const last = i + 2 >= words.length;
    if (value === undefined || (!last && or !== "-o") || (primary !== "-name" && primary !== "-path")) {
      throw new Error(`Dockerfile: unexpected find expression near ${JSON.stringify(words.slice(i, i + 3).join(" "))}`);
    }
    findRegex(value);
    (primary === "-name" ? names : paths).push(value);
  }
  if (names.length === 0) throw new Error("Dockerfile: the context check names no forbidden name");
  return { names, paths, onlyDir: only[1]!, onlyKeep: only[2]! };
}

// The entries the Dockerfile's `find` would print, together with the context entries below a printed
// directory, so every file that leaks is named.
export function leaks(entries: readonly string[], rule: LeakRule): string[] {
  const names = rule.names.map(findRegex);
  const paths = rule.paths.map(findRegex);
  const keep = findRegex(rule.onlyKeep);
  const hits = entries.filter((e) => {
    const name = e.slice(e.lastIndexOf("/") + 1);
    if (names.some((n) => n.test(name)) || paths.some((p) => p.test(`./${e}`))) return true;
    return e.startsWith(`${rule.onlyDir}/`) && !keep.test(name);
  });
  return entries.filter((e) => hits.some((h) => e === h || e.startsWith(`${h}/`)));
}

// BuildKit reads `<Dockerfile>.dockerignore` in place of `.dockerignore` when it exists.
export function checkImageContext(root: string): string[] {
  if (existsSync(join(root, "Dockerfile.dockerignore"))) throw new Error("Dockerfile.dockerignore exists; tools/image-context.ts reads only .dockerignore");
  const rule = parseLeakRule(readFileSync(join(root, "Dockerfile"), "utf8"));
  const patterns = parseDockerignore(readFileSync(join(root, ".dockerignore"), "utf8"));
  return leaks(contextEntries(root, patterns), rule);
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dir, "..");
  const leaked = checkImageContext(root);
  if (leaked.length > 0) {
    console.error(`build context is not the .dockerignore allowlist (the Dockerfile's source stage refuses it):\n  ${leaked.join("\n  ")}`);
    process.exit(1);
  }
  console.log("image build context: no test, fixture, tool or local state passes .dockerignore");
}
