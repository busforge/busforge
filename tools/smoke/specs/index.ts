import type { DeviceSpec } from "../spec.ts";
import { gvsAmma } from "./gvs-amma.ts";
import { abbUsu42 } from "./abb-usu-4.2.ts";
import { openknxRaumController } from "./openknx-raumcontroller.ts";
import { openknxRaumControllerInService } from "./openknx-raumcontroller-in-service.ts";
import { thebenTheluxaP300InService } from "./theben-theluxa-p300-in-service.ts";
import { thebenMeteodata140sInService } from "./theben-meteodata-140s-in-service.ts";
import { mdtBe06001InService } from "./mdt-be06001-in-service.ts";
import { auroM0081InService } from "./auro-m0081-in-service.ts";
import { thebenHmg6tInService } from "./theben-hmg6t-in-service.ts";
import { mdtBe02001 } from "./mdt-be02001.ts";
import { jung400021se } from "./jung-400021se.ts";
import { jung400021seSecure } from "./jung-400021se-secure.ts";

// The registry the runner enumerates. Each entry is one hardware device; the runner reads what each
// can do from the product at run time and exercises exactly that. A device in service
// (provision "in-service") runs only when named. See docs/testing.md.
//
// `mdt-be02001` (MDT BE-02001.02, mask MV-0705) carries the property-mapped System 7 full download
// (docs/commissioning.md); its parameter refs were pinned VERBATIM from a live `GET .../config` and
// `GET /api/catalog/products`, so they cannot drift from what the product actually declares.
export const SPECS: DeviceSpec[] = [gvsAmma, abbUsu42, openknxRaumController, mdtBe02001, jung400021se, jung400021seSecure, openknxRaumControllerInService, thebenTheluxaP300InService, thebenMeteodata140sInService, mdtBe06001InService, auroM0081InService, thebenHmg6tInService, thebenJmg4tInService, thebenRmg8tInService, thebenHmg6tInService];
