// The declarative fixture that carries EVERY device-specific fact the generic runner needs.
// The runner (runner.ts) contains zero device knowledge; a recipe is the whole contract for
// one proven device. Refs are pinned verbatim as the API reports them (GET .../config and
// GET /api/catalog/products); a typo is a TypeScript error here, and P0 re-checks every ref
// against the device before any bus write. See docs/e2e-smoke-framework.md.

// One ordered configuration step. Earlier params may reveal later com-objects, so order matters.
export type ConfigStep =
  | { set: { paramRefId: string; value: string } }
  | { link: { comObjRefId: string; ga: string } };

// A functional bus check driven by the witness tunnel (group traffic only).
export type BusCheck =
  // Read a group object and require the device to answer (optionally a specific value).
  | { groupRead: { ga: string; expectValue?: string } }
  // Write a group object, then optionally read it back or expect the device to transmit.
  | { groupWrite: { ga: string; value: string }; readBack?: { ga: string; expectValue: string } };

export interface Recipe {
  id: string; // report key, e.g. "abb-usu-4.2"
  device: {
    appRef: string;      // as listed by GET /api/catalog/products
    productRef: string;  // ditto (copy verbatim, never reconstruct)
    ia: string;          // target individual address on the bench bus
    mask: string;        // expected mask, asserted against FlashResult.mask
    knxprod?: string;    // optional path to import; if absent the product must already be in the catalog
  };
  // "skip-if-present": if the device already answers on its IA, skip assign-ia (unattended run).
  // "require-prog-mode": the operator must press the programming button (semi-attended).
  provision: "skip-if-present" | "require-prog-mode";
  // "download": a full commission (System B, memory-mapped System 7). "flash": params + GA on an
  // already-loaded device (property-mapped MV-0705). The runner branches ONLY on this declaration,
  // so a silently-flipped capability (the endpoint now refuses the declared mode) is a test failure.
  commission: "download" | "flash";
  // Optional named precondition printed before provisioning (e.g. OpenKNX needs `erase openknx`).
  precondition?: string;
  configure: ConfigStep[];
  verify: {
    // L1: the GAs that must appear in the device's read-back group tables, on the expected objects.
    readback: { expectGas: string[] };
    // L2: functional drive via the witness tunnel (optional; without it, correctness is proven to
    // the byte, not to the behaviour).
    bus?: BusCheck[];
  };
  // P7: the change→verify→revert→verify proof that exercises the write path EVERY run, not just on
  // a virgin device. The runner captures the parameter's current value, flashes it to `value`,
  // proves the device holds it, then flashes it back and proves the device is at the canonical
  // value again. Must be a numeric/enum parameter whose change does NOT restructure the com-object
  // table (else the flash's own staleness gate refuses it), so a send-delay is the safe choice.
  mutation?: { paramRefId: string; value: string };
}
