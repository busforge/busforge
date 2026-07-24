import type { DeviceSpec } from "../spec.ts";
import { gvsAmma } from "./gvs-amma.ts";
import { abbUsu42 } from "./abb-usu-4.2.ts";
import { openknxRaumController } from "./openknx-raumcontroller.ts";
import { mdtBe02001 } from "./mdt-be02001.ts";

// The registry the runner enumerates. Each entry is one bench device; the runner reads what each can
// do from the product at run time and exercises exactly that. See docs/smoke-framework-redesign.md.
//
// `mdt-be02001` (MDT BE-02001.02, mask MV-0705, IA 1.1.56) carries the property-mapped System 7 full
// download (docs/mv0705-full-download.md); its refs were pinned VERBATIM from a bench `GET .../config`
// and `GET /api/catalog/products` in the B2 session that ran its UI full-download proof.
export const SPECS: DeviceSpec[] = [gvsAmma, abbUsu42, openknxRaumController, mdtBe02001];
