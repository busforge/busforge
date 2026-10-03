import { extractAppPrograms, extractCatalogProducts } from "@busforge/project";
import { comObjectUniverse, MANUFACTURERS } from "@busforge/product";
import { putAppProgram, putCatalogProduct, listCatalogProducts, backfillCatalogFromDevices } from "../db/catalog.ts";
import { loadCatalogApp } from "../deviceservice.ts";
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
    db.transaction(() => {
      for (const [pid, xml] of programs) putAppProgram(db, pid, xml);
      for (const p of placeable) putCatalogProduct(db, p, true);
    })();
    return json({ products: placeable.length, programs: programs.size }, 201);
  }
  return err("NOT_FOUND", "not found", 404);
}
