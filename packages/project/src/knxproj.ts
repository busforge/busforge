import { pbkdf2Sync } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { readZip, zipEncryption } from "./zip.ts";
import { parseProject, manufacturerOf, appProgramId, kids, node, text, type XmlNode } from "./parse.ts";
import { KnxprojError } from "./errors.ts";
import type { Project, CatalogProduct } from "./model.ts";

// ETS6 derives the WinZip password as base64(PBKDF2-HMAC-SHA256(pw utf-16le,
// "21.project.ets.knx.org", 65536, 32)). See docs/findings.md.
function deriveWinzipPassword(password: string): string {
  return pbkdf2Sync(Buffer.from(password, "utf16le"), Buffer.from("21.project.ets.knx.org"), 65536, 32, "sha256").toString("base64");
}

// An archive's entries are found by their place, never by how a name ends, and the path is compared in
// any case: ETS writes its archives on a file system that does not tell case apart (ETS 4 names the project
// file Project.xml, later versions project.xml). readZip refuses two entries whose names differ in case
// only, so a path names one entry at most.
const namesByPath = new WeakMap<Map<string, Buffer>, Map<string, string>>();
function namesOf(files: Map<string, Buffer>): Map<string, string> {
  let byPath = namesByPath.get(files);
  if (!byPath) {
    byPath = new Map([...files.keys()].map((name) => [name.toLowerCase(), name]));
    namesByPath.set(files, byPath);
  }
  return byPath;
}
// The name of the entry at `path`, undefined where the archive holds none.
const entryAt = (files: Map<string, Buffer>, path: string): string | undefined => namesOf(files).get(path.toLowerCase());
// The names of the entries whose path, in lower case, `place` matches.
const entriesAt = (files: Map<string, Buffer>, place: RegExp): string[] =>
  [...namesOf(files)].filter(([path]) => place.test(path)).map(([, name]) => name);

// A project's files: an unencrypted export keeps the application programs (M-XXXX/M-XXXX_A-….xml, whose id
// may end in 0) next to its P-XXXX/0.xml. An export with an inner archive holds P-XXXX.zip at the outer root
// and 0.xml and project.xml at that archive's root; one without holds P-XXXX/0.xml and P-XXXX/project.xml in
// the outer archive.
const severalProjects = (what: string) => new KnxprojError("KNXPROJ_SEVERAL_PROJECTS", `the archive holds ${what}; Busforge does not pick one`);

// The id of the one project the outer archive holds files of (P-XXXX.zip, P-XXXX/0.xml, P-XXXX/project.xml),
// as its first file writes it, undefined where it holds none. Files of two ids are two projects.
function projectIdOf(outer: Map<string, Buffer>): string | undefined {
  const ids = new Map<string, string>();
  for (const name of entriesAt(outer, /^p-[^/]+?(?:\.zip|\/0\.xml|\/project\.xml)$/)) {
    const id = /^[^/]+?(?=\.zip$|\/)/i.exec(name)![0];
    if (!ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), id);
  }
  if (ids.size > 1) throw severalProjects(`files of ${ids.size} projects (${[...ids.values()].join(", ")})`);
  return [...ids.values()][0];
}

// The project an archive holds: its id, and its inner archive where it has one, decrypted with the project
// password when it is encrypted. Shared by loadKnxproj, readXml0 and readBaggage so the decryption lives once.
// ETS 6 encrypts with WinZip-AES under a password derived from the project password; ETS 4 and 5
// use traditional PKWARE encryption keyed by the project password itself (ASCII shown; zip.ts).
interface ProjectEntries { id: string | undefined; inner: Map<string, Buffer> | undefined }
function projectOf(outer: Map<string, Buffer>, password: string | undefined): ProjectEntries {
  const id = projectIdOf(outer);
  const innerName = id === undefined ? undefined : entryAt(outer, `${id}.zip`);
  if (id === undefined || innerName === undefined) return { id, inner: undefined };
  const innerBuf = outer.get(innerName)!;
  const besides = [entryAt(outer, `${id}/0.xml`), entryAt(outer, `${id}/project.xml`)].filter((n) => n !== undefined);
  if (besides.length) throw severalProjects(`the project twice, as ${innerName} and as ${besides.join(", ")}`);
  const encryption = zipEncryption(innerBuf);
  if (encryption === "none") return { id, inner: readZip(innerBuf) };
  if (!password) throw new KnxprojError("PASSWORD_REQUIRED", "project is password-protected");
  return { id, inner: readZip(innerBuf, encryption === "aes" ? deriveWinzipPassword(password) : password) };
}

// Load a .knxproj: unzip the outer archive, decrypt the inner P-XXXX.zip if
// password-protected, and parse 0.xml into the project view-model.
export function loadKnxproj(bytes: Buffer, password: string | undefined, fallbackName: string): Project {
  const outer = readZip(bytes);
  const project = projectOf(outer, password);
  const xml0 = xml0Of(outer, project);
  const programs = entriesAt(outer, PROGRAM_PLACE).map((name) => dec.decode(outer.get(name)!));
  const products = zipProducts(outer);
  return parseProject(xml0, projectXmlOf(outer, project), fallbackName, parseProductNames(products.hardwareXml), busInterfaceIndexes(programs), parseProductTranslations(products.hardwareXml), hardwareApplicationsOf(products));
}

function xml0Of(outer: Map<string, Buffer>, { id, inner }: ProjectEntries): string {
  const name = inner ? entryAt(inner, "0.xml") : id === undefined ? undefined : entryAt(outer, `${id}/0.xml`);
  const b = name === undefined ? undefined : (inner ?? outer).get(name);
  if (!b) throw new KnxprojError("INVALID_KNXPROJ", `the archive holds no project: no ${inner ? `0.xml at the root of ${id}.zip` : "P-XXXX/0.xml"}`);
  return dec.decode(b);
}

// The project's project.xml: at the inner archive's root where it has one, in the outer archive's P-XXXX/
// where it has none; undefined where there is none (the name then comes from 0.xml).
function projectXmlOf(outer: Map<string, Buffer>, { id, inner }: ProjectEntries): string | undefined {
  const name = inner ? entryAt(inner, "project.xml") : id === undefined ? undefined : entryAt(outer, `${id}/project.xml`);
  return name === undefined ? undefined : dec.decode((inner ?? outer).get(name)!);
}

// A manufacturer's product data, in a .knxproj and a .knxprod alike, sits in its manufacturer directory:
// M-XXXX/Hardware.xml, M-XXXX/Baggages.xml, and each application program as M-XXXX/M-XXXX_A-….xml under its
// own manufacturer's id. An entry elsewhere whose name ends the same (a baggage, a file at the root, a
// manufacturer directory below another folder, another manufacturer's directory) is none of the archive's
// product data.
const HARDWARE_PLACE = /^m-[^/]+\/hardware\.xml$/;
const PROGRAM_PLACE = /^(m-[^/_]+)\/\1_a-[^/]+\.xml$/;

// A project's 0.xml, decrypted with the project password where the project has one.
export function readXml0(bytes: Buffer, password: string | undefined): string {
  const outer = readZip(bytes);
  return xml0Of(outer, projectOf(outer, password));
}

// BusInterface Id -> AddressIndex, as the application programs declare them. It says which of a
// device's addresses a bus interface (a tunnelling channel) uses; see parseSecureSenders.
export function busInterfaceIndexes(programXmls: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const xml of programXmls) {
    for (const m of xml.matchAll(/<BusInterface\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const index = /\bAddressIndex="(\d+)"/.exec(m[0])?.[1];
      if (id && index !== undefined) out.set(id, Number(index));
    }
  }
  return out;
}

// Map ProductRefId -> catalogue product name from the manufacturer Hardware.xml
// files (plaintext in the outer zip). Used as the device-name fallback, matching
// ETS, when a device instance has no user-given name. A device's ProductRefId
// equals the <Product Id="..."> it references.
function parseProductNames(hardware: string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const xml of hardware) {
    for (const m of xml.matchAll(/<Product\b[^>]*>/g)) {
      const tag = m[0];
      const id = /\bId="([^"]+)"/.exec(tag)?.[1];
      const text = /\bText="([^"]*)"/.exec(tag)?.[1];
      if (id && text) names.set(id, text);
    }
  }
  return names;
}

// A product's catalogue text in the catalogue's other languages (Hardware.xml TranslationUnit), by product id.
function parseProductTranslations(hardware: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const xml of hardware) {
    for (const m of xml.matchAll(/<TranslationElement RefId="([^"]+_P-[^"]+)">([\s\S]*?)<\/TranslationElement>/g)) {
      const raw = /<Translation AttributeName="Text" Text="([^"]*)"/.exec(m[2])?.[1];
      const ent: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      const text = raw?.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ent[e]);
      if (text !== undefined) out.set(m[1], [...(out.get(m[1]) ?? []), text]);
    }
  }
  return out;
}

const dec = new TextDecoder("utf-8");

// Extract the project's "baggage": the entries below BinaryData/ and UserFiles/ at the inner archive's
// root. BinaryData holds DCA configuration blobs (e.g. a DALI gateway's backup-store); UserFiles holds
// bundled ETS apps. Returned keyed by their path below that folder (the leading "BinaryData/"/"UserFiles/"
// is dropped); one path below both folders is two files under one key, and refused. Empty when absent.
export function readBaggage(bytes: Buffer, password: string | undefined): Map<string, Buffer> {
  const { inner } = projectOf(readZip(bytes), password);
  const out = new Map<string, Buffer>();
  if (!inner) return out;
  const keys = new Set<string>();
  for (const name of entriesAt(inner, /^(?:binarydata|userfiles)\/./)) {
    const key = name.slice(name.indexOf("/") + 1);
    if (keys.has(key.toLowerCase())) throw new KnxprojError("ARCHIVE_DUPLICATE_ENTRY", `the project's baggage holds ${key} below both BinaryData/ and UserFiles/; Busforge does not pick one`);
    keys.add(key.toLowerCase());
    const buf = inner.get(name)!;
    if (buf.length > 0) out.set(key, buf);
  }
  return out;
}


// Read the application program a device of Hardware2Program `appRef` runs from the outer zip
// (hardwareApplications; the program its id names where no Hardware.xml of the archive describes it).
// These sit plaintext in the outer archive, so no password is needed.
export function readAppProgram(bytes: Buffer, appRef: string): string | null {
  const outer = readZip(bytes);
  const products = zipProducts(outer);
  const id = hardwareApplicationsOf(products).get(appRef) ?? appProgramId(appRef);
  return (id && products.program(id)) || null;
}

// The name of the archive entry of application program `id` (M-XXXX_A-…): M-XXXX/<id>.xml; undefined where the
// archive holds none.
export const programEntryName = (outer: Map<string, Buffer>, id: string): string | undefined => {
  const path = `${id.split("_")[0]}/${id}.xml`;
  return PROGRAM_PLACE.test(path.toLowerCase()) ? entryAt(outer, path) : undefined;
};
const programEntry = (outer: Map<string, Buffer>, id: string): Buffer | undefined => {
  const name = programEntryName(outer, id);
  return name === undefined ? undefined : outer.get(name);
};


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
function parsePlainDoc(xml: string): XmlNode {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false, stopNodes: ["*.ApplicationProgram"] }).parse(xml) as XmlNode;
}
const programsOf = (doc: XmlNode): XmlNode[] =>
  kids(node(node(doc.KNX)?.ManufacturerData)?.Manufacturer).flatMap((m) => kids(node(m.ApplicationPrograms)?.ApplicationProgram));
const plainAppProgramIds = (doc: XmlNode): string[] => programsOf(doc).map((a) => text(a.Id)).filter(Boolean);
// Application program `id` of a stored program document, its attributes only.
const programOf = (xml: string, id: string): XmlNode | undefined => programsOf(parsePlainDoc(xml)).find((a) => text(a.Id) === id);

// The Name the manufacturer gives application program `id` in a stored program document, or "" where
// the document holds no such program or the program no name.
export function appProgramName(xml: string, id: string): string {
  const program = programOf(xml, id);
  return program ? text(program.Name) : "";
}

// A product source (a .knxproj, a .knxprod or a plain manufacturer XML): its Hardware.xml documents and
// the program documents it carries, by application-program id (undefined where it carries none).
interface ProductSource { hardware: XmlNode[]; program: (id: string) => string | undefined }

function zipProducts(outer: Map<string, Buffer>): ProductSource & { hardwareXml: string[] } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  // In a zip only Hardware.xml carries the products, and the (huge) application-program entries are
  // read only where a program is asked for.
  const names = entriesAt(outer, HARDWARE_PLACE);
  const hardwareXml = names.map((name) => dec.decode(outer.get(name)!));
  // A Hardware.xml that does not parse is product data Busforge cannot read, not an archive without products.
  const parse = (xml: string, i: number): XmlNode => {
    try { return parser.parse(xml) as XmlNode; }
    catch (e) { throw new KnxprojError("HARDWARE_XML_MALFORMED", `${names[i]} does not parse as XML: ${(e as Error).message}`); }
  };
  return { hardwareXml, hardware: hardwareXml.map(parse), program: (id) => { const b = programEntry(outer, id); return b ? dec.decode(b) : undefined; } };
}

// One document, one application program: the whole file IS that program's XML, parsed with its body
// stopped out (parsePlainDoc). The ids come from a real parse, never from a regex over the text: a regex
// matches inside comments and CDATA (refusing a legitimate file with a false reason) and misses
// single-quoted or namespace-prefixed elements (silently dropping a product).
function plainProducts(xml: string): ProductSource & { ids: string[] } {
  const doc = parsePlainDoc(xml);
  const ids = plainAppProgramIds(doc);
  return { hardware: [doc], ids, program: (id) => (ids.includes(id) ? xml : undefined) };
}

const productsOf = (bytes: Buffer): ProductSource => (isZip(bytes) ? zipProducts(readZip(bytes)) : plainProducts(dec.decode(bytes)));

const hardwareOf = (doc: XmlNode): XmlNode[] =>
  kids(node(node(doc.KNX)?.ManufacturerData)?.Manufacturer).flatMap((manu) => kids(node(manu.Hardware)?.Hardware));
// Every Hardware2Program a product source describes, in the order of its documents.
const hardware2ProgramsOf = (source: ProductSource): XmlNode[] =>
  source.hardware.flatMap((doc) => hardwareOf(doc).flatMap((hw) => kids(node(hw.Hardware2Programs)?.Hardware2Program)));

// The application program a Hardware2Program names, or "" where it names none. One ApplicationProgramRef
// is the application. The schema allows a second: two-application hardware, an application and a PEI
// program. Which is which neither the order nor the Hardware2Program id says (the id carries both
// programs' parts); the programs do, by their ProgramType, which the schema requires. So with two, both
// have to be in the source, one the ApplicationProgram and the other the PeiProgram; any other case is
// "" as well, and the device is listed as without its program instead of being given a guessed one.
function applicationOf(h2p: XmlNode, source: ProductSource): string {
  const refs = kids(h2p.ApplicationProgramRef).map((r) => text(r.RefId));
  if (refs.length < 2) return refs[0] ?? "";
  const types = refs.map((id) => { const xml = id ? source.program(id) : undefined; return xml === undefined ? "" : text(programOf(xml, id)?.ProgramType); });
  const application = refs.filter((_, i) => types[i] === "ApplicationProgram");
  return application.length === 1 && types.filter((t) => t === "PeiProgram").length === refs.length - 1 ? application[0] : "";
}

// The application program of every Hardware2Program a product source describes, by Hardware2Program id
// ("" where it names none, or none Busforge can tell apart from a PEI program: applicationOf).
function hardwareApplicationsOf(source: ProductSource): Map<string, string> {
  const out = new Map<string, string>();
  for (const h2p of hardware2ProgramsOf(source)) {
    const appRef = text(h2p.Id);
    if (appRef && !out.has(appRef)) out.set(appRef, applicationOf(h2p, source));
  }
  return out;
}
export const hardwareApplications = (bytes: Buffer): Map<string, string> => hardwareApplicationsOf(productsOf(bytes));

// Every program each Hardware2Program a product source describes names (its ApplicationProgramRefs: the
// application, and on two-program hardware the PEI program too), by Hardware2Program id; empty where it names none.
// The source: a .knxproj, a .knxprod or a plain manufacturer XML, or a zip already read. Refused where a
// Hardware2Program is described twice or names a program without its RefId: which programs it runs is then not said.
export function hardwarePrograms(source: Buffer | Map<string, Buffer>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h2p of hardware2ProgramsOf(source instanceof Map ? zipProducts(source) : productsOf(source))) {
    const appRef = text(h2p.Id);
    if (!appRef) continue;
    if (out.has(appRef)) throw new Error(`the product data describe the Hardware2Program ${appRef} twice`);
    const refs = kids(h2p.ApplicationProgramRef).map((r) => text(r.RefId));
    if (refs.includes("")) throw new Error(`the Hardware2Program ${appRef} names an application program without its RefId`);
    out.set(appRef, refs);
  }
  return out;
}

// Extract the given application programs (ids, as hardwareApplications resolves them), keyed by id; an id
// the source carries no program of is left out. Reads the outer zip once (unlike calling readAppProgram
// per device), for populating the catalog at import. App programs sit plaintext in the outer archive, so
// no password is needed.
export function extractAppPrograms(bytes: Buffer, ids: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!isZip(bytes)) {
    const xml = dec.decode(bytes);
    const plain = plainProducts(xml);
    if (plain.ids.length > 1) {
      throw new KnxprojError("CATALOG_MULTI_APP_XML",
        `this product database holds ${plain.ids.length} application programs in one XML document; Busforge can only place a single-program document, so it refuses rather than give every product the same application`);
    }
    for (const id of ids) if (plain.ids.includes(id)) out.set(id, xml);
    return out;
  }
  const outer = readZip(bytes);
  for (const id of ids) {
    if (!id || out.has(id)) continue;
    const b = programEntry(outer, id);
    if (b) out.set(id, dec.decode(b));
  }
  return out;
}

// The images a product's TypePicture parameters show, for each given application program: the
// program's TypePicture RefIds, looked up in its manufacturer's M-XXXX/Baggages.xml (Id -> TargetPath and
// Name) and read from M-XXXX/Baggages/<TargetPath>/<Name> in the archive. A .knxproj and a .knxprod
// carry the same layout. A plain manufacturer XML lists its baggage but carries no file, so it yields
// none; a picture whose file the archive lacks is left out, and the catalogue then has no image for it.
// Keyed by application-program id, then by baggage id.
export function extractPictureBaggage(bytes: Buffer, programs: Map<string, string>): Map<string, Map<string, { name: string; data: Buffer }>> {
  const out = new Map<string, Map<string, { name: string; data: Buffer }>>();
  if (!isZip(bytes)) return out;
  const outer = readZip(bytes);
  const index = new Map<string, Map<string, string>>(); // manufacturer -> baggage id -> archive path
  const indexOf = (manufacturer: string): Map<string, string> => {
    let m = index.get(manufacturer);
    if (m) return m;
    m = new Map();
    index.set(manufacturer, m);
    const key = /^M-[^/]+$/i.test(manufacturer) ? entryAt(outer, `${manufacturer}/Baggages.xml`) : undefined;
    if (key === undefined) return m;
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
    // A Baggages.xml that does not parse gives no images; the rows then say the image is not in the catalogue.
    let doc: XmlNode;
    try { doc = parser.parse(dec.decode(outer.get(key)!)) as XmlNode; } catch { return m; }
    const root = key.slice(0, key.length - "Baggages.xml".length);
    for (const manu of kids(node(node(doc.KNX)?.ManufacturerData)?.Manufacturer)) {
      for (const b of kids(node(manu.Baggages)?.Baggage)) {
        const id = text(b.Id), name = text(b.Name);
        if (!id || !name) continue;
        const dir = text(b.TargetPath).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        m.set(id, `${root}Baggages/${dir ? `${dir}/` : ""}${name}`);
      }
    }
    return m;
  };
  for (const [pid, xml] of programs) {
    const refs = new Set([...xml.matchAll(/<TypePicture\b[^>]*\bRefId="([^"]+)"/g)].map((m) => m[1]));
    for (const ref of refs) {
      const path = indexOf(ref.split("_")[0]).get(ref);
      const name = path === undefined ? undefined : entryAt(outer, path);
      const data = name === undefined ? undefined : outer.get(name);
      if (name === undefined || !data?.length) continue;
      if (!out.has(pid)) out.set(pid, new Map());
      out.get(pid)!.set(ref, { name: name.slice(name.lastIndexOf("/") + 1), data });
    }
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
  const source = productsOf(bytes);
  const out: CatalogProduct[] = [];
  for (const doc of source.hardware) {
    for (const hw of hardwareOf(doc)) {
      // The Hardware2Program, not the hardware's HasApplicationProgram flag, says whether a
      // program belongs to the product: ETS's conversion of Hager's ETS2 data sets the flag on
      // a Hardware2Program that names none.
      const programs = kids(node(hw.Hardware2Programs)?.Hardware2Program).filter((h2p) => text(h2p.Id)).map((h2p) => {
        const hasApplication = h2p.ApplicationProgramRef !== undefined;
        return { appRef: text(h2p.Id), hasApplication, peiProgram: kids(h2p.ApplicationProgramRef).length > 1, appProgramId: hasApplication ? applicationOf(h2p, source) : "" };
      });
      // A hardware groups its product variants and the application programs it runs; a device picks
      // one of each. Pair them so any valid device combo is offered (typically one product to one program).
      for (const p of kids(node(hw.Products)?.Product)) {
        const productRef = text(p.Id);
        if (!productRef) continue;
        for (const program of programs) {
          out.push({
            ...program, productRef,
            manufacturer: manufacturerOf(productRef),
            name: text(p.Text),
            orderNumber: text(p.OrderNumber),
            hwVersion: text(hw.VersionNumber),
          });
        }
      }
    }
  }
  return out;
}

export { deriveWinzipPassword, appProgramId };
