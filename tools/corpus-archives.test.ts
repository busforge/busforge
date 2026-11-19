// Every project archive in the private corpus (`.knxproj`, `.knxprod`, `.busforge`) is opened with
// Busforge's own readers, so a rule the ZIP reader gets stricter, or a decryption it breaks, fails here
// naming the file instead of surfacing in whichever test happens to need that archive next.
//
//   outer archive   readZip of every .knxproj and .knxprod, no password (ETS never protects the outer zip)
//   project         readXml0 of every .knxproj, which unpacks the inner P-*.zip and with it every entry
//   .busforge       unpackBusforge of every .busforge
//
// An inner archive or a .busforge that is password-protected opens only with the project's password
// (tools/corpus-archives.ts). The check holds none, so those come from the environment, never from a file:
//
//   KNXPROJ_PASSWORDS="$(first-password-source)"$'\n'"$(second-password-source)" bun test tools/corpus-archives.test.ts
//
// one password per line; each protected archive is tried with each. Without it the outer-archive test and
// every archive that needs no password still run, and the test that opens the protected ones is registered
// as skipped under a name that says so; tools/corpus-status.ts says so on the last line of `bun run check`.
import { expect, setDefaultTimeout, test } from "bun:test";
import { readZip } from "../packages/project/src/zip.ts";
import { bytesOf, classify, corpusArchives, describeFailure, extensionOf, openProtected, PASSWORDS_ENV, passwords } from "./corpus-archives.ts";
import { corpusTest } from "./corpus-test.ts";

// The slowest test takes 1.4 s alone (about 98 MiB of AES-decrypted archives); the floor of docs/testing.md applies.
setDefaultTimeout(60_000);

corpusTest("the corpus holds project archives of the two kinds it is known to hold", () => {
  expect([...new Set(corpusArchives().map(extensionOf))]).toEqual(expect.arrayContaining(["knxprod", "knxproj"]));
});

corpusTest("the outer archive of every corpus .knxproj and .knxprod opens", () => {
  const failures: string[] = [];
  for (const file of corpusArchives().filter((f) => extensionOf(f) !== "busforge")) {
    try {
      if (readZip(bytesOf(file)).size === 0) failures.push(`${file}: the archive holds no entry`);
    } catch (e) {
      failures.push(`${file}: ${describeFailure(e)}`);
    }
  }
  expect(failures).toEqual([]);
});

corpusTest("every corpus archive that needs no password opens", async () => {
  expect((await classify()).failures).toEqual([]);
});

if (passwords().length === 0) {
  console.log(`[needs ${PASSWORDS_ENV}] not run: every corpus archive that is password-protected opens`);
  test.skip(`[needs ${PASSWORDS_ENV}] every corpus archive that is password-protected opens`, () => {});
} else {
  corpusTest("every corpus archive that is password-protected opens", async () => {
    expect((await openProtected((await classify()).protectedFiles)).failures).toEqual([]);
  });
}
