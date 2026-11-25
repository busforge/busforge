import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { batchRows, classifyFailure, clearRowDir, heartbeatLine, loggedRows, logLine, planBatch, RESULT_FILE, RESULT_FORMAT, rowDirOf, rowLine, summary, UNKNOWN_DIALOG, type FailureClass, type RowKind, type RowResult } from "./ets-batch.ts";
import type { Row } from "./ets-catalogue.ts";
import { tempDir } from "./test-temp.ts";

const row = (application: string, manufacturer = application.slice(0, 6)): Row => ({
  application, manufacturer, manufacturerName: manufacturer, mask: "07B0", version: "1.1", name: application, orderNumber: `ON ${application}`, orderNumbers: [`ON ${application}`], catalogueEntries: 1,
});
const list = { rows: ["M-0001_A-0001-11-AAAA", "M-0002_A-0002-11-BBBB", "M-0003_A-0003-11-CCCC", "M-0004_A-0004-11-DDDD", "M-0005_A-0005-11-EEEE"].map((a) => row(a)) };
const ids = (rows: Row[]) => rows.map((r) => r.application.slice(0, 6));

const named = (f: FailureClass) => `${f.kind}${"reason" in f ? ` ${f.reason}` : ""}`;

const result = (application: string, kind: RowKind): RowResult => ({
  format: RESULT_FORMAT, application, manufacturer: application.slice(0, 6), mask: "07B0", orderNumber: `ON ${application}`, kind,
  minutes: 4.2, startedAt: "2026-11-25T12:00:00.000Z", endedAt: "2026-11-25T12:04:12.000Z", attempts: [{ kind, minutes: 4.2 }],
});
const finish = (out: string, application: string, kind: RowKind) => {
  mkdirSync(rowDirOf(out, application), { recursive: true });
  writeFileSync(join(rowDirOf(out, application), RESULT_FILE), JSON.stringify(result(application, kind)));
};

test("a batch's rows: the list's order, those named, from a row on, a count of them", () => {
  expect(ids(batchRows(list, {}))).toEqual(["M-0001", "M-0002", "M-0003", "M-0004", "M-0005"]);
  // Named in another order, run in the list's.
  expect(ids(batchRows(list, { only: ["M-0004_A-0004-11-DDDD", "M-0002_A-0002-11-BBBB"] }))).toEqual(["M-0002", "M-0004"]);
  expect(ids(batchRows(list, { from: "M-0003_A-0003-11-CCCC", count: 2 }))).toEqual(["M-0003", "M-0004"]);
  expect(() => batchRows(list, { only: ["M-0009_A-0009-11-9999"] })).toThrow("not rows of the list: M-0009_A-0009-11-9999");
  expect(() => batchRows(list, { only: ["M-0002_A-0002-11-BBBB"], from: "M-0001_A-0001-11-AAAA" })).toThrow("is no row of the batch");
});

test("a batch resumes at the first row without a result and passes the finished ones", () => {
  const out = tempDir("ets-batch");
  const rows = batchRows(list, {});
  finish(out, "M-0001_A-0001-11-AAAA", "completed");
  finish(out, "M-0002_A-0002-11-BBBB", "driver-failed");
  // A run that stopped in the middle of row 3: its directory without a result.
  mkdirSync(rowDirOf(out, "M-0003_A-0003-11-CCCC"), { recursive: true });
  writeFileSync(join(rowDirOf(out, "M-0003_A-0003-11-CCCC"), "ets6.log.txt"), "the row's start\n");
  finish(out, "M-0004_A-0004-11-DDDD", "sim-refused");
  const plan = planBatch(out, rows);
  expect(ids(plan.run)).toEqual(["M-0003", "M-0005"]);
  expect(plan.finished.map((f) => `${f.row.application.slice(0, 6)} ${f.result.kind}`)).toEqual(["M-0001 completed", "M-0002 driver-failed", "M-0004 sim-refused"]);
  // Asked: the driver-failed rows again, and one named row.
  expect(ids(planBatch(out, rows, { kinds: ["driver-failed"] }).run)).toEqual(["M-0002", "M-0003", "M-0005"]);
  expect(ids(planBatch(out, rows, { applications: ["M-0001_A-0001-11-AAAA"] }).run)).toEqual(["M-0001", "M-0003", "M-0005"]);
  // The stopped row's directory moved aside before it runs again, never deleted; an empty or missing one stays.
  const aside = clearRowDir(out, "M-0003_A-0003-11-CCCC", "t1");
  expect(aside).toBe(join(out, ".interrupted", "M-0003_A-0003-11-CCCC-t1"));
  expect(readdirSync(aside!)).toEqual(["ets6.log.txt"]);
  expect(existsSync(rowDirOf(out, "M-0003_A-0003-11-CCCC"))).toBe(false);
  expect(clearRowDir(out, "M-0005_A-0005-11-EEEE", "t1")).toBeNull();
  // A result of another format is refused, not taken as finished or as missing.
  writeFileSync(join(rowDirOf(out, "M-0004_A-0004-11-DDDD"), RESULT_FILE), JSON.stringify({ ...result("M-0004_A-0004-11-DDDD", "completed"), format: "busforge-ets-batch-result/0" }));
  expect(() => planBatch(out, rows)).toThrow("is of format busforge-ets-batch-result/0");
});

// The driver's messages, as recorded: in the batch logs and row directories of the runner's acceptance batch, and
// in the logs of the catalogue download (tools/ets-driver.ts catalogue-download), whose bench host went to sleep.
test("a failure's class from the driver's recorded messages", () => {
  const c = (why: string) => named(classifyFailure(why));
  // The bench host asleep: spawnSync's timeout of the ssh call, ssh's own message.
  expect(c("the driver broke off: spawnSync ssh ETIMEDOUT")).toBe("pause host");
  expect(c("the driver broke off: on tf@192.168.1.231 (255): ssh: connect to host 192.168.1.231 port 22: Operation timed out\nbash -s")).toBe("pause host");
  expect(c("the driver broke off: on tf@192.168.1.231 (255): ssh: connect to host 192.168.1.231 port 22: Host is down")).toBe("pause host");
  // The online catalogue refusing a product download (OCR reads "fehigeschlagen").
  expect(c("ETS shows a dialog after the insert: 4 Online-Katalog-Download fehigeschlagen UGW Triple-XT Profinet/LON Der Produktdownload aus dem Online-Katalog ist fehlgeschlagen. Bitte tiberp")).toBe("pause catalogue");
  // ETS killed under the row, whatever the step met then.
  expect(c("ETS's window is gone: the catalogue's insert target is not line 1.1")).toBe("restart ets-gone");
  expect(c("ETS's window is gone (before \"the product's export\")")).toBe("restart ets-gone");
  // A dialog the driver does not know: ETS's project details, opened under a row.
  expect(c(`${UNKNOWN_DIALOG} (before "the product's export"): Busforge Sweep Details > Beschreibung Zuletzt geandert Geschatzte Projektgrae Jetzt komprimieren...`)).toBe("dialog");
  // A row's own failure.
  expect(c("no catalogue row with order number TB/U1 runs M-0002_A-4201-13-6B9E-O0007 (read: TB/U1 $4201 1.3 D98E)")).toBe("row");
  expect(c("the catalogue lists more rows for order number 1 than its grid shows at once")).toBe("row");
});

// Dialog texts no run has shown yet, in the forms ETS gives them: each is a class the runner acts on, so each is
// pinned by its words alone.
test("a dialog's class from the words that name it", () => {
  const c = (dialog: string) => named(classifyFailure(`${UNKNOWN_DIALOG} (before "insert"): ${dialog}`));
  expect(c("Anmelden Melden Sie sich mit Ihrer KNX ID an")).toBe("pause login");
  expect(c("Scannen Sie den QR-Code")).toBe("pause login");
  expect(c("Fehler Die Sammlung wurde geändert. Der Enumerationsvorgang kann möglicherweise nicht ausgeführt werden.")).toBe("restart ets-internal");
  expect(c("System.ArgumentOutOfRangeException: Index and length must refer to a location within the string.")).toBe("restart ets-internal");
  expect(c("Projektpasswort setzen")).toBe("dialog");
});

test("the batch log: a line per row with its minutes and kind, the last of a row counted", () => {
  const at = new Date("2026-11-25T12:00:00.000Z");
  const r = { ...result("M-0002_A-0002-11-BBBB", "driver-failed"), why: "ETS's window is gone: x\n y", attempts: [{ kind: "restarted" as const, minutes: 2 }, { kind: "driver-failed" as const, minutes: 2.2 }] };
  const log = [
    logLine(at, "batch of 3 rows of list.json: 0 with a result, 3 to run"),
    logLine(at, rowLine(1, 3, result("M-0001_A-0001-11-AAAA", "completed"))),
    logLine(at, heartbeatLine(2, 3, "M-0002_A-0002-11-BBBB", "insert", 3.04)),
    logLine(at, rowLine(2, 3, r)),
    logLine(at, rowLine(3, 3, result("M-0003_A-0003-11-CCCC", "sim-refused"))),
    // Row 2 run again (--rerun-failed): its last line counts.
    logLine(at, rowLine(2, 3, result("M-0002_A-0002-11-BBBB", "completed"))),
  ].join("");
  expect(log.split("\n")[2]).toBe('2026-11-25T12:00:00.000Z heartbeat row 2/3 M-0002_A-0002-11-BBBB at "insert" for 3.0 min');
  expect(log.split("\n")[3]).toBe("2026-11-25T12:00:00.000Z row 2/3 M-0002_A-0002-11-BBBB M-0002 07B0: driver-failed 4.2 min (2 attempts): ETS's window is gone: x y");
  expect(loggedRows(log)).toEqual([
    { application: "M-0001_A-0001-11-AAAA", kind: "completed", minutes: 4.2, attempts: 1 },
    { application: "M-0003_A-0003-11-CCCC", kind: "sim-refused", minutes: 4.2, attempts: 1 },
    { application: "M-0002_A-0002-11-BBBB", kind: "completed", minutes: 4.2, attempts: 1 },
  ]);
  expect(summary(loggedRows(log))).toBe("3 rows: completed 2 (4.2 min each), sim-refused 1 (4.2 min each)");
});
