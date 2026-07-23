import type { DeviceSpec } from "../spec.ts";
import { gvsAmma } from "./gvs-amma.ts";
import { abbUsu42 } from "./abb-usu-4.2.ts";
import { openknxRaumController } from "./openknx-raumcontroller.ts";

// The registry the runner enumerates. Each entry is one bench device; the runner reads what each can
// do from the product at run time and exercises exactly that. See docs/smoke-framework-redesign.md.
//
// Still to migrate: `mdt-be02001` (MDT BE-02001.02, mask MV-0705, IA 1.1.56) — its appRef/productRef
// and parameter/com-object refs must be pinned VERBATIM from a bench `GET .../config` and
// `GET /api/catalog/products`, which is the B2 hardware task. It is deliberately NOT added with
// guessed refs: a fabricated spec would fail preflight anyway and would violate the refuse-don't-
// pretend rule. Add it in the same session that runs the MDT UI full-download proof.
export const SPECS: DeviceSpec[] = [gvsAmma, abbUsu42, openknxRaumController];
