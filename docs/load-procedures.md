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

A generic step executor (`packages/knx/src/loadrunner.ts`, `runLoadPlan`) drives a typed
`LoadPlan` (connect / unload / load / alloc / writeMem / writeSegment / writeProp /
stampAppId / loadCompleted / assertLoaded / restart / disconnect) for BOTH memory models
and BOTH download kinds (parameters and group tables). It asserts the LSM state after
every `load`/`loadCompleted`, so a refused or desynced transition stops before the next
write. Memory writes verify by read-back; `writeSegment` resolves the segment address at
execution time (a relative segment's address is only assigned by the alloc step).

An opt-out lets the engine reproduce a legacy bracket exactly rather than silently
tightening a hardware-verified path: `load`/`loadCompleted` take `assert:false` (skip the
inline state read). The System B group-table download uses it plus a final batch of
`assertLoaded` steps, because that is byte-for-byte what its proven executor did (which
asserted completion only in a batch, not inline). Its writes still read-back verify like
every other bracket; every other bracket also keeps the asserting default.

The planner (`packages/product/src/deviceflash.ts`, `planAbsoluteParFlash`) turns a parsed
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
| **executed** | `Load`, `LoadCompleted`, `Restart`, `AbsSegment`/`RelSegment` (mode 0, **any fill value**), `WriteAbsMem`/`WriteRelMem` (superseded by the strictly narrower surgical write) | performed by the planner/executor or the proven base bracket |
| **executed (pre-flight)** | `CompareProp` with inline data | read the declared property (e.g. hardware type, PID 78) and compare before any write; a mismatch aborts with `LOAD_PROC_CHECK_FAILED` (the check ETS runs, previously skipped silently) |
| **caller** | `Connect`, `Disconnect` | a second T_Connect would desync the sequence counter; the session owns the lifecycle |
| **skipped (documented)** | absolute: `Unload`, `TaskSegment`, `TaskCtrl1` (full-download erase/allocation; hw-evidenced M-0081 1.1.x). relative: `WriteProp`/`LoadImageProp` **to PID 27 only** (MCB stamp; hw-evidenced M-0162 1.1.x + Theben 493B 1.1.x) | deliberately not executed, with hardware evidence |
| **blocked → refuse** | everything else: unknown verbs, `LoadImageProp` on absolute devices (M-0008), `WriteProp` to any other PID, allocation variants (`RelSegment` mode ≠ 0), element-addressed `CompareProp` | unmodeled; refusing beats a silent partial recipe |

The `RelSegment` **fill byte** (the value the device pre-fills the freshly allocated segment with,
before the sparse image write) is honored, not hardcoded. Most System B devices declare `Fill=0`
(zero the segment); some declare `Fill=255` (`0xFF`, the erased-flash state, e.g. the GVS AMMA). The
full download reads it (`relParamFillByte`) and threads it into both the allocation and `sparseRuns`
(which skips runs equal to the fill), so the un-written regions read back as the fill and the
device's own segment CRC still proves the whole image. Only a non-default allocation **mode** stays
unmodeled.

## Coverage across the project's app programs

Surveyed from the full real catalogue (`parseLoadProcedures` + the coverage test
`packages/product/test/loadproc.test.ts`, which asserts no unknown `LdCtrl` verb slips
through).

| App program (devices) | Style | Model | Status |
| --- | --- | --- | --- |
| M-0081 (11) Auro detector | Product | absolute | **flashed + verified on hardware** |
| M-0008 (9) | Product | absolute (+ LoadImageProp, LSM5) | **par refused by the current engine**: the procedure declares three `LdCtrlLoadImageProp` MCB/load-image stamps we cannot compute, so `assertParCoverage` throws `LOAD_STEP_UNSUPPORTED` rather than run a partial recipe (M-0008 has no full-download path; par is its only writable operation). The build still **read-back byte-matches** the device, and a param change + restore **was byte-checked on 1.1.x** (see next-steps.md) before this coverage gate (`5fe16d9`) existed; the engine now declines to reproduce that pre-gate flash rather than guess the stamps. |
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
- **Group-address flash through the engine (both models): DONE.** The last two
  hand-rolled executors are gone. `planSystemBGaFlash` (relative, three count-prefixed
  tables) and `planMv0705GaFlash` (absolute, two fixed tables) emit `LoadPlan`s that
  `runLoadPlan` executes, so no flash path bypasses the verified engine anymore. Both
  planners are locked shape-and-execution in `flash-exec.test.ts`. The System 7 GA path
  maps to the asserting engine bracket with NO wire delta (it already asserted and wrote
  verified). The System B GA path is preserved byte-for-byte via the `assert:false` opt-out
  + batch `assertLoaded` (its loads/completions were never asserted inline); its writes
  stay read-back verified as before, so it too carries no new wire behavior.

### The pre-unload backup is opt-in (`backupBeforeUnload`, default OFF)

A full download UNLOADs every segment before it rewrites them, so whatever the device held is gone the
moment it starts. `downloadFull` can first read the device's current memory back and persist it to
`.bin` files, a recovery copy for the one case where it matters: a device holding a configuration
Busforge cannot reproduce (programmed by ETS, never imported). That read is expensive: the parameter
segment alone is ~1800 twelve-byte TP round trips, minutes of bus traffic, on a device whose every byte
the download is about to derive from the project and replace.

So it is gated behind `FullDownloadCtx.backupBeforeUnload`, **default `false`**. The whole backup path
(size the segments from the device's own MCB / table headers, refuse rather than guess a length, persist
before any unload) stays implemented and tested (`packages/product/test/download-full.test.ts`), it just
does not run unless asked. No server route sets the flag today, so production full downloads skip it and
finish minutes sooner. A future UI can offer "back up before commissioning" for the ETS-migration case;
until then the recovery path for a botched download is to re-run it from the project (the device is left
`LOADING`, recoverable, never restarted on a failed write).

## Deferred (named, not silent)

- **Full download / first-time commissioning: DONE for System B.** `downloadFull`
  (`packages/product/src/profiles.ts`, wired at `apps/server/src/routes/deviceops.ts`)
  builds and writes the application id, parameter image, com-object table (LSM3) and
  group tables in one bracket, and it is hardware-proven: a virgin GVS AMMA (M-0085)
  came up byte-identical and survived a power cycle, and the OpenKNX AB-PRE (MV-07B0)
  was commissioned from factory state, verified byte-for-byte at the KNX layer, and
  booted its application on the bus. For OpenKNX the app-code segments are not needed,
  because the firmware ships as a separate USB `.uf2`.
- **Full download / first-time commissioning: DONE for memory-mapped System 7 (MV-0700/0701)**
  too, hardware-verified on the ABB US/U 4.2. `System7Profile.downloadFull` walks the
  device's declared load procedure in order, writing EVERY declared segment — address + association
  tables from the links, parameter-bearing segments from `buildAbsoluteSegmentTargets`, and the
  static com-object-table + code segments straight from their `<Data>` (these devices, unlike
  OpenKNX, ship the whole application image in the product XML). The catch was the transport: these
  BIM M112 masks drive their LSMs through the deprecated MEMORY-MAPPED interface (load control to
  StandardMemory `0x0104`, status from `46825+LsmIdx`), NOT the PID-5 properties the MV-0705 path
  uses (`MaskInfo.propertyMappedLsms`). The `LdCtrlAbsSegment`/`LdCtrlTaskSegment` byte layouts were
  confirmed empirically on the device (LSM state after each control write). **The property-mapped
  System 7 variants (MV-0705/2705/5705) still keep their com-object table from the device** —
  `downloadFull` refuses them (`FULL_DOWNLOAD_UNSUPPORTED`); a surgical `par` flash is their only
  write path.
- **Relative path through the engine: DONE, and hardware-smoked.** `planRelativeParFlash`
  emits the hardware-proven System B bracket as a `LoadPlan` and `runLoadPlan` executes it
  (the hardcoded `flashParameters` executor is deleted); the planned step stream is locked
  call-for-call against the retired executor's order in `flash-exec.test.ts` /
  `loadplan.test.ts`. The ONE deliberate delta, the engine asserting LOADING after Load
  (as the absolute path always did), is now exercised on hardware: a module-instance
  parameter change was flashed and restored, byte-checked, on the Theben HMG 1.1.x
  (a System B / relative device) through this exact engine bracket.
- **Property-object verbs**: `CompareProp` is executed (pre-flight check).
  `LoadImageProp`/`WriteProp` to PID 27 (MCB) are a documented, hardware-evidenced skip
  on relative devices and **block** the flash on absolute devices (M-0008) until a
  device that needs them can be hardware-tested. Any other target PID blocks everywhere.
- **DefaultProcedure (legacy)** remains a gap (the one Gira M-0083 A-0138 device is
  refused, not crashed), tracked in [device-memory-model.md](device-memory-model.md).
  **True property-based loading** (parameters loaded via interface-object property writes
  rather than a memory image) is also not implemented; MV-0705 turned out not to be it,
  but real property-loaders (IP interfaces/routers, cEMI servers) exist.
