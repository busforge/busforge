// The application of a product is the ApplicationProgramRef of its Hardware2Program that is the
// application (packages/project/src/knxproj.ts, hardwareApplications), no longer the program the
// Hardware2Program id's form names. On one-program hardware both are the same program; on two-program
// (PEI) hardware the Hardware2Program id carries both programs' parts so its form names no program, and
// the application resolves from the ApplicationProgramRef whose program declares
// ProgramType="ApplicationProgram". This holds for every product of every .knxproj and .knxprod of the
// private corpus, and for every device of every corpus project, verified independently against each
// archive's Hardware2Program refs and program XML ProgramType attributes.
//
// The protected projects open only with their passwords (tools/corpus-archives.ts, KNXPROJ_PASSWORDS);
// without them their devices' test is registered as skipped under a name that says so.
import { expect, setDefaultTimeout, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { appProgramId, extractAppPrograms, extractCatalogProducts, hardwarePrograms, loadKnxproj, type CatalogProduct } from "../packages/project/src/index.ts";
import { bytesOf, codeOf, corpusArchives, describeFailure, extensionOf, NOT_THIS_PASSWORD, PASSWORDS_ENV, passwords } from "./corpus-archives.ts";
import { corpusTest } from "./corpus-test.ts";

// Every project of the corpus is unpacked, the protected ones with AES (about 98 MiB); the floor of docs/testing.md applies.
setDefaultTimeout(120_000);

const archives = () => corpusArchives().filter((f) => extensionOf(f) !== "busforge");
// The application a product had before: the program its Hardware2Program id names, none without one.
const before = (p: Pick<CatalogProduct, "appRef" | "hasApplication">) => (p.hasApplication ? appProgramId(p.appRef) : "");

// Parse only the ApplicationProgram element's attributes to read ProgramType independently of applicationOf.
const programHeaderParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: () => false,
  stopNodes: ["*.ApplicationProgram"],
});

function programTypeOf(xml: string, id: string): string {
  const doc = programHeaderParser.parse(xml) as Record<string, unknown>;
  const knx = doc.KNX as Record<string, unknown> | undefined;
  const md = knx?.ManufacturerData as Record<string, unknown> | undefined;
  const rawManu = md?.Manufacturer;
  const manus = Array.isArray(rawManu) ? rawManu : rawManu ? [rawManu] : [];
  for (const m of manus) {
    const aps = (m as Record<string, unknown>)?.ApplicationPrograms as Record<string, unknown> | undefined;
    const rawAp = aps?.ApplicationProgram;
    const programs = Array.isArray(rawAp) ? rawAp : rawAp ? [rawAp] : [];
    for (const a of programs) {
      const rec = a as Record<string, unknown>;
      if (rec.Id === id && typeof rec.ProgramType === "string") return rec.ProgramType;
    }
  }
  return "";
}

type ResolutionCheck = { issue: string | null; twoProgram: boolean; differedFromIdForm: boolean };

// Verify one resolved application id against its Hardware2Program: on one-program hardware it must match
// the id form; on two-program (PEI) hardware it must match the single ApplicationProgramRef whose program
// XML declares ProgramType="ApplicationProgram" (with the remaining ref(s) declaring "PeiProgram").
function checkResolution(file: string, label: string, bytes: Buffer, p: CatalogProduct, resolved: string): ResolutionCheck {
  const idForm = before(p);
  if (!p.peiProgram) {
    return {
      issue: resolved === idForm ? null : `${file}: ${label} on ${p.appRef}: ${idForm || "none"} before, ${resolved || "none"} now`,
      twoProgram: false,
      differedFromIdForm: false,
    };
  }
  const refs = hardwarePrograms(bytes).get(p.appRef) ?? [];
  const xmls = extractAppPrograms(bytes, refs);
  const types = refs.map((id) => {
    const xml = xmls.get(id);
    return xml ? programTypeOf(xml, id) : "";
  });
  const apps = refs.filter((_, i) => types[i] === "ApplicationProgram");
  const peis = refs.filter((_, i) => types[i] === "PeiProgram");
  if (refs.length < 2 || apps.length !== 1 || peis.length !== refs.length - 1) {
    const summary = refs.map((id, i) => `${id}=${types[i] || "missing"}`).join(", ");
    return {
      issue: `${file}: ${label} on ${p.appRef}: two-program archive does not distinguish one ApplicationProgram and PEI program(s) (${summary})`,
      twoProgram: true,
      differedFromIdForm: false,
    };
  }
  const expected = apps[0];
  return {
    issue: resolved === expected ? null : `${file}: ${label} on ${p.appRef}: expected ApplicationProgram ${expected}, got ${resolved || "none"}`,
    twoProgram: true,
    differedFromIdForm: resolved !== idForm,
  };
}

corpusTest("every product of the corpus resolves its application (one-program matches the id form, two-program resolves ProgramType=ApplicationProgram)", () => {
  const issues: string[] = [];
  let products = 0, twoProgram = 0, differedFromIdForm = 0;
  const files = archives();
  for (const file of files) {
    const bytes = bytesOf(file);
    for (const p of extractCatalogProducts(bytes)) {
      products++;
      const r = checkResolution(file, p.productRef, bytes, p, p.appProgramId);
      if (r.issue) issues.push(r.issue);
      if (r.twoProgram) twoProgram++;
      if (r.differedFromIdForm) differedFromIdForm++;
    }
  }
  console.log(`${products} products in ${files.length} corpus archives, ${twoProgram} on two-program hardware (${differedFromIdForm} differing from id form)`);
  expect(issues).toEqual([]);
  // Minimum corpus floors: at least 343 products total (base corpus floor) and at least 3 on
  // two-program (PEI) hardware whose resolved ApplicationProgram differs from the id form.
  expect(products).toBeGreaterThanOrEqual(343);
  expect(twoProgram).toBeGreaterThanOrEqual(3);
  expect(differedFromIdForm).toBeGreaterThanOrEqual(3);
});

// Check every device of the corpus project `file`: one-program hardware keeps the application its
// Hardware2Program id named (or the id's form where no Hardware.xml describes it); two-program (PEI)
// hardware resolves the ApplicationProgram ref verified independently from the archive's program XMLs.
function checkDevices(file: string, password: string | undefined): { issues: string[]; twoProgram: number; differedFromIdForm: number } {
  const bytes = bytesOf(file);
  const products = new Map(extractCatalogProducts(bytes).map((p) => [p.appRef, p]));
  const issues: string[] = [];
  let twoProgram = 0, differedFromIdForm = 0;
  for (const d of loadKnxproj(bytes, password, file).devices) {
    const p = products.get(d.appRef);
    if (p) {
      const r = checkResolution(file, d.ia, bytes, p, d.appProgramId);
      if (r.issue) issues.push(r.issue);
      if (r.twoProgram) twoProgram++;
      if (r.differedFromIdForm) differedFromIdForm++;
    } else {
      const was = appProgramId(d.appRef);
      if (d.appProgramId !== was) issues.push(`${file}: ${d.ia} on ${d.appRef}: ${was || "none"} before, ${d.appProgramId || "none"} now`);
    }
  }
  return { issues, twoProgram, differedFromIdForm };
}
const projects = () => archives().filter((f) => extensionOf(f) === "knxproj");
const asksForPassword = (e: unknown) => codeOf(e) === "PASSWORD_REQUIRED";

corpusTest("every device of every corpus project that needs no password resolves its application", () => {
  const issues: string[] = [];
  let opened = 0, twoProgram = 0, differedFromIdForm = 0;
  for (const file of projects()) {
    try {
      const r = checkDevices(file, undefined);
      issues.push(...r.issues);
      twoProgram += r.twoProgram;
      differedFromIdForm += r.differedFromIdForm;
      opened++;
    } catch (e) { if (!asksForPassword(e)) issues.push(`${file}: ${describeFailure(e)}`); }
  }
  expect(issues).toEqual([]);
  expect(opened).toBeGreaterThan(0);
  expect(twoProgram).toBeGreaterThanOrEqual(3);
  expect(differedFromIdForm).toBeGreaterThanOrEqual(3);
});

if (passwords().length === 0) {
  console.log(`[needs ${PASSWORDS_ENV}] not run: every device of every password-protected corpus project resolves its application`);
  test.skip(`[needs ${PASSWORDS_ENV}] every device of every password-protected corpus project resolves its application`, () => {});
} else {
  corpusTest("every device of every password-protected corpus project resolves its application", () => {
    const issues: string[] = [];
    let opened = 0;
    for (const file of projects()) {
      try { loadKnxproj(bytesOf(file), undefined, file); continue; } catch (e) { if (!asksForPassword(e)) continue; }
      // The password that opens the project: a wrong one fails the decryption, and the next is tried.
      let result: string[] | undefined;
      for (const pw of passwords()) {
        try { result = checkDevices(file, pw).issues; break; }
        catch (e) { if (!NOT_THIS_PASSWORD.has(codeOf(e) ?? "")) { result = [`${file}: ${describeFailure(e)}`]; break; } }
      }
      if (!result) { issues.push(`${file}: none of the passwords in ${PASSWORDS_ENV} opens it`); continue; }
      issues.push(...result);
      opened++;
    }
    expect(issues).toEqual([]);
    expect(opened).toBeGreaterThan(0);
  });
}
