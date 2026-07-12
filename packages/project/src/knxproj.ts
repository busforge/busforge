import { pbkdf2Sync } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { readZip } from "./zip.ts";
import { parseProject, arr, manufacturerOf } from "./parse.ts";
import { KnxprojError } from "./errors.ts";
import type { Project, CatalogProduct } from "./model.ts";

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


// A product database reaches us in one of two shapes, and both must work.
//
// A `.knxprod` is a ZIP of per-manufacturer XML files (Hardware.xml, Catalog.xml, one file per
// application program). That is what ETS produces and what a KNX Association member ships.
//
// A **plain manufacturer XML** is one document carrying the same <ManufacturerData> content
// inline. This is not an exotic case: OpenKNX is not a KNX Association member and therefore may
// not publish a signed .knxprod at all, so their product databases ship exactly like this (the
// OpenKNXproducer writes the XML; only the final signing step needs ETS, and it is a step we do
// not need since we read the XML, not the signature). Reading it directly is what makes an
// OpenKNX device usable without ETS anywhere in the chain.
const isZip = (b: Buffer): boolean => b.length > 1 && b[0] === 0x50 && b[1] === 0x4b; // "PK"

// Parse a plain manufacturer document WITHOUT building the application program's body into
// objects. The program is the whole file (75 MB for the OpenKNX RaumController) while the parts
// we need here (the Hardware section, the program's identity) are a few kilobytes; parsing it in
// full costs seconds and gigabytes of transient heap inside one HTTP request. `stopNodes` keeps
// the element and its attributes and leaves its content as raw text: 0.15 s instead of 1.5 s,
// 0.6 GB instead of 2 GB, on the real file.
function parsePlainDoc(xml: string): any {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false, stopNodes: ["*.ApplicationProgram"] }).parse(xml);
}
const plainAppProgramIds = (xml: string): string[] =>
  arr(parsePlainDoc(xml)?.KNX?.ManufacturerData?.Manufacturer)
    .flatMap((m: any) => arr(m?.ApplicationPrograms?.ApplicationProgram))
    .map((a: any) => String(a?.Id ?? ""))
    .filter(Boolean);

// Extract every distinct application program referenced by the given device app
// refs, keyed by application-program id. Reads the outer zip once (unlike calling
// readAppProgram per device), for populating the catalog at import. App programs
// sit plaintext in the outer archive, so no password is needed.
export function extractAppPrograms(bytes: Buffer, appRefs: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!isZip(bytes)) {
    // One document, one application program: the whole file IS that program's XML. The ids come
    // from a real parse, never from a regex over the text: a regex matches inside comments and
    // CDATA (refusing a legitimate file with a false reason) and misses single-quoted or
    // namespace-prefixed elements (silently dropping a product).
    const xml = dec.decode(bytes);
    const ids = plainAppProgramIds(xml);
    if (ids.length > 1) {
      throw new KnxprojError("CATALOG_MULTI_APP_XML",
        `this product database holds ${ids.length} application programs in one XML document; Busforge can only place a single-program document, so it refuses rather than give every product the same application`);
    }
    for (const appRef of appRefs) {
      const id = appProgramId(appRef);
      if (ids.includes(id)) out.set(id, xml);
    }
    return out;
  }
  const outer = readZip(bytes);
  for (const appRef of appRefs) {
    const id = appProgramId(appRef);
    if (out.has(id)) continue;
    const key = [...outer.keys()].find((n) => n.endsWith(`${id}.xml`));
    if (key) out.set(id, dec.decode(outer.get(key)!));
  }
  return out;
}

// Pull every placeable catalog product out of the manufacturer Hardware.xml files
// in the outer zip: each product paired with each application program its hardware
// can run, carrying the catalogue name, order number and hardware version. These
// files sit plaintext in the outer archive (no password needed). Source-agnostic:
// a .knxprod shares the same Manufacturer/Hardware structure, so this extractor
// generalizes to it for the official-catalog ingest (milestone 5).
export function extractCatalogProducts(bytes: Buffer): CatalogProduct[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const out: CatalogProduct[] = [];
  // In a zip only Hardware.xml carries the products, and the (huge) application-program entries
  // are never touched. A plain document carries everything inline, so it is parsed with the
  // application program's body stopped out (parsePlainDoc), for the same reason.
  const docs: any[] = isZip(bytes)
    ? [...readZip(bytes)].filter(([key]) => key.endsWith("Hardware.xml")).map(([, buf]) => parser.parse(dec.decode(buf)))
    : [parsePlainDoc(dec.decode(bytes))];
  for (const doc of docs) {
    for (const manu of arr(doc?.KNX?.ManufacturerData?.Manufacturer)) {
      for (const hw of arr(manu?.Hardware?.Hardware)) {
        const hwVersion = String(hw.VersionNumber ?? "");
        const products = arr(hw?.Products?.Product);
        const programs = arr(hw?.Hardware2Programs?.Hardware2Program);
        // A hardware groups its product variants and the application programs it
        // runs; a device picks one of each. Pair them so any valid device combo
        // is offered (typically one product to one program).
        for (const p of products) {
          const productRef = String(p.Id ?? "");
          if (!productRef) continue;
          for (const h2p of programs) {
            const appRef = String(h2p.Id ?? "");
            if (!appRef) continue;
            out.push({
              appRef, productRef,
              appProgramId: appProgramId(appRef),
              manufacturer: manufacturerOf(productRef),
              name: String(p.Text ?? ""),
              orderNumber: String(p.OrderNumber ?? ""),
              hwVersion,
            });
          }
        }
      }
    }
  }
  return out;
}

export { deriveWinzipPassword };
