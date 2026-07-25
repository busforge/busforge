import type { DeviceSpec } from "../spec.ts";
import { gvsAmma } from "./gvs-amma.ts";
import { abbUsu42 } from "./abb-usu-4.2.ts";
import { openknxRaumController } from "./openknx-raumcontroller.ts";
import { mdtBe02001 } from "./mdt-be02001.ts";
import { jung400021se } from "./jung-400021se.ts";

// The registry the runner enumerates. Each entry is one hardware device; the runner reads what each
// can do from the product at run time and exercises exactly that. See docs/testing.md.
//
// `mdt-be02001` (MDT BE-02001.02, mask MV-0705) carries the property-mapped System 7 full download
// (docs/commissioning.md); its parameter refs were pinned VERBATIM from a live `GET .../config` and
// `GET /api/catalog/products`, so they cannot drift from what the product actually declares.
export const SPECS: DeviceSpec[] = [gvsAmma, abbUsu42, openknxRaumController, mdtBe02001, jung400021se];
