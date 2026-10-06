# Load procedures: how Busforge programs a device

Flashing a KNX device is not "write these bytes". The device declares a **load procedure**:
which memory segments to load, under which Load State Machine (LSM), in what order, and how
to finalize so the device validates and activates the change. ETS follows it; Busforge
follows it.

This is a generic, catalogue-driven model: the procedure is **data in the application
program XML**, not per-device code. See [device-memory-model.md](device-memory-model.md) for
the memory layout side, [verification.md](verification.md) for how correctness is proven,
and [status.md](status.md) for what has been driven on real hardware.

## The two axes

| Axis | What it is | Where it comes from |
| --- | --- | --- |
| **Memory layout** | how parameter bytes are arranged (relative vs absolute segment) | app XML `<Code>` segments |
| **Load procedure** | how the transfer is driven and activated | app XML `<LoadProcedures>`, or the mask model for legacy devices |

A device is flashable only when both are handled.

## The three procedure styles (`LoadProcedureStyle`)

| Style | Structure | Busforge |
| --- | --- | --- |
| **ProductProcedure** | one self-contained `<LoadProcedure>`, every `LdCtrl` step inline | **executed directly** from the XML (absolute-segment devices) |
| **MergedProcedure** | `<LoadProcedure MergeId="n">` fragments merged into the management model's base at merge points, selected per operation by a step's `AppliesTo` (`full`/`par`; `all`, and `auto`, the schema default when the attribute is absent, apply to both) | the base is model knowledge (System B); the proven relative path embodies the `par` base, parameterized by the fragments |
| **DefaultProcedure** | nothing in the XML, hardcoded by mask version (legacy BCU1/2) | **explicit gap**: refused, not crashed |

## What the engine does

A generic step executor (`packages/knx/src/loadrunner.ts`, `runLoadPlan`) drives a typed
`LoadPlan` (connect / unload / load / alloc / writeMem / writeSegment / writeProp /
stampAppId / loadCompleted / assertLoaded / restart / disconnect) for both memory models and
both download kinds (parameters and group tables). It asserts the LSM state after every
`load`/`loadCompleted`, so a refused or desynced transition stops before the next write.
Memory writes verify by read-back, unless a step opts into the device's verify-mode echo
instead (only the System B full download does). `writeSegment` resolves the segment address at execution
time, because a relative segment's address is only assigned by the alloc step.

Two transports drive the same events:

- **Property-mapped LSMs** (System B, MV-0705): the load event is an `A_PropertyWrite` to
  (objIdx = LSM index, PID 5 = `PID_LOAD_STATE_CONTROL`), and the state is read back from
  the same property.
- **Memory-mapped LSMs** (BIM M112 masks MV-0700/0701): the load control is an
  `A_Memory_Write` to StandardMemory `0x0104` with the LSM index in the high nibble of
  byte 0, and the load status is an `A_Memory_Read` from `46825 + LsmIdx`. The event and
  state values are identical, only the transport differs. This is carried as
  `MaskInfo.propertyMappedLsms` and threaded into `runLoadPlan({ memMappedLsms })`. A
  surgical parameter flash on such a device needs the same transport as its full download,
  or it talks to a dead property interface.

An opt-out lets the engine reproduce a legacy bracket exactly rather than silently tightening
a hardware-verified path: `load`/`loadCompleted` take `assert:false` (skip the inline state
read). The System B group-table download and the System B full download both use it, each
followed by a final batch of `assertLoaded` steps, because that is byte for byte what their
proven executors did. Every other bracket keeps the asserting default.

## The planners

| Planner | Emits |
| --- | --- |
| `planRelativeParFlash` | the System B parameter bracket: unload, load, alloc (no fill), write the bytes holding an owned bit (the whole image if the allocation moved the segment), stamp the app id, load-completed, restart; the read-back checks the whole segment ([findings.md](findings.md) §14) |
| `planAbsoluteParFlash` | the surgical absolute-segment bracket: per LSM that owns a changed segment, load, write the changed owned runs, load-completed, then restart |
| `planSystemBGaFlash` | the three group tables (com-object, address, association) rewritten in one bracket |
| `planMv0705GaFlash` | the two fixed System 7 group tables |
| `planRelativeStructuralFlash` | a System B change that alters the com-object table: application, com-object table, association and address table (and the security object) in one bracket, reallocated without fill, see [Structural flash](#structural-flash) |
| `planAbsoluteStructuralFlash` | the same on System 7: per load-state machine, in the procedure's order, only the bytes that differ from the device, then one restart |
| `planSystemBFullDownload` | first-time commissioning of a System B device |
| `planAbsoluteFullDownload` | first-time commissioning of an absolute-segment device, walking the declared procedure in order |

The parameter planners are **target-driven and surgical**: only owned bytes that actually
differ from the device are written, so the same call both applies and reverts a change, and
group tables are never touched by a parameter flash. A changed segment the procedure does not
declare (or declares but never loads) is returned as `unplaceable` and never silently
dropped; the server then refuses the flash (`FLASH_SEGMENT_UNPLACEABLE`).

> A flash diffs against the **device**, not the stored project values. A target-vs-database
> diff once silently swallowed a revert: the database held the default while the device held
> the changed byte.

The connection lifecycle stays with the caller. A second `T_Connect` inside a plan would
reset the local sequence counter while the device keeps counting, after which the device
stops answering.

## Par-download step policy (the coverage guard)

A parameter download deliberately does not execute every declared step: a surgical write into
loaded segments must not erase them, and full-download bookkeeping does not apply. That is
only honest if every par-applicable step has an **explicit disposition** (`assessParStep` /
`assessParCoverage`, enforced at runtime by both flash profiles). A step without one
**blocks the flash** with `LOAD_STEP_UNSUPPORTED`: the flash never runs a partial recipe and
reports success.

| Disposition | Steps (par) | Why |
| --- | --- | --- |
| **executed** | `Load`, `LoadCompleted`, `Restart`, `AbsSegment`, `RelSegment` (mode 0 only, any fill value), `WriteAbsMem`/`WriteRelMem` (superseded by the strictly narrower surgical write), relative: `WriteProp` **to PID 27** on object 4 (the declared memory-control-block regions, written after the allocation), and a `WriteProp` an ETS capture shows for that application (the GVS AMMA's object 4 PID 67 = `01`, below) | performed by the planner/executor or the proven base bracket |
| **executed (pre-flight)** | `CompareProp` with inline data | read the declared property (hardware type, application id) and compare before any write; a mismatch aborts with `LOAD_PROC_CHECK_FAILED`. This is a check ETS runs that was previously skipped silently |
| **caller** | `Connect`, `Disconnect` | the session owns the lifecycle |
| **executed (read)** | absolute: `LoadImageProp` **to PID 27** on an application ETS is captured downloading (the Gira M-0008, [below](#ets-captured-system-7-downloads)): a property read of the stamps after the last `LoadCompleted` | ETS reads them there and writes nothing |
| **skipped (documented)** | absolute: `Unload`, `TaskSegment`, `TaskCtrl1` (full-download erase/allocation). relative: `LoadImageProp` **to PID 27 only** (ETS 6 sends nothing for it) | deliberately not executed, each with hardware or capture evidence |
| **blocked, refuse** | everything else: unknown verbs, `LoadImageProp` on any other absolute application, `WriteProp` to any other PID without such a capture, allocation variants (`RelSegment` mode ≠ 0), element-addressed `CompareProp`, and any `Load`/`Unload`/`RelSegment`/`WriteRelMem` on the relative path addressed to an LSM other than 4 | unmodeled; refusing beats a silent partial recipe |

PID 27 is the memory-control-block table: per region of a segment, its size, a control byte and
a CRC the device computes. A System B application may declare the regions of its parameter
segment itself. The Jung 400021SE splits its 7701 bytes into 7700 plus the one byte it changes at
run time; with a single region over the whole segment that byte breaks the CRC and the device
comes back from its next restart with the application in ERROR. Every allocation, in a full
download and in a parameter flash alike, resets the regions (measured on the Jung: two after a
full download and a GA flash, one after a parameter flash without the writes). So both write the
declared entries right after the allocation, exactly as ETS does: the first 8 bytes of the
10-byte `InlineData`, element by element. The device must echo each entry, or the download stops
(`PROPERTY_WRITE_REFUSED`); an entry declared `Verify="false"` only has to come back with its
region size, because the device may fill in the CRC. Entries whose regions do not add up to the segment, that address
another object or carry data beyond the entry are refused (`LOAD_STEP_UNSUPPORTED`). ETS sends no
write for `LoadImageProp`; it reads the device's CRCs back afterwards. On an absolute device a
declared `WriteProp` to PID 27 blocks; `LoadImageProp` is the stamp read the Gira M-0008 captures
show, on that application only, and blocks everywhere else.

A `CompareProp` honours its `Mask`, so a manufacturer that masks out its own manufacturer id
and version and checks only the application number is compared the way it asks to be.
Malformed inline data throws rather than silently truncating to a shorter (and possibly
passing) expected value.

The `RelSegment` **fill byte** (what the device pre-fills a freshly allocated segment with,
before the sparse image write) is honoured, not hardcoded. Most System B devices declare
`Fill=0`; some declare `Fill=255` (the erased-flash state). The full download reads it
(`relParamFillByte`) and threads it into both the allocation and the sparse run selection
(which skips runs equal to the fill), so the un-written regions read back as the fill and the
device's own segment CRC still proves the whole image. Only a non-default allocation **mode**
stays unmodeled.

The full `LdCtrl` vocabulary present in the catalogue (15 verbs) is parsed and pinned by a
coverage test, so a new device introducing an unknown verb fails the build instead of
flashing blind.

### Closing property writes, run because ETS was captured sending them

A `WriteProp` to a manufacturer property says nothing about what the firmware does with it, so it
blocks by default. One is executed, and only for its application: the GVS AMMA-04/06.S
(`M-0085_A-0072-30-69AA`) declares, in its last fragment and `AppliesTo="all"`,

```xml
<LdCtrlWriteProp AppliesTo="all" ObjIdx="4" PropId="67" Verify="true" InlineData="01">
  <OnError Cause="ResourceNotFound" MessageRef="M-0085_A-0072-30-69AA_M-1" />
</LdCtrlWriteProp>
```

and ETS 6 sends exactly that write after the last LoadCompleted, the device echoes `01`, and the
restart follows: in its full download (`captures/gvs-amma-ets-fulldownload-defaults.log` of the
private corpus) and in its partial download of parameters and links (`gvs-amma-ets-partial-links.log`).
Busforge's full download, parameter flash and group-address flash of that application (and its
structural flash, which is not offered for it) end the same way (`closingPropWrites`, `withClosingWrites`): after every LoadCompleted,
right before the restart, and an echo other than `01` stops the flash (`PROPERTY_WRITE_REFUSED`), so
it is never reported as programmed. `tools/etsdiff.test.ts` holds the order against both captures.
For the group-address flash this is inferred, not captured: the partial download above also
reloads object 4, and no capture of a links-only download exists; the write is run there because the
step names every download (`all`) and ETS ends its partial download with it. On the bench device
(GVS AMMA 1.1.203, in Data Secure mode, while both captures are plain), smoke run of 2026-10-06: ten
writes inside the secure session, six full downloads, two parameter flashes and two group-address
flashes, each echoed `01`, each followed by the restart; the device then passed its behaviour,
persistence and restore checks ([status.md](status.md), trace and before/after probe in
evidence/runs/2026-10-06/). A read of PID 67 answers with no element,
right before and right after the run, although its description says readable at level 3; ETS never reads it either, so the
echo is the check.

The evidence is keyed by application, object, property, value and `Verify="true"`, not by verb: a
manufacturer property means whatever that firmware makes of it, so another application's step, or
this one with another value, still blocks: an application that declares the same step without a
capture of its own has its parameter flash, full download, group-address flash and structural flash
refused (`LOAD_STEP_UNSUPPORTED`). What PID 67 does in the device is not known.
The group-address flash takes a step named `grp` or `all` as its own (what ETS's `auto` means for a
group-table download is not shown) and refuses one it does not run (`unrunGrpSteps`), a declared
`CompareProp` aside. The same application's `CompareProp` on PID 66 (`007230`,
also `AppliesTo="all"`) runs as the read-only pre-flight of the full download and the parameter flash.
ETS reads it before its full download, not in its partial download, so the parameter flash reads one
property more than ETS does there. On the bench device it answered `007230` before each of them. The group-address flash runs none, as before. ETS also reads each property's description (`A_PropertyDescription_Read`)
before the check and the write; Busforge does not, and a missing property surfaces as the refused echo.

## Coverage across the catalogue

Surveyed from the real catalogue (`parseLoadProcedures` plus the coverage test in
`packages/product/test/loadproc.test.ts`). The step policy above dispositions every
ProductProcedure and MergedProcedure in the corpus except two classes, both refused:

- **Absolute applications declaring `LdCtrlLoadImageProp` without an ETS capture.** None in the
  corpus since the Gira M-0008 was captured (2026-10-06, [below](#ets-captured-system-7-downloads));
  a new one is refused with `LOAD_STEP_UNSUPPORTED` in the parameter and the group-address flash.
- **DefaultProcedure devices** (legacy BCU1/BCU2, nothing in the XML), refused as the explicit
  gap named in the styles table above.

The System 7 **group-address flash** writes the address and association tables (objects 1 and 2)
and, where the application names the com-object table's segment, the linked bits in it (object 3).
The same par policy holds for the declared steps addressed to those objects (`LsmIdx` or `ObjIdx` 1,
2, and 3 where it rewrites the linked bits): a blocked one refuses the flash with
`LOAD_STEP_UNSUPPORTED` before the device is asked anything, and `TaskCtrl1`, `TaskSegment` and
`Unload` stay documented skips. A declared `CompareProp` is a read of the device, not a step on these
tables, and the group-address flash runs none, as before (the ABB US/U 4.2 declares its
application-id check on object 3; its parameter flash runs it, its group-address flash does not).
Whether the group-address flash should run the application's checks first is an open question
([owned-products.md](owned-products.md)).

The System 7 **full download** walks the procedure's `full` steps (`planAbsoluteFullDownload`) and
executes `Unload`, `Load`, `AbsSegment` (with the segment write), `TaskSegment`, `LoadCompleted`
and `Restart`, and leaves `Connect`, `Disconnect` and `CompareProp` to the caller; any other step
refuses the download (`FULL_DOWNLOAD_STEP_UNSUPPORTED`; a step missing an attribute it needs,
`FULL_DOWNLOAD_STEP_MALFORMED`; no full-download steps at all, `LOAD_PROCEDURE_UNSUPPORTED`). One verb
of the catalogue lands there: `LdCtrlTaskCtrl1` (declared by six applications of the real catalogue
fixtures, four of them owned, none of the MDT or ABB ones). The Gira M-0008 declares it too, but ETS
does not send it there, and that application's full download runs as captured
([below](#ets-captured-system-7-downloads)). So the full download is refused for the Auro presence
detector (M-0081), the Theben TheLuxa P300, the Theben Meteodata 140 S, the Steinel presence detector
(M-008E) and the second Auro application (`M-0081_A-FF31`), and not offered: the planner and `capabilities()` share one check (`absoluteFullStepRefusal`), so the
flag says `fullDownload` exactly where the planner runs the declared steps, and the parameter and
group-address flash are offered exactly where their coverage blocks nothing (`operationRefusals`,
pinned per catalogue fixture against a table written from the declared verbs in
`packages/product/test/offer-what-plans.test.ts`; [owned-products.md](owned-products.md)). The
refusal comes before the device is asked anything, its declared checks included.

Being dispositioned is not a hardware claim: which application programs have actually been
flashed, and how far, is in [status.md](status.md).

`AbsSegment` and `TaskSegment` go to the memory control `0x0104` on every System 7 device, the
property-mapped MV-0705 included (the MDT BE-02001.02 full download is hardware-proven so). ETS
writes them to the load-state machine's PID 5 on that mask instead, 10 bytes each
(`03 00 addr size access memtype flags 00` and `03 02 addr pei manufacturer application version`;
MDT BE-02001.02 and Gira M-0008 captures). Busforge does that only for the applications below; the
switch for the others waits for a bench run ([roadmap.md](roadmap.md)).

## ETS-captured System 7 downloads

For some System 7 applications ETS does not send the declared procedure step by step. Busforge
then sends what an ETS capture of that application shows (`ETS_CAPTURED_SYSTEM7_APPS`,
`packages/product/src/loadproc.ts`), and nothing for an application without one. One so far: the
Gira Tastsensor 3 Komfort, `M-0008_A-10D7-11-2783-O000A` (`DynamicTableManagement="true"`),
captured on the house bus: a full download, a parameter download, a group-address
download and the partial download that reverted both (private corpus
`captures/gira-m0008-ets-*.log`, with the excerpt of ETS's own log beside each, which names every
`LdCtrl*` step it executes).

| Declared | What ETS sends, and Busforge with it |
| --- | --- |
| `Unload` 1, 2, 3 | 1 and 2. The application (LSM 3) is never unloaded |
| `AbsSegment` 1 (16384+243), 2 (16627+241) | the two segments as one region: LSM 1 as long as the address table, LSM 2 directly behind it with the rest (a 17-byte table: 16384+17 and 16401+467) |
| `TaskSegment` 1, 2 | at the table's address |
| `AbsSegment` 3 (seven segments, one a RAM segment without `<Data>`), `TaskSegment` 3, `TaskCtrl1` 3 | not sent: `Load` 3, the data segments written, `LoadCompleted` 3 |
| `LoadImageProp` 1, 2, 3 (`Count="6"`), PID 27 | after the last `LoadCompleted`: `PropertyValue_Read` 1/27, 2/27, 3/27 elements 1 to 6; nothing written |
| `TaskSegment` 5 (after `Restart`) | not sent |

The parameter download is `Load` 3, the changed bytes, `LoadCompleted` 3, the stamp reads, the
restart; the group-address download re-declares the two tables as above, writes the com-object
table in an LSM 3 bracket, reads the stamps and restarts. Busforge's parameter, group-address and
full download run exactly these sequences (`planAbsoluteParFlash`, `planCapturedSystem7GaFlash`,
`planAbsoluteFullDownload`), pinned against the captures in `tools/etsdiff.test.ts`. Where Busforge
departs from ETS, deliberately:

- **It writes whole segments.** ETS reads the stamps before a download and leaves out every byte it
  believes the device already holds ("Differential Download: removed 785 identical bytes"): its
  full download writes 37 bytes: the address table without the device's own address, the
  association table and the 3-byte segment `AS-454E`, which has `SegFlags="0"` and so no stamp that
  could tell ETS it is unchanged. Busforge keeps no stamps; it writes every table and data segment
  of the application and reads each back after the restart. That includes bytes no capture shows
  ETS writing at all, not even in the revert that rewrote the whole parameter image: 80 of the 256
  bytes of `AS-444E` and the last 8 of the com-object table segment `AS-41E5`, which Busforge
  writes from the segments' `<Data>` templates. Whether the firmware keeps state of its own there is
  not known; the read-back proves only that the device holds Busforge's bytes. Before the house
  unit's download the bytes planned were compared with a read of the unit and all equalled it
 ; the product path itself has no such comparison, and whether to write these bytes is
  open ([roadmap.md](roadmap.md)). The parameter flash compares against
  a read of the device instead and writes the bytes that differ, so it leaves out `AS-454E` where
  ETS writes it with the bytes the device already holds.
- **It declares the table segments as PID 5 writes**, as ETS does; this is the one System 7
  download that does (above).
- **It authorizes as ETS does.** The full download sends `A_Authorize` with the free key first and
  goes on only if the device grants level 0, as it granted ETS (`FULL_DOWNLOAD_ACCESS_LEVEL`
  otherwise, before anything is written).
- **It does not switch on verify mode.** ETS reads object 0 PID 14 and writes `04` before its first
  memory write and takes the device's echo of each write; Busforge reads every write back, the
  proof the MV-0705 parameter flash is hardware-proven on.
- **No wire capture of Busforge's run.** The full download ran on the house unit 1.1.x on
  verified, every byte equal to the unit's content before and after (824 of them as
  ETS writes them, the other 88 no ETS capture writes)
  (record); it did not go through the
  logging proxy, so the sequence on the wire is pinned by the tests, not by a capture of the run.
  The parameter and group-address flash have not run on a unit.
- **The full download needs the application in the device.** Every capture ran on a device holding
  this application, which ETS reads first (object 3 PID 13). What ETS sends to a device without it
  is not shown, so Busforge refuses that full download (`FULL_DOWNLOAD_APPLICATION_NOT_LOADED`)
  unless object 3 holds this program id and is loaded.

The captures also show the order of the association table for objects with several addresses: each
object's first link by object number, then the other links by object number and group index.
`buildGroupTablesMv0705` writes that order for the applications below only (`order: "ets-captured"`),
taking the first link as the project stores it (its sending address); every other System 7 device
keeps the order by object, then group index. Two limits: in the captures every object's first address
is also its lowest, so they do not tell "the sending address first" from "the lowest index first";
and no capture of another System 7 product with a multi-address object exists.

What the byte comparisons prove: the tables, the com-object table and the wire sequence are checked
against ETS directly. The parameter bytes are compared for a configuration Busforge decoded from
ETS's own image of the revert (the house project is password-protected and not in the corpus), so
for them the test proves Busforge's decode and encode agree on ETS's bytes, not that it would build
them from the project. Object 64's config byte is the exception that proves the import: ETS writes
`0x4f` where the application's flags give `0x47`, because the house project sets the object's read
flag on this unit ([below](#project-level-com-object-flags)); the test gives that override as the
import stores it, and fails on exactly that byte without it.

## Project-level com-object flags

ETS lets a project set an object's flags and priority per device, over the application's, and keeps
them on the device's `ComObjectInstanceRef` (`ReadFlag`, `WriteFlag`, `CommunicationFlag`,
`TransmitFlag`, `UpdateFlag`, `ReadOnInitFlag` as `Enabled`/`Disabled`, `Priority`). Its downloads
write them into the com-object table.

```
0.xml ComObjectInstanceRef ──import──▶ device_comobj_overrides (attributes verbatim)
                                              │ resolveComObjOverrides: ref id → object number
                                              ▼            of the current configuration
        full download · structural flash · System B group-address flash
                     withInstanceOverrides(application flags, overrides) → com-object table
```

Busforge imports them (also in the `.busforge` export, which refuses an artifact without them) and
lays them over the application's flags in every write that authors the table. It refuses instead
where it cannot do that faithfully:

| Case | Refusal |
| --- | --- |
| a value outside the schema | `COM_OBJECT_OVERRIDE_INVALID` |
| a ref id that is no object of the configuration's com-object table, nor of the application or an absent module instance (those are not written, and neither is their override) | `COM_OBJECT_OVERRIDE_UNRESOLVED` |
| one object set twice, differently | `COM_OBJECT_OVERRIDE_CONFLICT` |
| System 7: update, read-on-init or communication set differently from the application (the config byte has no bit for the first two; its communication bit follows the links), or any override where the full download writes the application's own table (memory-mapped, no `<ComObjectTable CodeSegment>`) | `COM_OBJECT_OVERRIDE_UNWRITABLE` |

The surgical parameter flashes keep the table the device holds. The System 7 group-address flash
keeps it too, but sets each object's communication bit from the links; a project that sets an
object's communication flag differently from the application is refused there as well. Its other
flags stay as the device holds them. A product replacement drops the old application's overrides with its other
configuration.

## Structural flash

A parameter change that alters the com-object table (a channel function with other objects, an
object enabled or disabled) used to need a full download, which rewrites the whole parameter image.
The structural flash writes it the way ETS writes it in a partial download
([findings.md](findings.md) §28), and both flash routes run it when `comObjectTableChanges` is not
empty and the family claims `structuralFlash`. It is claimed only for the application programs in
`STRUCTURAL_FLASH` (profiles.ts: the Jung 400021SE's and the MDT BE-02001.02's), each matched against
an ETS capture and run on its bench device:
the bracket rests on behaviour that differs between stacks (keeping a segment's bytes across a
reallocation at the same address, the order of the writes on thelsing/OpenKNX, the flash commit a
persist-at-LoadCompleted device makes for every `LoadCompleted`). Every other family keeps the full
download for such a change (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`).

```
System B (one bracket)                      System 7 (one bracket per LSM)
unload 4, 3, 2, 1, security object          load 1, changed bytes, load-completed 1
load+alloc 4 (no fill), MCB of 4            load 2, changed bytes, load-completed 2
load+alloc 3, 1, 2 (no fill)                load 3, changed parameter and com-object
write 4: owned bytes                             table bytes, load-completed 3
write 3: bytes that differ                  restart
write 2, 1: whole
security object load
stamp program id
load-completed 4, 3, 2, 1, assert loaded
restart
```

- **What is compared.** Everything is read first: the parameter segment, the three tables, the
  security object. The com-object table is authored from the new configuration and its links, as
  the full download authors it. On System 7 a parameter that was active in the programmed baseline
  and is not in the new configuration returns to its segment's `<Data>` template value, as ETS writes
  it; only bits a parameter of either configuration owns are ever taken, and a deactivated parameter
  only if it is not `Access="None"`, so a text, a value the codec cannot encode or a byte the device
  stamps is never reset.
- **What is written.** On System B the parameter bytes follow the parameter flash (every byte holding
  an owned bit), the com-object table only where it differs, while the reallocation leaves both
  where they were (`writeSegmentOwned`; a moved segment is written whole). On System 7 only bytes
  that differ from the device.
- **What is verified.** After the restart: the parameter segment as the parameter flash checks it
  (on System 7 the restored template bytes too), the three tables and the security object whole,
  and every load-state machine the flash concerns LOADED again (on System B the application too).
- **Where it differs from ETS.** On System 7, ETS also unloads the two group tables and declares their
  segments again; Busforge brackets them as its group-address flash does (load, write,
  load-completed). Busforge writes fewer bytes than ETS (only what differs from the device), never
  other ones.
- **The window a failure leaves.** On System B the bracket unloads the application and the security
  object before the first write. A flash cut off inside it leaves the device without a running
  application, and a secured device without its group keys, until the flash is repeated or a full
  download completes it. The load runner marks a failure that falls between sending the first
  Unload or Load and seeing every machine it opened LOADED again (after LoadCompleted, or its
  batched assert); the task then fails with `FLASH_INTERRUPTED_UNLOADED` ("may have left the device
  unloaded": a failed event may or may not have reached the device). The flash dialog writes no
  further target and, where the family can be downloaded in full, offers the full download (also
  when a later preview finds the device so, `DEVICE_LOAD_INCOMPLETE`). On System B the same flash
  run again also completes the load. Busforge never resumes the bracket by itself. A failure after
  the bracket closed (the restart, the read-back) is not marked.
- **What is adopted.** A verified structural flash adopts the parameter and the link baseline, like
  the full download. It writes the group tables whole, so it takes the group-address flash's
  link-baseline guard (`LINK_BASELINE_INCOMPLETE`). Started from the group-address flash, it writes
  the pending parameter edits too, and the preview says so.
- Families without it still get `COM_OBJECT_TABLE_STALE_USE_DOWNLOAD` or `COM_OBJECT_TABLE_STALE`.

## The flash bracket, and why it is tight

Three device behaviours shape every bracket. They are not visible in the code, so they are
pinned by tests.

### The closing restart can be the persistence boundary

On the thelsing/knx stack (System B, OpenKNX), `LdCtrlLoadCompleted` persists nothing: it
only flushes a buffer. The flash metadata (the four load states, the table addresses, the
individual address, everything the device validates on the next boot) is written from
exactly one place reachable over the bus, on receiving **`A_Restart`**. Before that restart
every available check reads RAM, so a device can report all four load states LOADED and every
table byte-identical while having written nothing to flash.

So `KnxDevice.restart()` proves the reboot instead of assuming it: after the restart the
device must have **stopped answering** on the connection it just acknowledged on. A device
that keeps answering did not reboot and did not save, and that is a `RESTART_IGNORED`
failure. The acknowledgement cannot be the proof, because such a device reboots too promptly
to get one out.

Not every firmware works that way. Some persist at `LoadCompleted` and never go silent on
`A_Restart`, so requiring a reboot would reject a flash that actually landed. That relaxation
is opt-in per manufacturer and only for firmware where it was hardware-verified
(`PERSIST_ON_LOAD_COMPLETED` in `profiles.ts`, proven by a power-cycle test). The default
stays strict.

### The deferred save is armed by the unload and refreshed by writes

On the same stack the load states are written by a deferred save from the device's main
loop, roughly five seconds after its memory was last touched. The timer is **armed only when
memory is freed** (the unloads) and merely **refreshed** by writes. So if it expires in the
middle of a download, the save fires with every load state still LOADING and then never fires
again: the download is thrown away while every single check still passes.

Therefore the bracket stays tight, with exactly one deliberate pause, at the end, before the
restart. And the link is re-opened between that settle and the restart (a connection-oriented
KNX link dies after 6 seconds of silence, so an `A_Restart` sent after an 8-second settle
lands on a connection the device has already torn down). Nothing may touch the device's
memory in that gap: a memory write refreshes the deferred-save timer and would push the save
back out past the restart.

### Unloading a table can invalidate the running application

A group-address flash unloads and rewrites the three tables the running application
references. On some System B stacks that invalidates the application object itself: the
tables read back LOADED and byte-perfect while the application program object drops to
ERROR, the device keeps answering management (so every table verifies green), and every link
is dead. No cheap recovery exists; a bare LoadCompleted, a LOAD plus LoadCompleted and a
restart all leave it in ERROR, only a full download brings it back. Hardware-proven on a Jung
universal interface (Insta stack).

Two consequences, both in the code:

1. **`planSystemBGaFlash` brackets the application object.** It opens object 4's own load
   bracket before the unloads and closes it once the tables are in place, so its
   LoadCompleted revalidates against them. It touches none of the application's memory: no
   unload (that is what frees the parameter image), no alloc, no write, and deliberately
   **no program-id re-stamp**, because nothing here changes the application's identity and
   writing the project's stamp would overwrite the evidence a later parameter flash's
   declared app-id check relies on. The bracket costs two load events and rewrites nothing.
   It is applied only to a device whose application is actually LOADED **and** whose
   manufacturer is on the hardware-proven allowlist (`HOLD_APPLICATION_ON_GA_FLASH`, Jung
   today): the extra LoadCompleted is not free on a persist-at-LoadCompleted device, where it
   triggers another flash persist. On any other device the plan stays byte for byte the old
   table-only bracket, and the `GA_FLASH_BROKE_APPLICATION` guard below is what keeps that
   from failing silently.
2. **The flash records the application object's load state before the write and re-checks it
   after.** A device whose application was LOADED and no longer is fails with
   `GA_FLASH_BROKE_APPLICATION`, naming the recovery (run a full download), instead of
   reporting `verified: true`. The flash dialog then writes no further target and, where the family
   can be downloaded in full, offers the full download. Only a degradation is an error, so a device whose application
   object was already not LOADED gains no new refusal. The re-check goes through the same
   settle-and-retry the table comparison uses, so a device still recovering from the closing
   restart cannot produce a false alarm.

## The pre-unload backup is opt-in (`backupBeforeUnload`, default off)

A full download UNLOADs every segment before it rewrites them, so whatever the device held is
gone the moment it starts. `downloadFull` can first read the device's current memory back and
persist it to `.bin` files, a recovery copy for the one case where it matters: a device
holding a configuration Busforge cannot reproduce (programmed by ETS, never imported).

That read is expensive. A large parameter segment is well over a thousand twelve-byte round
trips, minutes of bus traffic, on a device whose every byte the download is about to derive
from the project and replace. So it is gated behind `FullDownloadCtx.backupBeforeUnload`,
**default `false`**. The whole backup path stays implemented and tested: it sizes each
segment from the device's own memory-control block or table header and **refuses rather than
guessing a length**, because a backup sized from the image about to be written would silently
omit the tail of a larger loaded segment and could not restore what it replaced. No server
route sets the flag today, so production full downloads skip it. Until a UI offers it, the
recovery path for a failed download is to re-run it from the project: the device is left
`LOADING`, recoverable, and is never restarted after a failed write.

## Full download coverage

`downloadFull` writes the application id, the parameter image, the com-object table and the
group tables in one bracket.

- **System B** (`planSystemBFullDownload`): implemented. The parameter segment is written
  sparsely against the allocation's fill byte, and verified by the device's own segment CRC
  (`PID_MCB_TABLE`) rather than by reading thousands of bytes back. Two CRC-16 conventions
  are accepted, because firmware differs: the thelsing/knx variant augments the CCITT CRC
  with 16 zero bits, other System B firmware uses CCITT-FALSE. A CRC matching neither is not
  a failure verdict, it falls back to a full byte-for-byte read-back.
- **Memory-mapped System 7** (MV-0700/0701): implemented. The procedure is walked in order
  and every declared segment written: address and association tables from the links,
  parameter-bearing segments from the built image, and code segments straight from their
  `<Data>` (these devices, unlike OpenKNX, ship the whole application image in the product XML).
  The com-object table, where the application names its segment, is authored as on MV-0705: the
  `<Data>` template with the active objects' config bytes and link bits, as ETS writes it (ABB
  US/U 4.2 captures).
- **Property-mapped System 7** (MV-0705): implemented, and it **authors L3** into the
  application's `<ComObjectTable CodeSegment>`. It is offered exactly when the application
  declares that segment; without it the download refuses (`FULL_DOWNLOAD_UNSUPPORTED`)
  rather than writing a manufacturer-default com-object table. A segment the application
  declares with **no `<Data>`** is declared in the LSM bracket but not written and not read
  back: it is a computed/RAM segment the firmware fills during LoadCompleted, and ETS writes
  nothing to it either.
- **Legacy `DefaultProcedure`** and true property-based loading remain gaps, refused rather
  than approximated.

A full download is virgin-aware: the declared app-id `CompareProp` is sourced from the
download's own `full` steps (a check declared `AppliesTo="full"` would otherwise be missed; one
declared `AppliesTo="all"`, the GVS AMMA's PID 66, belongs to both downloads).
A match means the device already holds this application, an all-zero read means a virgin
device, and a **different** non-zero application is refused, so a full download never lands
the wrong application's image on a device.

Commissioning (address assignment, what a first-time download has to get right, and the
device-specific traps) is in [commissioning.md](commissioning.md).
