# Load procedures: how Busforge programs a device

Flashing a KNX device is not "write these bytes". The device declares a **load
procedure**: which memory segments to load, under which Load State Machine (LSM), in
what order, and how to finalize so the device validates and activates the change. ETS
follows it; Busforge follows it. Verified on real MV-0705 hardware (a parameter change
applied and reverted on an Auro M-0081 motion detector, LSM3 reaching LOADED).

This is the generic, catalogue-driven model: the procedure is **data in the app program
XML**, not per-device code. See also [device-memory-model.md](device-memory-model.md)
for the memory layout side and [verification.md](verification.md) for how correctness is
proven.

## The two axes

| Axis | What it is | Where it comes from |
| --- | --- | --- |
| **Memory layout** | how parameter bytes are arranged (relative vs absolute segment) | app XML `<Code>` segments |
| **Load procedure** | how the transfer is driven and activated | app XML `<LoadProcedures>` (or the model, for legacy) |

A device is flashable only when both are handled.

## The three procedure styles (`LoadProcedureStyle`)

| Style | Structure | Busforge |
| --- | --- | --- |
| **ProductProcedure** | one self-contained `<LoadProcedure>`, every `LdCtrl` step inline | **executed directly** from the XML (absolute-segment / MV-0705 devices) |
| **MergedProcedure** | `<LoadProcedure MergeId="n">` fragments merged into the management model's base at merge points, selected per operation by a step's `AppliesTo` (`full`/`par`) | base is model knowledge (System B); the proven relative path embodies the `par` base, parameterized by the fragments |
| **DefaultProcedure** | nothing in the XML; hardcoded by mask version (legacy BCU1/2) | **explicit gap** (refused, not crashed) |

## What the engine does

A generic step executor (`packages/knx/loadrunner.ts`, `runLoadPlan`) drives a typed
`LoadPlan` (connect / unload / load / alloc / writeMem / writeProp / loadCompleted /
restart / disconnect). It asserts the LSM state after every `load`/`loadCompleted`, so a
refused or desynced transition stops before the next write. Memory writes verify by
read-back.

The planner (`packages/product/deviceflash.ts`, `planAbsoluteParFlash`) turns a parsed
procedure plus the built segment images plus a **live device read** into that plan. It
delegates byte selection to `planAbsoluteSegmentFlash` (one owned-byte authority, no
duplicate run logic) and is **target-driven and surgical**: only owned bytes that
actually differ from the device are written, so the same call both applies and reverts a
change, and group tables are never touched by a parameter flash. It derives the
LSM-per-segment structure from the procedure and emits the minimal proven bracket per
changed LSM. A changed segment the procedure does not declare is returned as
`unplaceable` (never silently dropped); the server then refuses the flash
(`FLASH_SEGMENT_UNPLACEABLE`).

> A flash diffs against the **device**, not the stored project values. (A target-vs-DB
> diff once silently swallowed a revert: the DB held the default while the device held
> the changed byte.)

## Coverage across the project's app programs

Surveyed from the full real catalogue (`parseLoadProcedures` + the coverage test
`packages/product/test/loadproc.test.ts`, which asserts no unknown `LdCtrl` verb slips
through).

| App program (devices) | Style | Model | Status |
| --- | --- | --- | --- |
| M-0081 (11) Auro detector | Product | absolute | **flashed + verified on hardware** |
| M-0008 (9) | Product | absolute (+ LoadImageProp, LSM5) | engine-supported; not yet hw-verified |
| M-008E (2) Steinel | Product | absolute (data-less) | engine-supported; data-less caveat |
| M-0048 A-107E, A-140C (2) | Product | absolute | engine-supported |
| M-0083 A-00B4 (1) | Product | absolute (+ CompareProp) | engine-supported |
| M-0162 (1) MEAN WELL PSU | Merged | relative | **flashed + verified** (existing relative path) |
| M-0048 A-493B (5) Theben HMG | Merged | relative (+ WriteProp) | blocked by module per-instance offsets (image build, not the procedure) |
| M-0048 A-9071 (1) DALI | Merged | relative (+ CompareProp) | relative path; DCA config out of scope |
| M-0083 A-0137 (1) | Merged | relative | relative path |
| M-0083 A-0138 (1) Gira | **Default** | (none in XML) | **gap: legacy, refused** |

The full `LdCtrl` vocabulary present in the catalogue (15 verbs) is parsed and pinned by
the coverage test, so a new device introducing an unknown verb fails the build instead of
flashing blind.

## What is implemented now

- **Parser** for all three styles + operation selection (`flattenSteps` by `par`/`full`).
- **Engine** (`runLoadPlan`) with per-step LSM-state assertions and read-back-verified writes.
- **Absolute (MV-0705) parameter flash**, wired into the server flash route, surgical
  `par` mode. Replaces the previous "refused" state for these 6 app programs.

## Deferred (named, not silent)

- **Full download mode.** A faithful full procedure rewrites every segment incl. app
  code / RAM / task segments, whose bytes Busforge does not build (only the parameter
  image). Full mode is therefore limited to what we can construct; first-time
  commissioning of a virgin device is out of scope.
- **Route the relative path through the engine.** The relative `flashParameters` is
  hardware-proven and stays as-is; folding it into `runLoadPlan` is a low-risk cleanup,
  validated first by asserting the planned step sequence matches it.
- **Property-object verbs** (`LdCtrlLoadImageProp`/`WriteProp`/`CompareProp`) are parsed
  but only needed for the absolute `par` path where the proven device did not require
  them; they are wired when a device that needs them is hardware-tested.
- **DefaultProcedure (legacy)** and **module per-instance offsets** remain gaps, tracked
  in [device-memory-model.md](device-memory-model.md).
