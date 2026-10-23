import { extractAppPrograms, extractCatalogProducts, extractPictureBaggage } from "@busforge/project";
import { comObjectUniverse, MANUFACTURERS } from "@busforge/product";
import { putAppProgram, putCatalogProduct, putCatalogBaggage, getCatalogBaggage, pictureType, listCatalogProducts, backfillCatalogFromDevices } from "../db/catalog.ts";
import { loadCatalogApp } from "../deviceservice.ts";
import { checkBaggageSize } from "../db/baggage.ts";
import { json, err } from "../httputil.ts";
import type { AppState } from "../app.ts";

// /api/catalog/...  -> browsable device catalog for placing into projects
export async function handle(req: Request, url: URL, seg: string[], state: AppState): Promise<Response | null> {
  if (seg[1] !== "catalog") return null;
  const { db } = state;

  // /api/catalog/apps/:appProgramId/comobjects  -> the application's COMPLETE
  // com-object universe (every ComObjectRef, ref overrides resolved), NOT gated by
  // parameter visibility: the link-mapping step of "replace device" must offer
  // objects that only become visible once channel parameters are set (GA-preserve
  // semantics). Cost note: this parses the stored application XML, which can be
  // huge (the OpenKNX RaumController is ~75 MB); loadCatalogApp caches the parse
  // per process, so only the first request for a program pays it.
  if (seg.length === 5 && seg[2] === "apps" && seg[4] === "comobjects" && req.method === "GET") {
    const app = loadCatalogApp(state, decodeURIComponent(seg[3]));
    if (!app) return err("APP_PROGRAM_MISSING", "application program not in catalog", 404);
    return json(comObjectUniverse(app, url.searchParams.get("lang") ?? undefined));
  }

  // /api/catalog/apps/:appProgramId/pictures/:baggageId  -> the image a TypePicture parameter of the
  // program shows. Only image types are served, never sniffed, and a script in an SVG opened on its
  // own does not run (the CSP).
  if (seg.length === 6 && seg[2] === "apps" && seg[4] === "pictures" && req.method === "GET") {
    const file = getCatalogBaggage(db, decodeURIComponent(seg[3]), decodeURIComponent(seg[5]));
    if (!file) return err("PICTURE_MISSING", "the catalogue holds no such image for this application program", 404);
    const type = pictureType(file.name);
    if (!type) return err("PICTURE_TYPE_UNSUPPORTED", `the baggage file ${file.name} is not an image type Busforge shows`, 415);
    return new Response(new Uint8Array(file.data), { headers: { "content-type": type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'; form-action 'none'; base-uri 'none'", "cache-control": "private, max-age=3600" } });
  }

  // /api/catalog/manufacturers  -> where each known manufacturer publishes its product data
  if (seg.length === 3 && seg[2] === "manufacturers" && req.method === "GET") return json(MANUFACTURERS);

  if (seg.length === 3 && seg[2] === "products" && req.method === "GET") {
    // Surface products from projects imported before the catalog table existed.
    backfillCatalogFromDevices(db);
    return json(listCatalogProducts(db));
  }
  // /api/catalog/import  -> ingest an official .knxprod product database into the
  // catalog (products + their application programs). No project is created; the
  // products are pinned so they persist independent of any project.
  if (seg.length === 3 && seg[2] === "import" && req.method === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
    const bytes = Buffer.from(await file.arrayBuffer());
    // A non-zip (or a zip without manufacturer data) is the realistic wrong-file
    // case; report it as "not a product database" rather than leaking the
    // .knxproj-worded INVALID_KNXPROJ from the zip reader.
    let products: ReturnType<typeof extractCatalogProducts> = [];
    try { products = extractCatalogProducts(bytes); } catch { products = []; }
    if (products.length === 0) return err("CATALOG_IMPORT_EMPTY", "no manufacturer products found in the archive");
    const programs = extractAppPrograms(bytes, products.map((p) => p.appRef));
    // Only keep products whose application program is present, so every catalog
    // entry stays placeable.
    const placeable = products.filter((p) => programs.has(p.appProgramId));
    const pictures = extractPictureBaggage(bytes, programs);
    checkBaggageSize([...pictures.values()].flatMap((m) => [...m.values()]).map((f) => ({ name: f.name, bytes: f.data.length })));
    db.transaction(() => {
      for (const [pid, xml] of programs) putAppProgram(db, pid, xml);
      for (const [pid, files] of pictures) putCatalogBaggage(db, pid, files);
      for (const p of placeable) putCatalogProduct(db, p, true);
    })();
    return json({ products: placeable.length, programs: programs.size }, 201);
  }
  return err("NOT_FOUND", "not found", 404);
}
