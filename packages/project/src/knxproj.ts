import { pbkdf2Sync } from "node:crypto";
import { readZip } from "./zip.ts";
import { parseProject } from "./parse.ts";
import { KnxprojError } from "./errors.ts";
import type { Project } from "./model.ts";

// ETS6 derives the WinZip password as base64(PBKDF2-HMAC-SHA256(pw utf-16le,
// "21.project.ets.knx.org", 65536, 32)). See docs/findings.md.
function deriveWinzipPassword(password: string): string {
  return pbkdf2Sync(Buffer.from(password, "utf16le"), Buffer.from("21.project.ets.knx.org"), 65536, 32, "sha256").toString("base64");
}

// Resolve the inner project archive ("P-XXXX.zip" at the root of the outer zip),
// decrypting with the project password when it is encrypted. Returns undefined
// for an unencrypted export that has no inner archive (0.xml sits in the outer
// zip). Shared by loadKnxproj and readBaggage so the decrypt fallback lives once.
function resolveInner(outer: Map<string, Buffer>, password: string | undefined): Map<string, Buffer> | undefined {
  const innerName = [...outer.keys()].find((n) => /(^|\/)P-[^/]+\.zip$/.test(n));
  if (!innerName) return undefined;
  const innerBuf = outer.get(innerName)!;
  try {
    return readZip(innerBuf); // unencrypted inner (rare, but possible)
  } catch {
    if (!password) throw new KnxprojError("PASSWORD_REQUIRED", "project is password-protected");
    return readZip(innerBuf, deriveWinzipPassword(password));
  }
}

// Load a .knxproj: unzip the outer archive, decrypt the inner P-XXXX.zip if
// password-protected, and parse 0.xml into the project view-model.
export function loadKnxproj(bytes: Buffer, password: string | undefined, fallbackName: string): Project {
  const outer = readZip(bytes);
  const inner = resolveInner(outer, password);

  // Encrypted/normal export keeps 0.xml in the inner archive; an unencrypted
  // export keeps it directly in the outer zip under P-XXXX/.
  const xml0 = inner ? textOf(inner, "0.xml") : textOf(outer, "0.xml");
  const projectXml = (inner && tryTextOf(inner, "project.xml")) ?? tryTextOf(outer, "project.xml");

  return parseProject(xml0, projectXml, fallbackName, parseProductNames(outer));
}

// Map ProductRefId -> catalogue product name from the manufacturer Hardware.xml
// files (plaintext in the outer zip). Used as the device-name fallback, matching
// ETS, when a device instance has no user-given name. A device's ProductRefId
// equals the <Product Id="..."> it references.
function parseProductNames(outer: Map<string, Buffer>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [key, buf] of outer) {
    if (!key.endsWith("Hardware.xml")) continue;
    const xml = dec.decode(buf);
    for (const m of xml.matchAll(/<Product\b[^>]*>/g)) {
      const tag = m[0];
      const id = /\bId="([^"]+)"/.exec(tag)?.[1];
      const text = /\bText="([^"]*)"/.exec(tag)?.[1];
      if (id && text) names.set(id, text);
    }
  }
  return names;
}

const dec = new TextDecoder("utf-8");
function tryTextOf(files: Map<string, Buffer>, suffix: string): string | undefined {
  const k = [...files.keys()].find((n) => n.endsWith(suffix));
  return k ? dec.decode(files.get(k)!) : undefined;
}
function textOf(files: Map<string, Buffer>, suffix: string): string {
  const t = tryTextOf(files, suffix);
  if (t === undefined) throw new KnxprojError("INVALID_KNXPROJ", `${suffix} not found in archive`);
  return t;
}

// Extract the project's "baggage": the BinaryData/ and UserFiles/ entries from the
// inner archive. BinaryData holds DCA configuration blobs (e.g. a DALI gateway's
// backup-store); UserFiles holds bundled ETS apps. Returned keyed by basename
// (the leading "BinaryData/"/"UserFiles/" folder is dropped). Empty when absent.
export function readBaggage(bytes: Buffer, password: string | undefined): Map<string, Buffer> {
  const inner = resolveInner(readZip(bytes), password);
  const out = new Map<string, Buffer>();
  if (!inner) return out;
  for (const [name, buf] of inner) {
    const m = /(?:^|\/)(?:BinaryData|UserFiles)\/(.+)$/.exec(name);
    if (m && buf.length > 0) out.set(m[1], buf);
  }
  return out;
}

// Hardware2ProgramRefId -> ApplicationProgram id.
// "M-0048_H-4930240-2_HP-493B-21-B471" -> "M-0048_A-493B-21-B471".
export function appProgramId(appRef: string): string {
  const manufacturer = appRef.split("_")[0];
  const hp = appRef.split("_HP-")[1];
  return hp ? `${manufacturer}_A-${hp}` : appRef;
}

// Read a manufacturer application program XML from the outer zip. These sit
// plaintext in the outer archive, so no password is needed.
export function readAppProgram(bytes: Buffer, appRef: string): string | null {
  const id = appProgramId(appRef);
  const outer = readZip(bytes);
  const key = [...outer.keys()].find((n) => n.endsWith(`${id}.xml`));
  return key ? new TextDecoder("utf-8").decode(outer.get(key)!) : null;
}

// Extract every distinct application program referenced by the given device app
// refs, keyed by application-program id. Reads the outer zip once (unlike calling
// readAppProgram per device), for populating the catalog at import. App programs
// sit plaintext in the outer archive, so no password is needed.
export function extractAppPrograms(bytes: Buffer, appRefs: Iterable<string>): Map<string, string> {
  const outer = readZip(bytes);
  const out = new Map<string, string>();
  for (const appRef of appRefs) {
    const id = appProgramId(appRef);
    if (out.has(id)) continue;
    const key = [...outer.keys()].find((n) => n.endsWith(`${id}.xml`));
    if (key) out.set(id, dec.decode(outer.get(key)!));
  }
  return out;
}

export { deriveWinzipPassword };
