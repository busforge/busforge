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
  // KnxprojError("INVALID_KNXPROJ", "not a zip (no EOCD)") (zip.ts:21).
  test("readZip on non-zip bytes throws INVALID_KNXPROJ (no EOCD)", () => {
    const e = catchError(() => readZip(Buffer.from("this is not a zip...")));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("INVALID_KNXPROJ");
  });

  // loadKnxproj's first step is readZip(bytes) (knxproj.ts:33), so garbage input
  // must surface the same INVALID_KNXPROJ from findEOCD (zip.ts:21).
  test("loadKnxproj on non-zip bytes throws INVALID_KNXPROJ (no EOCD)", () => {
    const e = catchError(() => loadKnxproj(Buffer.from("this is not a zip..."), undefined, "x"));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("INVALID_KNXPROJ");
  });

  // (b) Valid zip, but no project content. storeZip (ziputil.ts) writes exactly
  // the STORE-method layout zip.ts parses: LFH (sig 0x04034b50, name len at +26,
  // extra len 0), central directory (sig 0x02014b50, method 0 at +10, comp size
  // at +20, LFH offset at +42), EOCD (sig 0x06054b50, CD offset at +16). With no
  // P-*.zip inner archive resolveInner returns undefined (knxproj.ts:19-20), so
  // loadKnxproj falls through to textOf(outer, "0.xml") (knxproj.ts:38), which
  // throws KnxprojError("INVALID_KNXPROJ", "0.xml not found in archive")
  // (knxproj.ts:70). The dummy entry name must not end in "0.xml" because textOf
  // matches by suffix (knxproj.ts:65).
  test("loadKnxproj on a zip without 0.xml throws INVALID_KNXPROJ", () => {
    const zip = storeZip({ "dummy.txt": "no project here" });
    const e = catchError(() => loadKnxproj(zip, undefined, "x"));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("INVALID_KNXPROJ");
  });
});

describe("readBaggage (knxproj.ts:78)", () => {
  // Actual contract from the implementation (knxproj.ts:78-87): unzip the outer
  // archive, resolve/decrypt the inner P-*.zip via resolveInner, then collect
  // inner entries under BinaryData/ or UserFiles/ keyed by the path after that
  // folder, skipping zero-length blobs (buf.length > 0, knxproj.ts:84). Always
  // returns a Map; empty when there is no inner archive or no baggage entries.
  test("returns a Map for the encrypted fixture with the correct password", () => {
    const baggage = readBaggage(fix("sample-encrypted.knxproj"), "tester12");
    expect(baggage).toBeInstanceOf(Map);
    // Contract-derived invariants that hold whatever the fixture contains: keys
    // are the path AFTER the BinaryData/UserFiles folder (the regex group in
    // knxproj.ts:83 starts past the folder's slash) and values are non-empty
    // (zero-length blobs are filtered at knxproj.ts:84). We deliberately do not
    // assert emptiness: no existing test documents whether this fixture carries
    // baggage, and guessing either way would be a fabricated expectation.
    for (const [name, buf] of baggage) {
      expect(name.startsWith("BinaryData/")).toBe(false);
      expect(name.startsWith("UserFiles/")).toBe(false);
      expect(buf.length).toBeGreaterThan(0);
    }
  });

  // Wrong password: resolveInner first tries the inner zip unencrypted, which
  // throws (AES entries need a password, zip.ts:116) and is caught; with a
  // password present it retries with the derived key (knxproj.ts:26), where the
  // PBKDF2 verify bytes mismatch and aesDecrypt throws
  // KnxprojError("WRONG_PASSWORD", "wrong password") (zip.ts:87). Same path the
  // existing loadKnxproj wrong-password test locks (project.test.ts:141).
  test("throws WRONG_PASSWORD for the encrypted fixture with a wrong password", () => {
    const e = catchError(() => readBaggage(fix("sample-encrypted.knxproj"), "wrong"));
    expect(e).toBeInstanceOf(KnxprojError);
    expect((e as KnxprojError).code).toBe("WRONG_PASSWORD");
  });
});
