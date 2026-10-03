import type { DeviceSpec } from "../spec.ts";

// GVS AMMA 4-fold multifunction actuator (M-0085, MV-07B0, System B). A switch actuator with a
// READABLE status object, so it is the spec that proves the device functionally ACTS: write the
// switch, read the status back (an inputToOutput behaviour), not merely that the bytes landed.
// Hardware-proven 2026-07-14/17; refs pinned verbatim from GET .../config and GET /api/catalog/products.
//
// KNX Data Secure since 2026-09-30 (ETS commissioned it; Output 1's switch and status objects sit on
// the secured 0/0/1 next to the Jung's K1). Its tool key exists only in the ETS project, so the spec
// imports that file, as jung-400021se-secure does (password from BUSFORGE_SMOKE_KNXPROJ_PASSWORD), and
// proves the plain behaviour on Output 2: a plain link on Output 1's secured objects would mix secured
// and plain on one object (SECURE_LINK_MIXED).
export const gvsAmma: DeviceSpec = {
  id: "gvs-amma",
  device: {
    appRef: "M-0085_H-AM22AA-16_HP-0072-30-69AA",
    productRef: "M-0085_H-AM22AA-16_P-AMMA.2D04.2F06.2ES",
    ia: "1.1.203",
    mask: "MV-07B0",
    knxprod: "scratchpad/bench-jung-ets-20261001.knxproj",
  },
  provision: "import-knxproj",
  // Baseline: Output 1&2 function = Switch, and enable Output 2. This reveals the switch + status
  // com-objects the behaviour binds to; the behaviour then links them to random plain GAs and flashes.
  configure: [
    { set: { paramRefId: "M-0085_A-0072-30-69AA_P-20_R-20", value: "1" } },
    { set: { paramRefId: "M-0085_A-0072-30-69AA_UP-143_R-143", value: "1" } },
  ],
  behaviours: [
    // Drive the "Switch" input off→on→off and require "Switch status" to TRACK each transition — the
    // real functional proof (the status object carries the read flag, so the device answers it
    // itself). The transitions matter: a stuck-on relay would fail the off steps, so a match on one
    // value cannot pass by luck.
    {
      kind: "inputToOutput", label: "switch drives status",
      inObjRefId: "M-0085_A-0072-30-69AA_O-11_R-12", outObjRefId: "M-0085_A-0072-30-69AA_O-12_R-13",
      steps: [{ write: "00", expect: "00" }, { write: "01", expect: "01" }, { write: "00", expect: "00" }],
    },
  ],
  // Enabling Outputs 3 & 4 (default "Sperren"=disabled → "Schalten") ADDS that channel's com-objects,
  // which rewrites the com-object table: the structuralFlash driver writes it and its revert as
  // structural flashes. Deliberately on Outputs 3 & 4, NOT Outputs 1 & 2: it must not disturb the
  // switch/status objects. ("Enable Output 1" off only changes a parameter byte
  // on this device; it does not remove the com-objects.)
  structuralTrigger: { paramRefId: "M-0085_A-0072-30-69AA_P-9_R-9", value: "1" },
  // It leaves the first Sync after a wrong tool key unanswered (docs/findings.md §30).
  secondSyncAfterWrongKey: true,
  // The seeded param sweep draws from the safe parameters; the two structural enables above are
  // excluded so the sweep does not tear down the behaviour's object graph mid-run.
  // The generated link stays off Output 2's plain objects the behaviour binds to: its fresh address is
  // in "auto" mode, which Busforge secures on a secure device, and a plain address on the same object
  // would mix (SECURE_LINK_MIXED). The restore at the end puts the project file's links back.
  fuzz: {
    gaRange: { main: 1, mid: 2, subStart: 1 },
    excludeParams: ["_P-20_R-20", "_UP-142_R-142", "_UP-143_R-143"],
    excludeComObjects: ["_O-11_R-12", "_O-12_R-13"],
    paramSweepRounds: 3,
  },
};
