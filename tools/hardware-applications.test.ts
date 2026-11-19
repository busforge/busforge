// The application of a product is the ApplicationProgramRef of its Hardware2Program that is the
// application (packages/project/src/knxproj.ts, hardwareApplications), no longer the program the
// Hardware2Program id's form names. On one-program hardware both are the same program; this holds it for
// every product of every .knxproj and .knxprod of the private corpus, and for every device of every corpus
// project. Two-program hardware is left out of the comparison (its id names no program); the corpus holds
// none, and the count says so.
//
// The protected projects open only with their passwords (tools/corpus-archives.ts, KNXPROJ_PASSWORDS);
// without them their devices' test is registered as skipped under a name that says so.
import { expect, setDefaultTimeout, test } from "bun:test";
import { appProgramId, extractCatalogProducts, loadKnxproj, type CatalogProduct } from "../packages/project/src/index.ts";
import { bytesOf, corpusArchives, describeFailure, extensionOf, PASSWORDS_ENV, passwords } from "./corpus-archives.ts";
import { corpusTest } from "./corpus-test.ts";

// Every project of the corpus is unpacked, the protected ones with AES (about 98 MiB); the floor of docs/testing.md applies.
setDefaultTimeout(120_000);

const archives = () => corpusArchives().filter((f) => extensionOf(f) !== "busforge");
// The application a product had before: the program its Hardware2Program id names, none without one.
const before = (p: Pick<CatalogProduct, "appRef" | "hasApplication">) => (p.hasApplication ? appProgramId(p.appRef) : "");

corpusTest("every one-program product of the corpus keeps the application its Hardware2Program id named", () => {
  const changed: string[] = [];
  let products = 0, twoProgram = 0;
  const files = archives();
  for (const file of files) {
    for (const p of extractCatalogProducts(bytesOf(file))) {
      products++;
      if (p.peiProgram) { twoProgram++; continue; }
      if (p.appProgramId !== before(p)) changed.push(`${file}: ${p.productRef} on ${p.appRef}: ${before(p) || "none"} before, ${p.appProgramId || "none"} now`);
    }
  }
  console.log(`${products} products in ${files.length} corpus archives, ${twoProgram} on two-program hardware`);
  expect(changed).toEqual([]);
  // Every product of the corpus as it stands (343 in 36 archives); none on two-program hardware.
  expect(products).toBeGreaterThanOrEqual(343);
  expect(twoProgram).toBe(0);
});

// Each device of the corpus project `file` whose application differs from before: its Hardware2Program
// as the archive's Hardware.xml describes it, or the id's form where none does.
function changedDevices(file: string, password: string | undefined): string[] {
  const bytes = bytesOf(file);
  const products = new Map(extractCatalogProducts(bytes).map((p) => [p.appRef, p]));
  return loadKnxproj(bytes, password, file).devices.flatMap((d) => {
    const p = products.get(d.appRef);
    if (p?.peiProgram) return [];
    const was = p ? before(p) : appProgramId(d.appRef);
    return d.appProgramId === was ? [] : [`${file}: ${d.ia} on ${d.appRef}: ${was || "none"} before, ${d.appProgramId || "none"} now`];
  });
}
const projects = () => archives().filter((f) => extensionOf(f) === "knxproj");
const asksForPassword = (e: unknown) => (e as { code?: string }).code === "PASSWORD_REQUIRED";
// The refusals of a password that is not the project's (tools/corpus-archives.ts).
const NOT_THIS_PASSWORD = new Set(["WRONG_PASSWORD", "DECRYPT_FAILED", "ZIPCRYPTO_PASSWORD_ENCODING"]);

corpusTest("every device of every corpus project that needs no password runs the application it ran before", () => {
  const changed: string[] = [];
  let opened = 0;
  for (const file of projects()) {
    try { changed.push(...changedDevices(file, undefined)); opened++; }
    catch (e) { if (!asksForPassword(e)) changed.push(`${file}: ${describeFailure(e)}`); }
  }
  expect(changed).toEqual([]);
  expect(opened).toBeGreaterThan(0);
});

if (passwords().length === 0) {
  console.log(`[needs ${PASSWORDS_ENV}] not run: every device of every password-protected corpus project runs the application it ran before`);
  test.skip(`[needs ${PASSWORDS_ENV}] every device of every password-protected corpus project runs the application it ran before`, () => {});
} else {
  corpusTest("every device of every password-protected corpus project runs the application it ran before", () => {
    const changed: string[] = [];
    let opened = 0;
    for (const file of projects()) {
      try { loadKnxproj(bytesOf(file), undefined, file); continue; } catch (e) { if (!asksForPassword(e)) continue; }
      // The password that opens the project: a wrong one fails the decryption, and the next is tried.
      let result: string[] | undefined;
      for (const pw of passwords()) {
        try { result = changedDevices(file, pw); break; }
        catch (e) { if (!NOT_THIS_PASSWORD.has((e as { code?: string }).code ?? "")) { result = [`${file}: ${describeFailure(e)}`]; break; } }
      }
      if (!result) { changed.push(`${file}: none of the passwords in ${PASSWORDS_ENV} opens it`); continue; }
      changed.push(...result);
      opened++;
    }
    expect(changed).toEqual([]);
    expect(opened).toBeGreaterThan(0);
  });
}
