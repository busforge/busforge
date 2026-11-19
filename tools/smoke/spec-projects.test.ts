// A smoke spec that imports an ETS project (provision "import-knxproj") names the project file in the private
// corpus (device.knxprod). The runner imports it and takes the unit's tool key and its group keys from it, so
// the file has to hold, for the spec's address, the spec's product and application, a tool key, and a group key
// for every secured group address a behaviour reads. The file opens with the bench ETS project's password
// (tools/corpus-archives.ts, KNXPROJ_PASSWORDS); without it the test is registered as skipped under a name that
// says so. That the tool key is the one the unit holds today only a bench run shows.
import { expect, setDefaultTimeout, test } from "bun:test";
import { loadKnxproj, type Project } from "../../packages/project/src/index.ts";
import { corpusPath } from "../corpus.ts";
import { NOT_THIS_PASSWORD, PASSWORDS_ENV, codeOf, passwords } from "../corpus-archives.ts";
import { corpusTest } from "../corpus-test.ts";
import { readFileSync } from "node:fs";
import { SPECS } from "./specs/index.ts";

// Opening a protected project decrypts about 1.6 MiB of AES; the floor of docs/testing.md applies.
setDefaultTimeout(60_000);

const imported = SPECS.filter((s) => s.provision === "import-knxproj");

const opened = new Map<string, Project>();
function open(file: string): Project {
  const cached = opened.get(file);
  if (cached) return cached;
  const bytes = readFileSync(corpusPath(file));
  let last: unknown;
  for (const pw of passwords()) {
    try { const p = loadKnxproj(bytes, pw, file); opened.set(file, p); return p; } catch (e) { last = e; if (!NOT_THIS_PASSWORD.has(codeOf(e) ?? "")) throw e; }
  }
  throw new Error(`none of the passwords in ${PASSWORDS_ENV} opens ${file}: ${String(last)}`);
}

const NAME = "every project a smoke spec imports holds the spec's unit with its tool key, and the group keys its secured reads use";
const check = () => {
  expect(imported.map((s) => s.id).sort()).toEqual(["gvs-amma", "jung-400021se-secure"]);
  const problems: string[] = [];
  for (const s of imported) {
    const file = s.device.knxprod;
    if (!file) { problems.push(`${s.id}: no device.knxprod`); continue; }
    const project = open(file);
    const dev = project.devices.find((d) => d.ia === s.device.ia);
    if (!dev) { problems.push(`${s.id}: ${file} holds no device at ${s.device.ia}`); continue; }
    if (dev.productRef !== s.device.productRef) problems.push(`${s.id}: ${file} has ${dev.productRef} at ${s.device.ia}, the spec names ${s.device.productRef}`);
    if (dev.appProgramId !== s.device.appProgramId) problems.push(`${s.id}: ${file} runs ${dev.appProgramId} at ${s.device.ia}, the spec names ${s.device.appProgramId}`);
    const sec = project.deviceSecurity.find((d) => d.deviceId === dev.id);
    if (!sec?.toolKey) problems.push(`${s.id}: ${file} holds no tool key for ${s.device.ia}`);
    for (const b of s.behaviours) {
      if (b.kind !== "securedOutput") continue;
      const ga = project.groupAddresses.find((g) => g.address === b.ga);
      if (!ga) problems.push(`${s.id}: ${file} has no group address ${b.ga}`);
      else if (!project.groupKeys.some((k) => k.raw === ga.raw)) problems.push(`${s.id}: ${file} holds no group key for ${b.ga}`);
    }
  }
  expect(problems).toEqual([]);
};

if (passwords().length === 0) {
  console.log(`[needs ${PASSWORDS_ENV}] not run: ${NAME}`);
  test.skip(`[needs ${PASSWORDS_ENV}] ${NAME}`, () => {});
} else {
  corpusTest(NAME, check);
}
