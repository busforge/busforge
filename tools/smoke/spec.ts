// The declarative fixture for one bench device, in the capability/behaviour framework. It carries
// NO list of capabilities: what a device can do is read from the product at run time
// (config.capabilities, i.e. classify().capabilities()), and the runner exercises exactly those.
// The spec supplies only what the product cannot know: the bench identity, how to provision it, the
// baseline configuration that brings it to a linkable state, the bus-observable behaviours to prove,
// and the fuzz policy the Layer-1 generator draws from. See docs/testing.md and
// /CONTEXT.md (Capability / Behaviour / Channel).

// The path a capability is driven through over the same hardware. `api` hits the production
// endpoints directly (fast regression); `ui` drives the real web app in Chromium (the user path).
// Assertions always read the API in both. See /CONTEXT.md "Channel".
export type Channel = "api" | "ui";

// One ordered baseline configuration step. Order matters: an earlier param may reveal the com-object
// a later step links (dynamic visibility is resolved server-side on every edit).
export type ConfigStep =
  | { set: { paramRefId: string; value: string } }
  | { link: { comObjRefId: string; ga: string } };

// Parameters that must hold a given value for a behaviour's object to exist and act (e.g. a channel
// set to "Switch", an output "enabled"). Applied before the behaviour's object is linked and flashed.
export type Enable = { paramRefId: string; value: string }[];

// A behaviour: a function the device performs ON THE BUS, verified by observation after the framework
// configures it, links its object(s) to a RANDOM group address (from the fuzz policy), and flashes.
// This is the real correctness proof; a byte-matched read-back is not (a wrongly-but-consistently
// encoded value reads back green). See /CONTEXT.md "Behaviour".
// A behaviour normally allocates a RANDOM group address, links the object, and flashes it (the
// System B / System 7 surgical path). Where surgically re-flashing the device is unsafe (an OpenKNX
// device that is programmed only by a full download — a surgical re-flash is the death-loop risk),
// the object is instead linked in the baseline `configure` and committed by the fullDownload, and the
// behaviour just OBSERVES a FIXED group address. A `ga` (or `inGa`/`outGa`) present selects that
// observe-only mode; absent selects the allocate-link-flash mode.
export type BehaviourSpec =
  // The device transmits on the object unprompted (a heartbeat / "in operation" / cyclic object).
  // We listen on its GA and require a telegram within the window (optionally a specific value).
  | { kind: "heartbeat"; label: string; comObjRefId: string; enable?: Enable; windowMs: number; expectValue?: string; ga?: string }
  // The object is readable: a GroupValueRead is answered by the device itself (a status/output with
  // the read flag). We read and require a response (optionally a specific value).
  | { kind: "output"; label: string; comObjRefId: string; enable?: Enable; expectValue?: string; ga?: string }
  // An input drives an output: write the input's GA, then read the output's GA and require the
  // effect. `steps` is a SEQUENCE of write→expect transitions, not a single match: driving the output
  // to a known-opposite value first and observing it CHANGE is what proves the input caused the
  // effect. A one-shot "write 01, read 01" passes on a stuck-on output (green ≠ device-correct); at
  // least two steps to different values are required, and the runner refuses a spec that gives fewer.
  | { kind: "inputToOutput"; label: string; inObjRefId: string; outObjRefId: string; enable?: Enable; steps: { write: string; expect: string }[]; inGa?: string; outGa?: string }
  // A readable object on a SECURED group address (Data Secure): the witness sends a GroupValueRead
  // encrypted with the address's key from its tunnel address, and requires the device's own secured
  // GroupValueResponse, opened with the same key. Observe-only: the address and its key come from the
  // imported project, and the witness's address must be one of the address's senders there.
  | { kind: "securedOutput"; label: string; ga: string; expectValue?: string };

// The seeded Layer-1 fuzzer policy: the space it may draw from, and what it must never touch.
export interface FuzzPolicy {
  // The group-address space behaviour and generated links are allocated from (a middle group). The
  // allocator walks sub-addresses from `subStart` (default 1) upward within main/mid.
  gaRange: { main: number; mid: number; subStart?: number };
  // Parameter refs the generator must never mutate (unsafe on THIS device or bench-specific).
  excludeParams?: string[];
  // Com-object refs the generator must never link (e.g. an object with no safe bench group address).
  excludeComObjects?: string[];
  // Budget: how many single-param surgical sweep rounds and full-download rounds to run. A sweep
  // round mutates ONE generated parameter and flashes it; a param that alters the com-object table
  // runs as a structural flash, or is auto-routed to a full download where the family cannot write it
  // that way (COM_OBJECT_TABLE_STALE_USE_DOWNLOAD). 0 disables that kind of round. Defaults live in
  // generate.ts.
  paramSweepRounds?: number;
  fullDownloadRounds?: number;
}

export interface DeviceSpec {
  id: string; // report key, e.g. "gvs-amma"
  device: {
    appRef: string;      // as listed by GET /api/catalog/products (copy verbatim, never reconstruct)
    productRef: string;  // ditto
    ia: string;          // target individual address on the bench bus
    mask: string;        // expected mask, asserted against FlashResult.mask
    knxprod?: string;    // provision "import-knxproj": the ETS project file (repo-relative); otherwise an optional import path
  };
  // "skip-if-present": if the device already answers on its IA, skip assign-ia (unattended).
  // "require-prog-mode": the operator presses the programming button (semi-attended).
  // "import-knxproj": the project is imported from `device.knxprod` with the password in
  // BUSFORGE_SMOKE_KNXPROJ_PASSWORD, which is how a Data Secure device's keys reach the server; the
  // device must already answer on its IA. The run ends by restoring the imported configuration on the
  // device and proving it (dry runs `unchanged`), so the ETS project stays valid for it.
  provision: "skip-if-present" | "require-prog-mode" | "import-knxproj";
  // A named precondition printed before provisioning (e.g. an OpenKNX console erase). Human-run.
  precondition?: string;
  // The baseline configuration that brings the device to a known, linkable state (params that reveal
  // the objects the behaviours bind to, plus any fixed links). The generator layers on top of this.
  configure: ConfigStep[];
  // Bus-observable behaviours to prove. Empty means the device is proven to the byte only (no
  // behavioural correctness), which the runner records honestly rather than hiding.
  behaviours: BehaviourSpec[];
  // The seeded parameter fuzzer policy. Absent = baseline configuration only, no generated mutation.
  fuzz?: FuzzPolicy;
  // A parameter change that ALTERS the device's com-object table (adds/removes objects or flags): the
  // structuralFlash driver sets this value, writes it as one structural flash, then restores the
  // canonical value the same way. Absent leaves structuralFlash reported `unproven` (honestly, never
  // faked green). Example: a channel function whose objects differ from the canonical one's.
  structuralTrigger?: { paramRefId: string; value: string };
  // The channels this device must pass in. A capability the product claims but that is never
  // exercised in one of these channels is a HARD failure (never a skip). Default: both.
  channels?: Channel[];
  // Capabilities the PRODUCT claims that this device must NOT exercise on the bench, each with the
  // hardware reason. This is the one honest exception to "exercise every claimed capability": it is
  // not a silent skip (it is declared here and reported as `unsafe`, proven by nothing), and it is
  // not a fake pass. Example: OpenKNX flashParams/flashLinks — a surgical re-flash of a device that
  // is only ever programmed by a full download is the documented death-loop risk (docs/commissioning.md).
  unsafe?: { capability: string; reason: string }[];
}
