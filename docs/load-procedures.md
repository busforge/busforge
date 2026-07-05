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
`LoadPlan` (connect / unload / load / alloc / writeMem / writeSegment / writeProp /
stampAppId / loadCompleted / restart / disconnect) for BOTH memory models. It asserts
the LSM state after every `load`/`loadCompleted`, so a refused or desynced transition
stops before the next write. Memory writes verify by read-back; `writeSegment` resolves
the segment address at execution time (a relative segment's address is only assigned by
the alloc step).

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

## Par-download step policy (the coverage guard)

A par download deliberately does not execute every declared step: a surgical write into
loaded segments must not erase them, and full-download bookkeeping does not apply. That
is only honest if every par-applicable step has an **explicit disposition**
(`assessParCoverage`, enforced at runtime by both flash profiles). A step without one
**blocks the flash** with `LOAD_STEP_UNSUPPORTED`: the flash never runs a partial recipe
and reports success.

| Disposition | Steps (par) | Why |
| --- | --- | --- |
| **executed** | `Load`, `LoadCompleted`, `Restart`, `AbsSegment`/`RelSegment` (mode 0), `WriteAbsMem`/`WriteRelMem` (superseded by the strictly narrower surgical write) | performed by the planner/executor or the proven base bracket |
| **executed (pre-flight)** | `CompareProp` with inline data | read the declared property (e.g. hardware type, PID 78) and compare before any write; a mismatch aborts with `LOAD_PROC_CHECK_FAILED` (the check ETS runs, previously skipped silently) |
| **caller** | `Connect`, `Disconnect` | a second T_Connect would desync the sequence counter; the session owns the lifecycle |
| **skipped (documented)** | absolute: `Unload`, `TaskSegment`, `TaskCtrl1` (full-download erase/allocation; hw-evidenced M-0081 1.1.x). relative: `WriteProp`/`LoadImageProp` **to PID 27 only** (MCB stamp; hw-evidenced M-0162 1.1.x + Theben 493B 1.1.x) | deliberately not executed, with hardware evidence |
| **blocked → refuse** | everything else: unknown verbs, `LoadImageProp` on absolute devices (M-0008), `WriteProp` to any other PID, allocation variants (`RelSegment` mode ≠ 0), element-addressed `CompareProp` | unmodeled; refusing beats a silent partial recipe |

## Coverage across the project's app programs

Surveyed from the full real catalogue (`parseLoadProcedures` + the coverage test
`packages/product/test/loadproc.test.ts`, which asserts no unknown `LdCtrl` verb slips
through).

| App program (devices) | Style | Model | Status |
| --- | --- | --- | --- |
| M-0081 (11) Auro detector | Product | absolute | **flashed + verified on hardware** |
| M-0008 (9) | Product | absolute (+ LoadImageProp, LSM5) | **refused (par)**: declares MCB/load-image stamps we cannot compute; `LOAD_STEP_UNSUPPORTED` until hardware-testable |
| M-008E (2) Steinel | Product | absolute (data-less) | engine-supported; data-less caveat |
| M-0048 A-107E, A-140C (2) | Product | absolute | engine-supported |
| M-0083 A-00B4, A-00B6 (2) | Product | absolute (+ CompareProp) | engine-supported; CompareProp executed as pre-flight |
| M-0162 (1) MEAN WELL PSU | Merged | relative | **flashed + verified** (existing relative path) |
| M-0048 A-493B (5) Theben HMG | Merged | relative (+ WriteProp) | **flashed + verified on hardware** (1.1.x, module per-instance offsets; PID-27 WriteProp is a documented skip) |
| M-0048 A-9071 (1) DALI | Merged | relative (+ CompareProp) | relative path; CompareProp executed as pre-flight; DCA config out of scope |
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
- **Relative path through the engine: DONE.** `planRelativeParFlash` emits the
  hardware-proven System B bracket as a `LoadPlan` and `runLoadPlan` executes it (the
  hardcoded `flashParameters` executor is deleted); the planned step stream is locked
  call-for-call against the retired executor's order in `flash-exec.test.ts` /
  `loadplan.test.ts`. ONE deliberate delta: the engine asserts LOADING after Load
  (as the absolute path always did). Standard LSM behavior, abort happens BEFORE any
  write, but **not yet hardware-smoked on a System B device**: run an identity flash
  on the PSU next time the bus is available.
- **Property-object verbs**: `CompareProp` is executed (pre-flight check).
  `LoadImageProp`/`WriteProp` to PID 27 (MCB) are a documented, hardware-evidenced skip
  on relative devices and **block** the flash on absolute devices (M-0008) until a
  device that needs them can be hardware-tested. Any other target PID blocks everywhere.
- **DefaultProcedure (legacy)** and **module per-instance offsets** remain gaps, tracked
  in [device-memory-model.md](device-memory-model.md).
