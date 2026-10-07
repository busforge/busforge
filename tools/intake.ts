#!/usr/bin/env bun
// Take a diagnostic package a user sent into the private corpus, list what was received, delete a
// package (tools/received.ts; the procedure: received-packages.md in the corpus). Works only on the
// corpus BUSFORGE_CORPUS names; opens no connection and serves nothing.
//
//   bun run tools/intake.ts add <package.json> --from=<text> --issue=<ref> --consent=<text>
//        --consented-at=<YYYY-MM-DD> --configured-by=ets|busforge|unknown
//        --prior-busforge-writes=none|some|unknown [--received-at=<YYYY-MM-DD>]
//   bun run tools/intake.ts list
//   bun run tools/intake.ts remove <id> [--independent=<path> ...]
//
// --from           who sent it and by which route
// --issue          the issue the package belongs to
// --consent        the sender's consent to keeping it for internal regression tests, as given
// --configured-by, --prior-busforge-writes
//                  who configured the device it was read from, as the sender states it; this decides
//                  whether the package can stand as an independent reference (docs/evidence-contract.md)
// --received-at    default: today (UTC); not in the future
// --independent    remove: a file that holds bytes of the package but was not made from it (an own
//                  capture of the same product); may be given more than once
//
// Exit 0: done. Exit 1: refused, the reason on stderr; nothing was stored or deleted. Exit 2: usage.
import { corpusRoot, CORPUS_ENV } from "./corpus.ts";
import { IntakeRefused, loadReceived, receive, removeReceived, trackedFiles } from "./received.ts";
import type { DeclaredOrigin } from "./evidence.ts";

const USAGE = `usage: bun run tools/intake.ts add <package.json> --from=<text> --issue=<ref> --consent=<text> --consented-at=<YYYY-MM-DD> --configured-by=ets|busforge|unknown --prior-busforge-writes=none|some|unknown [--received-at=<YYYY-MM-DD>]
       bun run tools/intake.ts list
       bun run tools/intake.ts remove <id> [--independent=<path> ...]`;
const ADD_FLAGS = ["from", "issue", "consent", "consented-at", "configured-by", "prior-busforge-writes"];
const OPTIONAL_FLAGS = ["received-at"];

function usage(problem: string): never {
  console.error(problem);
  console.error(USAGE);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith("--"));
const flags = new Map<string, string>();
const independent: string[] = [];
for (const a of rest.filter((x) => x.startsWith("--"))) {
  const m = /^--([a-z-]+)=(.*)$/s.exec(a);
  if (m && m[1] === "independent" && command === "remove") {
    if (m[2] === "") usage("option without a value: --independent");
    independent.push(m[2]);
    continue;
  }
  if (!m || ![...ADD_FLAGS, ...OPTIONAL_FLAGS].includes(m[1]) || command !== "add") usage(`unknown option ${a.split("=")[0]}`);
  if (flags.has(m[1])) usage(`option given more than once: --${m[1]}`);
  if (m[2] === "") usage(`option without a value: --${m[1]}`);
  flags.set(m[1], m[2]);
}

const corpus = corpusRoot();
if (corpus === null) {
  console.error(`${CORPUS_ENV} is unset: received packages are kept in the private corpus (docs/testing.md, "The private corpus")`);
  process.exit(1);
}

try {
  if (command === "add") {
    if (positional.length !== 1) usage(`add takes one file, got ${positional.length}`);
    const missing = ADD_FLAGS.filter((f) => !flags.has(f));
    if (missing.length) usage(`add needs ${missing.map((f) => `--${f}`).join(", ")}`);
    const f = (k: string) => flags.get(k) as string;
    const today = new Date().toISOString().slice(0, 10);
    const receivedAt = flags.get("received-at") ?? today;
    if (receivedAt > today) usage(`--received-at=${receivedAt} is in the future`);
    const r = receive(corpus, positional[0], {
      from: f("from"), issue: f("issue"),
      consent: { statement: f("consent"), givenAt: f("consented-at") },
      origin: { configuredBy: f("configured-by"), priorBusforgeWrites: f("prior-busforge-writes") } as DeclaredOrigin,
      receivedAt,
    });
    console.log(`received ${r.id}: ${r.pkg.ia} ${r.pkg.mask ?? "mask unknown"}, ${r.pkg.records.length} records, reference "${r.provenance.reference}"`);
    console.log(`the file ${positional[0]} was copied, not moved: delete it where the transfer left it`);
  } else if (command === "list") {
    if (positional.length !== 0) usage("list takes no arguments");
    const all = loadReceived(corpus);
    for (const r of all) {
      console.log(`${r.id}  ${r.provenance.receivedAt}  ${r.pkg.ia.padEnd(9)} ${(r.pkg.mask ?? "-").padEnd(8)} ${r.provenance.reference.padEnd(33)} ${r.provenance.issue}`);
    }
    console.log(`${all.length} received package${all.length === 1 ? "" : "s"}`);
  } else if (command === "remove") {
    if (positional.length !== 1) usage(`remove takes one id, got ${positional.length}`);
    const dir = removeReceived(corpus, positional[0], trackedFiles(), independent);
    console.log(`deleted ${dir}; copies in backups of the corpus are not reached (received-packages.md in the corpus, "Deleting a package")`);
  } else {
    usage(command === undefined ? "no command" : `unknown command ${command}`);
  }
} catch (e) {
  if (!(e instanceof IntakeRefused)) throw e;
  console.error(`refused: ${e.message}`);
  process.exit(1);
}
