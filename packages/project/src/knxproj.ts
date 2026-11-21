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

// A project's files are found by their place, never by how a name ends: an unencrypted export keeps
// the application programs (M-XXXX/M-XXXX_A-….xml, whose id may end in 0) next to its P-XXXX/0.xml.
// An export with an inner archive holds P-XXXX.zip at the outer root and 0.xml and project.xml at that
// archive's root; one without holds P-XXXX/0.xml and P-XXXX/project.xml in the outer archive. ETS 4
// writes Project.xml, later versions project.xml.
const isProjectXml = (name: string) => name.toLowerCase() === "project.xml";
const severalProjects = (what: string) => new KnxprojError("KNXPROJ_SEVERAL_PROJECTS", `the archive holds ${what}; Busforge does not pick one`);

// The id of the one project the outer archive holds files of (P-XXXX.zip, P-XXXX/0.xml, P-XXXX/project.xml),
// undefined where it holds none. Files of two ids are two projects.
function projectIdOf(outer: Map<string, Buffer>): string | undefined {
  const ids = new Set<string>();
  for (const name of outer.keys()) {
    const m = /^(P-[^/]+)(?:\.zip|\/([^/]+))$/.exec(name);
    if (m && (m[2] === undefined || m[2] === "0.xml" || isProjectXml(m[2]))) ids.add(m[1]);
  }
  if (ids.size > 1) throw severalProjects(`files of ${ids.size} projects (${[...ids].join(", ")})`);
  return [...ids][0];
}

// The project an archive holds: its id, and its inner archive where it has one, decrypted with the project
// password when it is encrypted. Shared by loadKnxproj, readXml0 and readBaggage so the decryption lives once.
// ETS 6 encrypts with WinZip-AES under a password derived from the project password; ETS 4 and 5
// use traditional PKWARE encryption keyed by the project password itself (ASCII shown; zip.ts).
interface ProjectEntries { id: string | undefined; inner: Map<string, Buffer> | undefined }
function projectOf(outer: Map<string, Buffer>, password: string | undefined): ProjectEntries {
  const id = projectIdOf(outer);
  const innerBuf = id === undefined ? undefined : outer.get(`${id}.zip`);
  if (id === undefined || !innerBuf) return { id, inner: undefined };
  const besides = [...outer.keys()].filter((n) => n === `${id}/0.xml` || (n.startsWith(`${id}/`) && isProjectXml(n.slice(id.length + 1))));
  if (besides.length) throw severalProjects(`the project twice, as ${id}.zip and as ${besides.join(", ")}`);
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
  const programs = [...outer].filter(([k]) => /\/M-[^/]+_A-[^/]+\.xml$/.test(k)).map(([, b]) => dec.decode(b));
  const products = zipProducts(outer);
  return parseProject(xml0, projectXmlOf(outer, project), fallbackName, parseProductNames(products.hardwareXml), busInterfaceIndexes(programs), parseProductTranslations(products.hardwareXml), hardwareApplicationsOf(products));
}

function xml0Of(outer: Map<string, Buffer>, { id, inner }: ProjectEntries): string {
  const b = inner ? inner.get("0.xml") : id === undefined ? undefined : outer.get(`${id}/0.xml`);
  if (!b) throw new KnxprojError("INVALID_KNXPROJ", `the archive holds no project: no ${inner ? `0.xml at the root of ${id}.zip` : "P-XXXX/0.xml"}`);
  return dec.decode(b);
}

// The project's project.xml: at the inner archive's root where it has one, in the outer archive's P-XXXX/
// where it has none; undefined where there is none (the name then comes from 0.xml).
function projectXmlOf(outer: Map<string, Buffer>, { id, inner }: ProjectEntries): string | undefined {
  const at = (files: Map<string, Buffer>, dir: string): string | undefined => {
    const names = [...files.keys()].filter((n) => n.startsWith(dir) && isProjectXml(n.slice(dir.length)));
    if (names.length > 1) throw severalProjects(`${names.length} project.xml files (${names.join(", ")})`);
    return names.length ? dec.decode(files.get(names[0])!) : undefined;
  };
  return inner ? at(inner, "") : id === undefined ? undefined : at(outer, `${id}/`);
}

// The manufacturers' Hardware.xml documents, found by their place like the project's files: one in each
// manufacturer directory, M-XXXX/Hardware.xml, in a .knxproj and a .knxprod alike. An entry elsewhere whose
// name ends in Hardware.xml (a baggage, a file at the root, a manufacturer directory below another folder)
// describes none of the archive's products. The path is taken in any case, as project.xml is, since ETS
// writes on a file system that does not tell case apart; two paths that differ in case only are one
// manufacturer's product data twice, and refused.
function hardwareXmlsOf(outer: Map<string, Buffer>): string[] {
  const byDir = new Map<string, string[]>();
  for (const name of outer.keys()) {
    const dir = /^(m-[^/]+)\/hardware\.xml$/.exec(name.toLowerCase())?.[1];
    if (dir !== undefined) byDir.set(dir, [...(byDir.get(dir) ?? []), name]);
  }
  return [...byDir.values()].map((names) => {
    if (names.length > 1) throw new KnxprojError("SEVERAL_HARDWARE_XML", `the archive holds one manufacturer's Hardware.xml ${names.length} times (${names.join(", ")}); Busforge does not pick one`);
    return dec.decode(outer.get(names[0])!);
  });
}

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

// Extract the project's "baggage": the BinaryData/ and UserFiles/ entries from the
// inner archive. BinaryData holds DCA configuration blobs (e.g. a DALI gateway's
// backup-store); UserFiles holds bundled ETS apps. Returned keyed by basename
// (the leading "BinaryData/"/"UserFiles/" folder is dropped). Empty when absent.
export function readBaggage(bytes: Buffer, password: string | undefined): Map<string, Buffer> {
  const { inner } = projectOf(readZip(bytes), password);
  const out = new Map<string, Buffer>();
  if (!inner) return out;
  for (const [name, buf] of inner) {
    const m = /(?:^|\/)(?:BinaryData|UserFiles)\/(.+)$/.exec(name);
    if (m && buf.length > 0) out.set(m[1], buf);
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

// The archive entry of application program `id`: "<id>.xml", at the root or in a folder (M-XXXX/).
const programEntry = (outer: Map<string, Buffer>, id: string): Buffer | undefined => {
  const key = [...outer.keys()].find((n) => n === `${id}.xml` || n.endsWith(`/${id}.xml`));
  return key ? outer.get(key) : undefined;
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
  const hardwareXml = hardwareXmlsOf(outer);
  return { hardwareXml, hardware: hardwareXml.map((xml) => parser.parse(xml) as XmlNode), program: (id) => { const b = programEntry(outer, id); return b ? dec.decode(b) : undefined; } };
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
  for (const doc of source.hardware) {
    for (const h2p of hardwareOf(doc).flatMap((hw) => kids(node(hw.Hardware2Programs)?.Hardware2Program))) {
      const appRef = text(h2p.Id);
      if (appRef && !out.has(appRef)) out.set(appRef, applicationOf(h2p, source));
    }
  }
  return out;
}
export const hardwareApplications = (bytes: Buffer): Map<string, string> => hardwareApplicationsOf(productsOf(bytes));

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
// program's TypePicture RefIds, looked up in its manufacturer's Baggages.xml (Id -> TargetPath and
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
    const key = [...outer.keys()].find((n) => n === `${manufacturer}/Baggages.xml` || n.endsWith(`/${manufacturer}/Baggages.xml`));
    if (!key) return m;
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
      const data = path ? outer.get(path) : undefined;
      if (!path || !data?.length) continue;
      if (!out.has(pid)) out.set(pid, new Map());
      out.get(pid)!.set(ref, { name: path.slice(path.lastIndexOf("/") + 1), data });
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
