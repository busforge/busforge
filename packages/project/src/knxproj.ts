import { pbkdf2Sync } from "node:crypto";
import { readZip } from "./zip.ts";
import { parseProject } from "./parse.ts";
import type { Project } from "./model.ts";

// ETS6 derives the WinZip password as base64(PBKDF2-HMAC-SHA256(pw utf-16le,
// "21.project.ets.knx.org", 65536, 32)). See docs/findings.md.
function deriveWinzipPassword(password: string): string {
  return pbkdf2Sync(Buffer.from(password, "utf16le"), Buffer.from("21.project.ets.knx.org"), 65536, 32, "sha256").toString("base64");
}

// Load a .knxproj: unzip the outer archive, decrypt the inner P-XXXX.zip if
// password-protected, and parse 0.xml into the project view-model.
export function loadKnxproj(bytes: Buffer, password: string | undefined, fallbackName: string): Project {
  const outer = readZip(bytes);

  // Inner project archive: "P-XXXX.zip" at the root of the outer zip.
  const innerName = [...outer.keys()].find((n) => /(^|\/)P-[^/]+\.zip$/.test(n));

  let xml0: string;
  let projectXml: string | undefined;

  if (innerName) {
    const innerBuf = outer.get(innerName)!;
    let inner: Map<string, Buffer>;
    try {
      inner = readZip(innerBuf); // unencrypted inner (rare, but possible)
    } catch (e) {
      if (!password) throw new Error("project is password-protected");
      inner = readZip(innerBuf, deriveWinzipPassword(password));
    }
    xml0 = textOf(inner, "0.xml");
    projectXml = tryTextOf(inner, "project.xml") ?? tryTextOf(outer, "project.xml");
  } else {
    // Unencrypted export: 0.xml sits directly in the outer zip under P-XXXX/.
    xml0 = textOf(outer, "0.xml");
    projectXml = tryTextOf(outer, "project.xml");
  }

  return parseProject(xml0, projectXml, fallbackName);
}

const dec = new TextDecoder("utf-8");
function tryTextOf(files: Map<string, Buffer>, suffix: string): string | undefined {
  const k = [...files.keys()].find((n) => n.endsWith(suffix));
  return k ? dec.decode(files.get(k)!) : undefined;
}
function textOf(files: Map<string, Buffer>, suffix: string): string {
  const t = tryTextOf(files, suffix);
  if (t === undefined) throw new Error(`${suffix} not found in archive`);
  return t;
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

export { deriveWinzipPassword };
