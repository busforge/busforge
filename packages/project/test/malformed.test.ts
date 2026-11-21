import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "../src/zip.ts";
import { KnxprojError } from "../src/errors.ts";
import { loadKnxproj, readBaggage } from "../src/knxproj.ts";
import { storeZip } from "./ziputil.ts";

const fix = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n));

// Captures the thrown value so we can assert type AND code, not just "it threw".
function catchError(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  expect.unreachable("expected the call to throw");
}

describe("malformed input surfaces coded errors", () => {
  // (a) Garbage bytes: readZip -> readCentralDirectory -> findEOCD scans for the
  // EOCD signature and, finding none, throws
  // KnxprojError("INVALID_KNXPROJ", "malformed zip: no end of central directory record (not a zip)").
  test("readZip on non-zip bytes throws INVALID_KNXPROJ (no EOCD)", () => {
    const e = catchError(() => readZip(Buffer.from("this is not a zip...")));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("INVALID_KNXPROJ");
  });

  // loadKnxproj's first step is readZip(bytes), so garbage input
  // must surface the same INVALID_KNXPROJ from findEOCD.
  test("loadKnxproj on non-zip bytes throws INVALID_KNXPROJ (no EOCD)", () => {
    const e = catchError(() => loadKnxproj(Buffer.from("this is not a zip..."), undefined, "x"));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("INVALID_KNXPROJ");
  });

  // (b) Valid zip, but no project content. storeZip (ziputil.ts) writes exactly
  // the STORE-method layout zip.ts parses: LFH (sig 0x04034b50, name len at +26,
  // extra len 0), central directory (sig 0x02014b50, method 0 at +10, comp size
  // at +20, LFH offset at +42), EOCD (sig 0x06054b50, CD offset at +16). With no
  // P-*.zip inner archive projectOf finds no inner archive, so loadKnxproj looks
  // for P-XXXX/0.xml in the outer archive (xml0Of), finds none and throws
  // KnxprojError("INVALID_KNXPROJ", "the archive holds no project: no P-XXXX/0.xml").
  test("loadKnxproj on a zip without 0.xml throws INVALID_KNXPROJ", () => {
    const zip = storeZip({ "dummy.txt": "no project here" });
    const e = catchError(() => loadKnxproj(zip, undefined, "x"));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("INVALID_KNXPROJ");
  });
});

describe("readBaggage", () => {
  // Actual contract from the implementation (readBaggage): unzip the outer
  // archive, resolve/decrypt the inner P-*.zip via projectOf, then collect
  // inner entries under BinaryData/ or UserFiles/ at its root, keyed by the path after that
  // folder, skipping zero-length blobs (buf.length > 0). Always
  // returns a Map; empty when there is no inner archive or no baggage entries.
  test("returns a Map for the encrypted fixture with the correct password", () => {
    const baggage = readBaggage(fix("sample-encrypted.knxproj"), "tester12");
    expect(baggage).toBeInstanceOf(Map);
    // Contract-derived invariants that hold whatever the fixture contains: keys
    // are the path AFTER the BinaryData/UserFiles folder and values are non-empty
    // (zero-length blobs are filtered out). We deliberately do not
    // assert emptiness: no existing test documents whether this fixture carries
    // baggage, and guessing either way would be a fabricated expectation.
    for (const [name, buf] of baggage) {
      expect(name.startsWith("BinaryData/")).toBe(false);
      expect(name.startsWith("UserFiles/")).toBe(false);
      expect(buf.length).toBeGreaterThan(0);
    }
  });

  // Wrong password: projectOf sees the inner zip is AES-encrypted and decrypts
  // with the derived key, where the PBKDF2 verify bytes mismatch and aesDecrypt
  // throws KnxprojError("WRONG_PASSWORD", "wrong password"). Same path the
  // existing loadKnxproj wrong-password test locks (project.test.ts).
  test("throws WRONG_PASSWORD for the encrypted fixture with a wrong password", () => {
    const e = catchError(() => readBaggage(fix("sample-encrypted.knxproj"), "wrong"));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("WRONG_PASSWORD");
  });
});
