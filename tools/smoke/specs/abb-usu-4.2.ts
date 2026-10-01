import type { DeviceSpec } from "../spec.ts";

// ABB US/U 4.2 universal interface (MV-0701, System 7 memory-mapped). The from-factory full download
// was hardware byte-verified 2026-07-18; this spec re-proves the download + the surgical param sweep
// after any code change. Refs pinned verbatim from GET .../config and GET /api/catalog/products.
export const abbUsu42: DeviceSpec = {
  id: "abb-usu-4.2",
  device: {
    appRef: "M-0002_H-2.20.2F.2F.20GHQ.20631.200070-1_HP-A001-13-63C2",
    productRef: "M-0002_H-2.20.2F.2F.20GHQ.20631.200070-1_P-GH.20Q631.200070.20R0111",
    ia: "1.1.201",
    mask: "MV-0701",
  },
  provision: "skip-if-present", // the bench device keeps 1.1.201 between runs; unattended
  // Channel A = "control an LED" (an output). This reveals "Ausgang A" and other objects; the
  // flashLinks capability links the first visible one to a random GA and byte-verifies it on read-back.
  configure: [{ set: { paramRefId: "M-0002_A-A001-13-63C2_P-9_R-9", value: "104" } }],
  // "Ausgang A" is a WRITE-ONLY output: without the bench camera (L3) there is no bus-observable
  // behaviour to assert, so this device is proven to the BYTE (download + link + param sweep), not to
  // the behaviour. Stated honestly rather than faked with an unverifiable groupWrite.
  behaviours: [],
  // Enabling the "Telegr. Ventilspülung" object ADDS com-object #29 (baseline objects [1,3] → [1,3,29]),
  // which rewrites the com-object table: the structuralFlash driver writes it and its revert as
  // structural flashes. Deliberately additive and off the baseline objects [1,3]: it does not touch
  // "Ausgang A" (object 1) the flashLinks capability binds to.
  structuralTrigger: { paramRefId: "M-0002_A-A001-13-63C2_P-437_R-437", value: "1" },
  // The sweep draws from the full visible param set on purpose: the channel-function selectors and
  // object-enables that rewrite the com-object table are NOT excluded, so the sweep also exercises the
  // promote-to-full-download route (COM_OBJECT_TABLE_STALE) alongside the surgical byte flash. Only the
  // baseline channel selector P-9_R-9 is held out, because the sweep drawing it would tear down the
  // objects [1,3] flashLinks binds to. A structural sweep candidate is slower (a full download per
  // mutate + revert), which is the cost of the coverage, not a reason to drop it.
  fuzz: { gaRange: { main: 1, mid: 1, subStart: 1 }, excludeParams: ["_P-9_R-9"], paramSweepRounds: 3 },
};
