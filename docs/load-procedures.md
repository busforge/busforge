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
| **DefaultProcedure** | nothing in the XML, fixed by mask version in the master data (legacy BCU1/2) | System 1 MV-0012: the master data's procedure carried as data, run as ETS runs it for a Data Secure KNXnet/IP interface ([below](#system-1-the-mv-0012-download)); every other one refused, not crashed |

## What the engine does

A generic step executor (`packages/knx/src/loadrunner.ts`, `runLoadPlan`) drives a typed
`LoadPlan` (connect / unload / load / alloc / writeMem / writeSegment / writeProp /
stampAppId / loadCompleted / assertLoaded / restart / disconnect) for both memory models and
both download kinds (parameters and group tables). It asserts the LSM state after every
`load`/`loadCompleted`, so a refused or desynced transition stops before the next write.
Memory writes verify by read-back, unless a step opts into the device's verify-mode echo
instead (only the System B full download does). `writeSegment` resolves the segment address at execution
time, because a relative segment's address is only assigned by the alloc step. `taskCtrl1` is
`LdCtrlTaskCtrl1` as the ETS captures show it: PID 5 `03 04`, the address (2 bytes), the count
(1 byte) and zero bytes to 10 (Auro, Address 0 Count 0: `03 04` and eight zero bytes; TheLuxa P300,
Address 17875 Count 1: `03 04 45 D3 01 00 00 00 00 00`), and the same fields in the `0x0104` control
on a memory-mapped mask; a count beyond one byte is refused, and it asserts the LSM stays LOADING.
The planner encodes it from the declared attributes ([rule R4](#the-rules-by-level)).

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

An opt-out lets the engine reproduce a bracket exactly rather than silently tightening a
hardware-verified path: `load`/`loadCompleted` take `assert:false` (skip the inline state
read). The System B group-table download and the System B full download both use it, each
followed by a final batch of `assertLoaded` steps, because that is byte for byte the bracket
verified on hardware. Every other bracket keeps the asserting default.

## The planners

| Planner | Emits |
| --- | --- |
| `planRelativeParFlash` | the System B parameter bracket: unload, load, alloc (no fill), write the bytes holding an owned bit (the whole image if the allocation moved the segment), stamp the app id, load-completed, restart; the read-back checks the whole segment ([findings.md](findings.md) §14) |
| `planAbsoluteParFlash` | the surgical absolute-segment bracket: per LSM that owns a changed segment, load, write the changed owned runs, load-completed, then restart |
| `planSystemBGaFlash` | the three group tables (com-object, address, association) rewritten in one bracket |
| `planSystem7GaFlash` | the System 7 group tables as ETS's partial download writes them: both tables unloaded and declared where the rules put them, the com-object table in the application's load bracket without unloading or declaring it, the closing steps, the restart |
| `planRelativeStructuralFlash` | a System B change that alters the com-object table: application, com-object table, association and address table (and the security object) in one bracket, reallocated without fill, see [Structural flash](#structural-flash) |
| `planAbsoluteStructuralFlash` | the same on System 7: the group-address flash's table brackets, then the application loaded without unloading or declaring it, the com-object table and the parameter bytes that differ from the device, the closing steps, one restart |
| `planSystemBFullDownload` | first-time commissioning of a System B device |
| `planAbsoluteFullDownload` | first-time commissioning of an absolute-segment device, walking the declared procedure in order, or ETS's partial form on a unit holding the application ([rule R1](#the-rules-by-level)) |

The parameter planners are **target-driven and surgical**: only owned bytes that actually
differ from the device are written, so the same call both applies and reverts a change, and
group tables are never touched by a parameter flash. A changed segment the procedure does not
declare (or declares but never loads) is returned as `unplaceable` and never silently
dropped; the server then refuses the flash (`FLASH_SEGMENT_UNPLACEABLE`).

> A flash diffs against the **device**, not the stored project values. A target-vs-database
> diff silently swallows a revert whenever the database holds the default while the device holds
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
| **executed** | `Load`, `LoadCompleted`, `Restart`, `AbsSegment`, `RelSegment` (mode 0 only, any fill value), `WriteAbsMem`/`WriteRelMem` (superseded by the strictly narrower surgical write), relative: `WriteProp` **to PID 27** on object 4 (the declared memory-control-block regions, written after the allocation) | performed by the planner/executor or the proven base bracket |
| **executed (closing)** | the steps after the last `LoadCompleted` (merge block 7 of a `MergedProcedure`): `LoadImageProp` **to PID 27**, a read of the stamps, and a `WriteProp` to any other property, written as declared and echo-checked where `Verify="true"` (the GVS AMMA's object 4 PID 67 = `01`, below); both families, every download ([rules R11, R12](#the-rules-by-level)) | ETS executes them there, right before the restart |
| **executed (pre-flight)** | `CompareProp` with inline data | read the declared property (hardware type, application id) and compare before any write; a mismatch aborts with `LOAD_PROC_CHECK_FAILED`, as ETS checks it |
| **caller** | `Connect`, `Disconnect` | the session owns the lifecycle |
| **skipped (documented)** | absolute: `Unload`, `TaskSegment`, `TaskCtrl1` (full-download erase/allocation) | deliberately not executed, each with hardware or capture evidence |
| **blocked, refuse** | everything else: unknown verbs, a closing step that cannot be executed as declared (`LoadImageProp` to another property, a `WriteProp` with a `Count` above 1 or data that is not hex), a `WriteProp` outside the closing steps (but the relative path's PID 27), allocation variants (`RelSegment` mode ≠ 0), element-addressed `CompareProp`, and any `Load`/`Unload`/`RelSegment`/`WriteRelMem` on the relative path addressed to an LSM other than 4 | unmodeled; refusing beats a silent partial recipe |

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
write for `LoadImageProp`; it reads the device's CRCs back afterwards, and so does Busforge, on both
families ([rule R11](#the-rules-by-level)). On an absolute device a declared `WriteProp` to PID 27
blocks.

A `CompareProp` honours its `Mask`, so a manufacturer that masks out its own manufacturer id
and version and checks only the application number is compared the way it asks to be.
Malformed inline data throws rather than silently truncating to a shorter (and possibly
passing) expected value.

The `RelSegment` **fill byte** (what the device pre-fills a freshly allocated segment with) is
honoured, not hardcoded. Most System B devices declare `Fill=0`; some declare `Fill=255` (the
erased-flash state). The full download reads it (`relParamFillByte`) and threads it into both the
allocation and the choice of the bytes it leaves to the allocation, so the un-written regions read
back as the fill and the device's own segment CRC still proves the whole image. The full download's
allocation **mode** is read from the step: every captured application declares Mode 1 (filled); one
declaring another is refused (`FULL_DOWNLOAD_STEP_UNSUPPORTED`), and one declaring no allocation gets
the filled one.

The full `LdCtrl` vocabulary present in the catalogue (15 verbs) is parsed and pinned by a
coverage test, so a new device introducing an unknown verb fails the build instead of
flashing blind.

### The closing steps, run as declared

The steps a procedure declares after its last `LoadCompleted` (in a `MergedProcedure`, its merge
block 7) close every download: ETS executes them in declared order right before the restart, in the
full, the parameter and the group-address download alike ([rules R11 and R12](#the-rules-by-level)).
Busforge does the same on both families (`closingSteps`, `withClosing`). A `LoadImageProp` to PID 27
is a read of the stamps, required to arrive and otherwise unused, since Busforge reads the device
instead of keeping stamps. A `WriteProp` to another property is written exactly as declared. Which
steps a download takes follows their `AppliesTo`: the full and the parameter download their own and
`all`/`auto`, the group-address download `grp`, `all` and `auto` (every captured group-address
download shows the reads its procedure declares without `AppliesTo`).

The only closing write in the catalogue fixtures is the GVS AMMA-04/06.S's
(`M-0085_A-0072-30-69AA`), declared in its last fragment, `AppliesTo="all"`:

```xml
<LdCtrlWriteProp AppliesTo="all" ObjIdx="4" PropId="67" Verify="true" InlineData="01">
  <OnError Cause="ResourceNotFound" MessageRef="M-0085_A-0072-30-69AA_M-1" />
</LdCtrlWriteProp>
```

and ETS 6 sends exactly that write after the last LoadCompleted, the device echoes `01`, and the
restart follows: in its captured full download and in its captured partial download of parameters
and links. Busforge's full download, parameter flash and group-address flash of that application end
the same way: after every LoadCompleted, right before the restart, and an echo other than `01` stops
the flash (`PROPERTY_WRITE_REFUSED`), so it is never reported as programmed. `tools/etsdiff.test.ts`
holds the order against both captures. For the group-address flash this is inferred, not captured:
the partial download above also reloads object 4, and no capture of a links-only download exists; the
write is run there because the step names every download (`all`) and ETS ends its partial download
with it. Both captures are of a plain device; how far the write is shown on the device, in Data
Secure mode, is in [status.md](status.md). A read of PID 67 answers with no element, although its
description says readable at level 3; ETS never reads it either, so the echo is the check. What
PID 67 does in the device is not known.

The group-address flash refuses a step named `grp` or `all` that it does not run (`unrunGrpSteps`), a
declared `CompareProp` aside. The same application's `CompareProp` on PID 66 (`007230`,
also `AppliesTo="all"`) runs as the read-only pre-flight of the full download and the parameter flash.
ETS reads it before its full download, not in its partial download, so the parameter flash reads one
property more than ETS does there. The device answers `007230`. The group-address flash runs no
`CompareProp`. ETS also reads each property's description (`A_PropertyDescription_Read`)
before the check and the write; Busforge does not, and a missing property surfaces as the refused echo.

## Coverage across the catalogue

Surveyed from the real catalogue (`parseLoadProcedures` plus the coverage test in
`packages/product/test/loadproc.test.ts`). The step policy above dispositions every
ProductProcedure and MergedProcedure of the catalogue fixtures except one class, refused:

- **DefaultProcedure devices** (legacy BCU1/BCU2, nothing in the XML), refused as the explicit
  gap named in the styles table above, except the System 1 download below.

### System 1: the MV-0012 download

The master data's MV-0012 Load procedure is carried as data (`packages/product/src/system1.ts`): it
stops the application (run error `0x010D` = 00), sets the address table to the device's own address
only (`0x0116` = 01), writes `0x0100`, `0x0104`-`0x010C`, `0x010E`-`0x0115` and `0x0119`-`0x01FE` from
the image, clears `0x00CE`-`0x00DF`, writes `0x0116` from the image, lets the application run again
(`0x010D` = FF) and restarts the device. It declares only `all`, so a parameter download is the same
procedure. ETS 6 runs it on the MDT IP Interface Secure, a Data Secure KNXnet/IP interface, like this,
and Busforge writes the same, write for write in the same order (pinned by `tools/etsdiff.test.ts`
against ETS's own log of the download; the secured memory writes go out in smaller chunks than ETS's
single telegrams, with the same bytes):

1. **Reads first:** the manufacturer id at `0x0104` and the hardware configuration at `0x010C` (a
   manufacturer-written byte the image carries). Busforge reads the whole segment and refuses a unit of
   another manufacturer or with another hardware configuration (`SYSTEM1_UNIT_UNCAPTURED`).
2. **The image** is the segment's `<Data>` with the parameters' values over it, and the application's
   own id (manufacturer, application number, version) at `0x0104`-`0x0107` and its PEI type at
   `0x0109`, where the template carries another application's.
3. **The memory writes:** each image write of the procedure covers only the bytes the `<Mask>` marks or
   a parameter covers, one write per run of them. On the MDT unit the run `0x0119`-`0x01FE` becomes
   `0x0119`-`0x013D` and `0x0172`-`0x01FE`; `0x013E`-`0x0171`, where the unit keeps its IP settings and
   name, is not written to memory. A TTL parameter the `<Mask>` leaves out (`0x0176`, `Access="None"`)
   is written, because a parameter covers it. The writes are the confirmed `A_MemoryExtended_Write`,
   read back by nobody before the restart.
4. **In place of the closing restart:** the security object (type 17) unloaded, loaded, its
   individual address table cleared (element 0 = 0; the unit has none and answers `E_ADDRESS_VOID`,
   which ETS ignores and Busforge tolerates for this write only), load completed. Then the KNXnet/IP
   parameter object (type 11): its MAC address read, and written, in this order, PID 51 (installation
   id, 0), 66 (routing multicast address, 224.0.23.12), 67 (TTL, 32), 76 (friendly name, the product's
   text cut to 30 characters), 55 (IP assignment manual), 60-62 (IP address, mask, gateway from the
   project's `IPConfig`) and 53 (the project's additional addresses on the device's line, its
   tunnelling addresses). The unit keeps PID 67 in `0x0176`, so the TTL parameter's byte reads 32
   afterwards. Then PID 94 (secured service families) switched off for routing, device management and
   tunnelling, and the confirmed restart.

PID 66 and 67 are not in the project: they are ETS's values for an installation without routing
settings of its own. ETS writes the friendly name in its own language; Busforge keeps the language the
unit holds where its name is the product's text in one of the catalogue's languages, else it takes the
catalogue's default language. Busforge reads the unit first and refuses a download that would change its
IP or tunnelling addresses (`SYSTEM1_IP_CHANGE_UNCAPTURED`), one without the device's tool key
(`SYSTEM1_SECURE_SESSION_REQUIRED`) and one over USB (`SYSTEM1_TRANSPORT_UNCAPTURED`). Everything the capture does not show is refused
rather than guessed (`SYSTEM1_KNXIP_UNCAPTURED`): a device name of its own, DHCP or another assignment,
another number of additional addresses than the application takes, tunnelling users, a pending tool
key or authentication code, an installation id, routing multicast address, BCU key or latency
tolerance of the installation. After the restart Busforge reads the segment back (every written byte
but the restamped TTL byte) and every written property.

The System 7 **group-address flash** writes the address and association tables (objects 1 and 2)
and, where the application names the com-object table's segment, the linked bits in it (object 3).
It runs ETS's partial download of a link change on every System 7 application with a procedure of
its own (`planSystem7GaFlash`): both tables unloaded, each loaded, declared where the rules put it
([R3, R5](#the-rules-by-level)), written to its built length without the own individual address
([R7](#the-rules-by-level)), its task segment declared and completed; then the application loaded
without unloading or declaring it, the com-object table written to its counted entries, completed;
the closing steps; the restart. The same par policy holds for the declared steps addressed to those
objects (`LsmIdx` or `ObjIdx` 1, 2, and 3 where it rewrites the linked bits): a blocked one refuses
the flash with `LOAD_STEP_UNSUPPORTED` before the device is asked anything. A declared `CompareProp`
is a read of the device, not a step on these tables, and the group-address flash runs none (the ABB
US/U 4.2 declares its application-id check on object 3; its parameter flash runs it, its
group-address flash does not). Whether the group-address flash should run the application's checks
first is an open question ([roadmap.md](roadmap.md#device-coverage)).

The System 7 **full download** (`planAbsoluteFullDownload`) runs one of two forms
([R1, R2](#the-rules-by-level)). The declared form walks the procedure's `full` steps in their
declared order and executes `Unload`, `Load`, `AbsSegment` (with the segment write), `TaskSegment`,
`TaskCtrl1` (encoded from its attributes, [R4](#the-rules-by-level)), `LoadCompleted`, the closing
steps and `Restart`, and leaves `Connect`, `Disconnect` and `CompareProp` to the caller. The partial
form, on a unit holding an application that declares `PreferPartialDownloadIfApplicationLoaded`,
reloads the tables and writes into the loaded application. Any step a form cannot execute refuses
that form (`FULL_DOWNLOAD_STEP_UNSUPPORTED`; a step missing an attribute it needs,
`FULL_DOWNLOAD_STEP_MALFORMED`; no full-download steps at all, `LOAD_PROCEDURE_UNSUPPORTED`), and so
does a step after the restart other than `Disconnect`, which no capture shows ETS sending. Of the
catalogue fixtures this leaves the Gira M-0008, whose procedure declares a `TaskSegment` 5 after its
restart, with the partial form only: its full download runs on a unit holding the application, and
refuses any other (`FULL_DOWNLOAD_APPLICATION_NOT_LOADED`). The segments refuse the download too
where they leave its bytes unknown (`FULL_DOWNLOAD_SEGMENT_UNKNOWN`): a parameter segment without
`<Data>` (the Steinel presence detector M-008E, whose read-back keeps bytes no active parameter
derives) and a `<Mask>` of a form no capture shows (the second Auro application `M-0081_A-FF31`,
whose mask is shorter than its segment and marks bytes). Both are refused and not offered: the
planner and `capabilities()` share one check (`absoluteFullStepRefusal`, `fullDownloadSegmentRefusal`),
so the flag says `fullDownload` exactly where one form runs, and the parameter and group-address
flash are offered exactly where their coverage blocks nothing (`operationRefusals`, pinned per
catalogue fixture against a table written from the declared verbs in
`packages/product/test/offer-what-plans.test.ts`). The refusal comes before the device is asked
anything, its declared checks included. Before either form the download reads the unit's program id
(object 3 PID 13) and refuses a unit holding another application (`LOAD_PROC_CHECK_FAILED`).

What the user sees follows the same flag. The routes answer a refused full download with the
planner's own code (for example `FULL_DOWNLOAD_SEGMENT_UNKNOWN`), the device page lists the withheld
writes with that reason, and the compatibility matrix shows them `refused`. After an interrupted
flash that left such a device unloaded (`FLASH_INTERRUPTED_UNLOADED` and the other codes of an
unloaded device), the flash dialog offers no download and says that only ETS can complete the load.

The flag also drives two route guards on these applications. A device never verified since it was
placed, or since its product was replaced, is refused the parameter and the group-address flash
with a reason that names ETS instead of the impossible download (`NEVER_PROGRAMMED_USE_ETS`):
none of these applications declares a `CompareProp`, so a surgical flash would write into a device whose
application nothing checks. A parameter change that alters the com-object table is refused with
`COM_OBJECT_TABLE_STALE_USE_ETS`. Both are route-tested offline on `M-0081_A-FF31`. Applications
that are offered their full download send such a device to it instead
(`NEVER_PROGRAMMED_USE_DOWNLOAD`, `COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`); where only the partial form
runs (the Gira M-0008), that download refuses a unit that does not hold the application with
load-state machines 1, 2 and 3 loaded. An application whose full download is refused for another
reason (the tunnelling entries of an IP interface,
[device-support.md](device-support.md#known-gaps)) keeps its surgical flashes.

Being dispositioned is not a hardware claim: which application programs have actually been
flashed, and how far, is in [status.md](status.md).

## The rules, by level

What ETS sends in a download is read off its captures and explained, in this order, by what the
application's catalogue entry declares, by a rule of its family (System 7 property-mapped, System 7
memory-mapped, System B), or by a rule for every KNX device. Busforge codes each behaviour at that
level, keyed on the catalogue attribute, the load-procedure element or the mask, never on a list of
applications (the one list left decides where the structural flash is offered, not what it sends,
[below](#structural-flash)). The captures are the tests: `tools/etsdiff.test.ts` plans the captured
downloads from the catalogue and compares each with ETS's wire and ETS's logged image. A
capture-matched plan is
reference evidence (Busforge's bytes and steps equal ETS's), not a hardware claim; what has run on
which device is in [status.md](status.md).

| # | Rule | Level | Keyed on | Captures that show it |
| --- | --- | --- | --- | --- |
| R1 | A **full download onto a unit that holds the application loaded** takes ETS's partial form; ETS's log names it: "Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded". On System 7 (unit read first: program id equal, load-state machines 1, 2 and 3 LOADED; `absoluteFullForm`): both tables unloaded and written in their brackets, the application neither unloaded nor declared, only loaded, its data segments written into it, completed, the closing steps, the restart. On System B (application object LOADED with this program id, the two things ETS reads; Busforge also wants the three tables LOADED and the application segment at this application's size by its PID 27, and gives any other unit, and the GVS and OpenKNX firmware that do not take the structural bracket, the full form; `planRelativePartialFullDownload`): the structural bracket without the PEI unload, the address and association tables reloaded and written whole, a secured unit's security object reloaded, the application and the com-object table only with the bytes R16 selects, and an object with none is not reloaded at all | catalogue | `<Options PreferPartialDownloadIfApplicationLoaded="true">` and the unit's state | Gira Tastsensor 3 Komfort (MV-0705), ABB US/U 4.2 (MV-0701); Jung 400021SE (no change, a parameter change, a parameter and a link change, the revert), Theben DALI-Gateway (no change); on a Jung 400021SE whose application was not loaded ETS ran the declared form |
| R2 | Otherwise ETS runs the declared `full` steps one by one, in declared order, and reads no load state before the first unload | family System 7 | `LoadProcedureStyle="ProductProcedure"` | Auro presence detector `M-0081_A-FE01`, Theben TheLuxa P300, Theben Meteodata 140 S, MDT BE-02001.02, MDT BE-06001.02 |
| R3 | **Segment and task declarations and the load controls** travel as the load-state machine's PID 5 write on a property-mapped mask, as the 11-byte memory write to `0x0104` on a memory-mapped one (`declarationTransport`) | family System 7 | the mask (MV-0700/0701 memory-mapped) | PID 5: Auro, TheLuxa, Gira, MDT BE-02001.02, MDT BE-06001.02; `0x0104`: Meteodata, ABB |
| R4 | **`LdCtrlTaskCtrl1`** is encoded from its declared attributes: PID 5 `03 04`, Address (2 bytes), Count (1 byte), zero bytes to 10; on `0x0104` the byte `(LSM << 4) | 3`, then `04 00`, the same fields, zero bytes to 11 (`taskCtrl1Of`). A Count beyond one byte or another attribute is refused | family System 7 | `LdCtrlTaskCtrl1@Address, Count, LsmIdx` | Auro (0/0), TheLuxa (17875/1), Meteodata (18155/1, over `0x0104`) |
| R5 | **Where the group tables go**: with dynamic tables the two declared table segments are one region, the address table's segment exactly as long as the table and the association table's directly behind it with the rest; otherwise each table in the segment its load-state machine declares. In the full, the group-address and the structural download alike (`tablePlacement`) | catalogue | `ApplicationProgram@DynamicTableManagement` | `"true"`: Gira, TheLuxa, Meteodata; `"false"`: Auro, MDT BE-02001.02, MDT BE-06001.02, ABB |
| R6 | **A table segment's `<Data>` that no table can reach** (non-FF bytes past 3 + 2 × MaxEntries of the address table, 1 + 2 × MaxEntries of the association table, marked by the segment's `<Mask>` where it declares one) is written by the full download; inside that capacity the segment is table area and only the built table is written; the group-address download writes none of it (`tableSegmentData`) | catalogue | `<Data>`, `<Mask>`, `AddressTable@MaxEntries`, `AssociationTable@MaxEntries` | Meteodata (bytes 511-512 of `AS-4000` written); Gira and TheLuxa (non-FF `<Data>` inside the capacity, not written) |
| R7 | **The device's own individual address** (address-table bytes 1-2) is never written by a download, whatever the `<Mask>` says | family System 7 | the table layout | Auro, Gira, TheLuxa, Meteodata, MDT BE-02001.02, MDT BE-06001.02 |
| R8 | **The association order**: each object's first link (by object number), then the further links by object number and group index (`associations`) | KNX-wide | none (the table build) | System 7: Gira, TheLuxa, Meteodata; System B: Theben MIX 2 (three products), Theben DALI-Gateway. No capture contradicts it (elsewhere every object has one link) |
| R9 | **The System B full download first unloads the PEI program** (LSM 5), an error there ignored; not its partial form (R1) | family System B | the MV-07B0 master data's `Load ap1` (wrapped in `LdCtrlMapError`) | Theben MIX 2, Jung 400021SE, GVS AMMA, Theben DALI-Gateway, OpenKNX RaumController |
| R10 | **The closing restart** is the confirmed restart (A_Restart type 1, erase code 1, channel 0: `81 01 00`) where the application runs ETS's secure procedure variant, the plain A_Restart otherwise (System B, `withConfirmedRestart`) | catalogue | `ApplicationProgram@IsSecureEnabled="true"` | confirmed: Theben MIX 2, Jung 400021SE, GVS AMMA; plain: Theben DALI-Gateway |
| R11 | **Every declared `LdCtrlLoadImageProp`** is a read of the property (PID 27) after the last `LoadCompleted`, in every download, as many elements per request as one response carries on the device (its maximum APDU length); the restart follows on the same connection at once ([closing steps](#the-closing-steps-run-as-declared)) | KNX-wide (load procedure) | `LdCtrlLoadImageProp` | Gira (one element per request), Theben MIX 2, Jung 400021SE (two in one request), GVS AMMA, Theben DALI-Gateway |
| R12 | **A declared `LdCtrlWriteProp` to a property other than PID 27** after the last `LoadCompleted` is written as declared, at its place before the restart, its echo checked where `Verify="true"` | KNX-wide (load procedure) | `LdCtrlWriteProp` | GVS AMMA (full and partial download); no other fixture declares one |
| R13 | **Config bit `0x80` of a System 7 com-object table entry** is the configured object's update flag ([device-memory-model.md](device-memory-model.md#mv-0705-layout-manufacturer-template-plus-overlay)) | family System 7 | `ComObject@UpdateFlag` (the resolved flags) | TheLuxa (object 116), Meteodata (objects 9, 13 and more), MDT BE-06001.02 (objects 36, 39); the Gira, Auro, MDT BE-02001.02 and ABB comparisons pass with it |
| R14 | **Parameters the configuration does not show**: where the application says so, ETS leaves out an inactive parameter every placement of which lies in a branch of an evaluated `choose` that was not taken; its bytes keep the allocation fill in a full download and are not in a parameter download. So a parameter a change activated keeps, after that change is reverted, the value the change wrote: neither tool writes it once it is inactive again, and only a full download that reallocates with fill clears it. Elsewhere such a parameter is written at its parameter default, not at a value the project still stores for it (System B, `buildRelativeSegmentTarget`) | catalogue | `<Options DownloadInvisibleParameters="None">` | Theben MIX 2 (it shows the difference), Jung 400021SE (declares it, its captures unchanged by it); without it the GVS AMMA's downloads write the defaults, the MEAN WELL power supply reads back with them, and the MDT IP Interface/Router's full download writes the defaults of inactive texts and flags its project holds other values for |
| R15 | **A parameter change and a link change in one partial download** go in one bracket set, the structural bracket ([Structural flash](#structural-flash)) | family (System 7, System B) | the family's bracket | Jung 400021SE and MDT BE-02001.02 (a change that reshapes the com-object table); the reverts of a parameter and a link change on the Auro, Gira, TheLuxa, Meteodata and the Theben MIX 2's three products, the Theben DALI-Gateway and the MDT BE-06001.02 |
| R16 | **What a differential download sends into a segment the unit keeps**, region by region of the segment's memory-control block (PID 27): where the region's CRC-control byte is 0, the bytes that differ from the unit; where it is not 0, past the regions, or on a segment that reports none, every byte the image carries. The application's regions are the ones it declares (its `LdCtrlWriteProp` to PID 27), the com-object table's the ones the unit reports. ETS compares against its own record of the last download, Busforge against the unit it reads, so the two send the same bytes whenever that record equals the unit (`differentialMask`). The verify reads the whole segment back and checks every owned bit against the configuration and every other bit against the unit's read, except the `Access="None"` bytes the device sets itself | KNX-wide (System B) | the memory-control block's CRC-control byte | Jung 400021SE: the application's 7700-byte region (control 0) only where it changed, its declared one-byte region (control 1) in every download, the com-object table (control 0) only when it changed, one byte; Theben DALI-Gateway: the com-object table (control 1) whole although unchanged, the application (control 0) unchanged and not reloaded; OpenKNX RaumController parameter downloads: the application (control 0) differential, the com-object table (no memory-control block) whole |

**Which bytes of a data segment**, the rule behind R1 and R2 ([below](#which-bytes-ets-writes)):
a segment ETS loads afresh carries the bytes its `<Mask>` marks and every byte a parameter covers
(the whole segment without a mask); a data segment written into the loaded application carries
exactly the bytes a parameter covers, with or without `<Mask>`, and a segment no parameter covers
gets none (the ABB US/U 4.2's code segment `AS-4600` and its `AS-6F10`). On the memory-mapped masks
ETS reads the unit first and sends only what differs from it (Meteodata, ABB); so does Busforge
(`readCompare`, `differingRuns`): it reads each run in A_Memory_Read blocks (12 bytes on a 15-octet APDU)
and writes, per block, the span from the first to the last differing byte, equal bytes inside the span
included (ABB: block `0x6D00` read, `0x6D01-0x6D0B` written with four equal bytes in it). Every memory
write of a download on such a mask goes so: full download, parameter, group-address and structural
flash. Once a run differs entirely ETS stops reading it and writes the rest ("Giving up optimistice
write after 36 of 36 mismatched bytes"); Busforge reads on, which writes the same bytes wherever the
rest differs too; how many mismatches make ETS give up is not shown, and in the Meteodata's
group-address download the four bytes ETS wrote unread are taken as the segment's `<Data>`. The blocks
are ETS's on a unit with a 15-octet APDU, the only kind captured. `tools/etsdiff.test.ts` pins these
writes against the captures; the hardware runs on the Meteodata and the ABB wrote the whole image.

**How long a memory write is** (KNX-wide): ETS asks an IP interface for its maximum APDU before it
connects (a `SEARCH_REQUEST_EXTENDED` asking for the Extended Device Information DIB; an MDT IP
Interface/Router announces 210) and writes in chunks of the shorter of the device's (`PID_MAX_APDU_LENGTH`)
and the interface's, less the write's own octets: 5 for `A_MemoryExtended_Write` (205 data bytes on that
interface, the OpenKNX RaumController captures), 3 for `A_Memory_Write` (52 on the Theben DALI-Gateway's
55); its log names which limited it ("restricted by ByInterface", "ByTargetDevice"). Busforge asks the
same on the open tunnel, once per device, before the first load-state event of a download
(`KnxIpTunnel.queryMaxApdu`, `writeChunks`). Where the interface announces nothing (a USB interface, an
IP one that does not answer within a second, Busforge's own KNXnet/IP server, which does not answer the
extended search), the path limit stays: 32 bytes extended, 12 classic. A frame whose TPDU is longer than
16 octets goes as an extended frame (control field 1 `0x3C`), as ETS sends it (`0x30`, also through
Busforge's KNXnet/IP server to its USB interface). A line coupler between interface and device that does
not pass long frames is not modelled, by ETS or by Busforge. The query and the longer writes have run on
no device.

**Which bytes a System 7 parameter download writes** (`parWriteSet`, family level): on a
memory-mapped mask (MV-0700/0701) the bytes that differ from the unit, which ETS reads first
(Theben Meteodata 140 S); on a property-mapped mask every byte a parameter's memory covers, changed or
not, in every parameter segment (Auro M-0081_A-FE01, Theben TheLuxa P300, MDT BE-06001.02: their ETS
logs list exactly those bytes). Where the application closes with image stamps (Gira M-0008) ETS
writes only what differs from its record of its last download while the stamps still equal it, the
same every-covered-byte image otherwise; Busforge keeps no record and writes that image. A
`TypeColor` parameter covers three bytes in the RGB and the HSV space (MDT BE-06001.02's image).

**Firmware, not ETS behaviour.** Three exceptions are keyed on the manufacturer, because they
describe a firmware stack, each hardware-shown: `PERSIST_ON_LOAD_COMPLETED` (GVS: the configuration
persists at `LoadCompleted`, so a restart need not prove a reboot), `HOLD_APPLICATION_ON_GA_FLASH`
(Jung: a group-address flash holds the application object in its own load bracket) and
`SETTLE_BEFORE_RESTART` (thelsing/OpenKNX: the full download settles on a fresh connection before
the restart, instead of R11's restart at once). They are described [below](#the-flash-bracket-and-why-it-is-tight).

**Which write service ETS takes, and how it checks a write.** ETS writes memory with the confirmed
`A_MemoryExtended_Write` exactly on the applications declaring `<Options
SupportsExtendedMemoryServices="true">` (GVS AMMA, Jung 400021SE, Theben MIX 2, OpenKNX, MDT IP
Interface/Router), and with the
classic `A_Memory_Write` on every other one, whether the device declares `PID_MAX_APDU_LENGTH` or not:
the Theben DALI-Gateway answers the property with 55, has no such option, and ETS writes it classic in
blocks of 52 bytes (the maximum APDU less 3). That gateway acknowledges an extended write on the
transport layer and never answers it, so the option, not the property, decides; Busforge takes it from
the application and refuses a write to a device declaring a long APDU while the option is unknown.
On a device written classic (System B and System 7 alike: Auro, Gira, MDT BE-02001.02 and BE-06001.02,
Theben TheLuxa P300 and DALI-Gateway) ETS reads object 0 PID 14 and writes it back with bit `04` set
right before its first memory write, in every capture of such a download, and takes the device's echo
of each write. With the extended write it switches on no verify mode in any capture: the device's
answer to each chunk, a return code, is the check. Neither reads memory back. The memory-mapped System 7 masks (ABB US/U 4.2, Theben
Meteodata 140 S) get no verify mode either.

**Busforge reads back, and takes a write confirmation only where the device does not give a byte
back.** After the restart it reads every owned byte and compares it with what it wrote. A byte that
reads otherwise is accepted on the device's write confirmation alone, as ETS accepts it, only where
all of this holds: the operation wrote exactly that value there with the confirmed extended write and the device
answered that chunk with return code `00` (a chunk answered with any other code, or for another
address, stops the write and confirms nothing); the byte reads `FF` before the operation and after it, as
a device returns a byte it does not give back; and some other byte the operation changed reads back
as written, so the write landed. A device that lost or reverted the whole write shows no such byte
and is not verified; a byte that reads data (an old value, a third value) is a mismatch. An operation
that changes nothing but such a field shows nothing landed and ends unverified. The confirmation is
per chunk and carries no value: a device that answers `00` and keeps nothing of a byte reading `FF`
is accepted there, as ETS accepts it. The result names these bytes (`confirmedOnly`), the task API
carries them, and the flash and commission dialogs name their count and device addresses in the
warning colour beside the success line. The rule is
the write service's, KNX-wide, not a list of products: the MDT IP Interface/Router reads its web
interface password field as `FF` after a confirmed write of it. It applies to the parameter flash (System B and System 7), the
System B structural flash and the partial form of the full download, which read the segment before
writing it; the System 7 structural flash is strict;
a full download in the declared form reads nothing first, so every byte there must read back as
written. A classic `A_Memory_Write` has no confirmation to rest on: its own read-back (or verify-mode echo) is
the check.

**Where Busforge departs from ETS, on every rule.** It switches on no verify mode on System 7 and
reads every write back instead; it keeps no stamps, so on a property-mapped System 7 mask it writes the
whole image where ETS leaves out what its stamps say the device holds (on System B it reads the unit
and sends what R16 selects); it reads the load state after its own
load-state writes; and its full download reads the unit's program id first and refuses another
application.

**The System B full download writes the bytes ETS writes.** ETS's image of the application segment
holds the whole segment where it declares a `<Data>` default image (the bytes its `<Mask>` marks and
those a parameter covers, where it declares one), else the bytes a parameter covers. Of that image it
writes every byte that differs from the allocation's fill and the image's bytes between two such bytes
with fewer than 31 bytes between them, bytes outside the image counted; a fill run of 31
bytes or more, the fill before the first and after the last such byte and every byte outside the image
are left to the allocation (`fullDownloadImageCoverage`, `fillAllocatedRuns`). Shown by ETS's own image
and wire on the OpenKNX RaumController, the three Theben MIX 2 products, the Theben DALI-Gateway KNX
plus and the MDT IP Interface/Router (largest gap bridged 30 bytes, smallest left out 31), and by its
wire on the Jung 400021SE and the GVS AMMA; `tools/etsdiff.test.ts` pins Busforge's written bytes to
ETS's for each. The tables are written whole, as ETS writes them.

**The System B parameter flash keeps ETS's record and decides as ETS does.** A download that writes the
parameters reads the stamps its procedure declares after the last LoadCompleted (`LdCtrlLoadImageProp`,
PID 27); ETS keeps them as its record of that download, and so does Busforge, per device in the server's
database (`ImageStamp`, `devices.image_stamps`), replaced by every verified full download, parameter
flash and structural flash, left alone by a group-address flash. Before a parameter download ETS reads
the stamps again, of every region it sends differentially (the application's objects, CRC-control byte
0), and where each equals its record it writes only the owned bytes that differ ("Differential
Download: removed N identical bytes"; Theben DALI-Gateway: one byte of 3009, OpenKNX RaumController: one
of 424, MDT IP Interface/Router: the changed characters); where one does not, or no record exists, every
owned byte ("Differential Image Stamp does not match, falling back"; Theben MIX 2, whose firmware clears
its download marker after the restart, so its stamps never match). A region with another control byte is
written whole and its stamp does not count (the DALI-Gateway's com-object table, control 1, changed by
the group-address download between). `checkedStamps` and `relativeParWriteSet` decide so;
`tools/etsdiff.test.ts` replays each captured pair of downloads, the decision and the bytes. The record
over a restart of the server, and the stamp reads on a device, have run on no device. The System 1
download reads no stamps (ETS's capture of it shows none), so a verified one leaves the device without a
record.

On System 7 the Gira M-0008 also keeps a record, and with it ETS writes, besides the changed byte and
the segment without a stamp (`SegFlags="0"`), three unchanged bytes before it (`0x435C-0x435E`); no
capture shows why, so Busforge keeps no record there and writes the whole image.

## ETS-captured System 7 downloads

On a unit that holds an application declaring `PreferPartialDownloadIfApplicationLoaded`, ETS does
not send the declared procedure step by step but its partial form ([R1](#the-rules-by-level)). The
Gira Tastsensor 3 Komfort, `M-0008_A-10D7-11-2783-O000A` (`DynamicTableManagement="true"`), shows it
in full: its ETS full download, parameter download, group-address download and the partial download
that reverted both are captured, each with the excerpt of ETS's own log, which names every `LdCtrl*`
step it executes ([findings.md](findings.md#32-ets-does-not-run-the-gira-m-0008s-declared-procedure)).
The ABB US/U 4.2 shows the same form on a memory-mapped mask ([below](#which-bytes-ets-writes)).

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
full download run exactly these sequences (`planAbsoluteParFlash`, `planSystem7GaFlash`,
`planAbsoluteFullDownload`), and its structural flash ETS's revert of both
([Structural flash](#structural-flash)), each pinned against the captures in `tools/etsdiff.test.ts`.
The tables as one region follow from `DynamicTableManagement="true"` ([R5](#the-rules-by-level)),
which the TheLuxa P300 and the Meteodata 140 S declare too and whose captures show the same region;
the Auro, ABB and MDT applications declare `"false"`, and ETS declares their tables as the procedure
does. After the full download and the group-address flash Busforge checks that objects 1 and 2
reference (PID 7) the addresses the tables were declared at, since the bytes alone do not show the
device reads them there. Where Busforge departs from ETS, deliberately:

- **It writes ETS's whole image, not ETS's differential cut of it.** ETS reads the stamps before a
  download and leaves out every byte it believes the device already holds ("Differential Download:
  removed 785 identical bytes"): its full download writes 37 bytes: the address table without the
  device's own address, the association table and the 3-byte segment `AS-454E`, which has
  `SegFlags="0"` and so no stamp that could tell ETS it is unchanged. Busforge keeps no stamps; it
  writes the 822 bytes of ETS's image, those 37 and the 785 together, and reads each back after the
  restart. Which bytes the image holds is [below](#which-bytes-ets-writes): the tables to their built
  length, the own address left out, the com-object table to its 91 entries, and of the data segments
  only the bytes a parameter covers, because ETS leaves the application loaded. So the 80 bytes of
  `AS-444E` no parameter covers and the last 8 bytes of `AS-41E5` are written neither by ETS nor by
  Busforge. The parameter flash compares against a read of the device instead and writes the bytes
  that differ, so it leaves out `AS-454E` where ETS writes it with the bytes the device already holds.
- **It declares the table segments as PID 5 writes**, as ETS does on this mask ([R3](#the-rules-by-level)).
- **It authorizes as ETS does.** The partial form of the full download sends `A_Authorize` with the
  free key first and goes on only if the device grants level 0, as it granted ETS
  (`FULL_DOWNLOAD_ACCESS_LEVEL` otherwise, before anything is written).
- **It does not switch on verify mode.** ETS reads object 0 PID 14 and writes `04` before its first
  memory write and takes the device's echo of each write; Busforge reads every write back, the
  check the MV-0705 parameter flash relies on everywhere.
- **The group-address flash writes ETS's image, not more.** It writes the bytes of ETS's image of its
  group-address download, 405 bytes for the captured link: the tables without the own address, the
  com-object table to its 91 entries.
- **The full download needs the application in the device.** Every capture ran on a device holding
  this application, which ETS reads first (object 3 PID 13), with load-state machines 1, 2 and 3
  loaded, and so took the partial form. The declared form of this procedure sends a `TaskSegment` 5
  after the restart, which no capture shows, so Busforge refuses the full download onto any other
  unit (`FULL_DOWNLOAD_APPLICATION_NOT_LOADED`).

The captures also show the order of the association table for objects with several addresses: each
object's first link by object number, then the other links by object number and group index
([R8](#the-rules-by-level)). `buildGroupTablesMv0705` and `buildGroupTables` write that order on every
device, taking the first link as the project stores it (its sending address). One limit: in the
captures every object's first address is also its lowest, so they do not tell "the sending address
first" from "the lowest index first".

What the byte comparisons prove: the tables, the com-object table and the wire sequence are checked
against ETS directly. The parameter bytes are compared for a configuration Busforge decoded from
ETS's own image of the revert (the project behind the captures is not available to the tests), so
for them the test proves Busforge's decode and encode agree on ETS's bytes, not that it would build
them from the project. Object 64's config byte is the exception that proves the import: ETS writes
`0x4f` where the application's flags give `0x47`, because the project sets the object's read
flag on that device ([below](#project-level-com-object-flags)); the test gives that override as the
import stores it, and fails on exactly that byte without it.

How far the parameter flash, the group-address flash and the full download of this application are
shown on the device is in [status.md](status.md).

## Declared-order System 7 downloads

Every other System 7 full download is ETS's declared form ([R2](#the-rules-by-level)): the declared
full-download steps one by one, in the order the procedure declares them, `LdCtrlTaskCtrl1` included
([R4](#the-rules-by-level)). Busforge runs them the same way. Four applications show it with their
captures here: the Theben TheLuxa P300 ([below](#the-theluxa-p300)), the Theben Meteodata 140 S on a memory-mapped mask
([below](#the-meteodata-140-s-memory-mapped)), the MDT BE-06001.02 ([below](#the-mdt-be-0600102)) and the Auro presence detector, `M-0081_A-FE01-11-75D9`,
whose ETS downloads are captured in this order: a full download, a partial download after one
parameter change, one after adding a second group address to object 10, and one that reverted both,
parameters and links in one, each with ETS's own log, which names every `LdCtrl*` step it executes
and dumps the image it writes, `--` where it writes nothing.

| Declared (`full`, in this order) | What ETS sends, and Busforge with it |
| --- | --- |
| `Unload` 1, 2, 3 | PID 5 `04`, each answered UNLOADED |
| `Load` 1, `AbsSegment` 1 (16384+47) | PID 5 `01`; PID 5 `03 00 4000 002F F2 03 80 00`; then the address table's bytes |
| `TaskSegment` 1, `LoadCompleted` 1 | PID 5 `03 02 4000 00 0081 FE01 11` (the address as declared); PID 5 `02` |
| `Load` 2 to `LoadCompleted` 2 (16431+45) | the same for the association table |
| `Load` 3, `AbsSegment` 3 at 1792+250 (`MemType="2"`, no `<Data>`) | declared, nothing written |
| `AbsSegment` 3 at 16476+91, at 16896+256 (`Access="34"`) | declared, each followed by its writes: the com-object table, the parameter bytes |
| `TaskSegment` 3 (16567) | PID 5 `03 02 40B7 00 0081 FE01 11` |
| `TaskCtrl1` 3, `Address="0" Count="0"` | PID 5 `03 04` and eight zero bytes, answered LOADING (`taskCtrl1` in the load plan, encoded from the declared attributes, [R4](#the-rules-by-level)) |
| `LoadCompleted` 3, `Restart` | PID 5 `02`; `A_Restart` |

Before the procedure ETS reads the device descriptor and object 0 PIDs 56, 11, 12 and 78, and
authorizes with the free key (granted level 0). It reads no PID 13 or PID 27 and writes every byte
of its image: the download is not differential.

**Which bytes are written.** ETS loads every segment afresh here (LSM 3 unloaded, each
`LdCtrlAbsSegment` executed), so its image holds of each what the rule [below](#which-bytes-ets-writes)
gives a freshly loaded segment: the address table without the device's own address (bytes 1-2 are
outside `AS-4000`'s mask), the association table and the com-object table whole (`AS-402F`,
`AS-405C` declare no mask; the com-object table's 22 entries fill its 91 bytes), and of the 256-byte
parameter segment `AS-4200` offsets 0-49: the mask covers 0-48, the parameter `P-50` at offset 49
lies outside it and is written, and offsets 3 and 36 belong to no parameter but are in the mask and
are written from `<Data>`. Busforge writes exactly these runs, `0x4000`, `0x4003-0x4006`,
`0x402F-0x4033`, `0x405C-0x40B6`, `0x4200-0x4231`, one memory write per run, and the plan's segments
(read-back, image digest) are those runs. Bytes no parameter covers are read back whole; parameter
bytes as their verify mask says.

**The parameter download.** ETS's partial download after "led feedback" was switched off (`AS-4200`
offset 7, `01` to `00`) is `Load` 3, verify mode, the writes, `LoadCompleted` 3, `A_Restart`: no
unload, no segment declaration, no task segment, no `TaskCtrl1`. ETS's log executes the two
application segments as `LdCtrlWriteMem` (16476+91 and 16896+256), but its image holds nothing of
the com-object table, so nothing is written there. Of the parameter segment it writes every byte a
parameter owns, in runs that skip offsets 3 and 36 (no parameter owns them, and here its image shows
them `--`): `0x4200` 3 bytes, `0x4204` 12, `0x4210` 12, `0x421C` 8, `0x4225` 12, `0x4231` 1. Before
it, besides the identity reads, ETS reads object 3 PID 13 and the load states at `$B6EC`, `$B6ED`.

Busforge's parameter flash (`planAbsoluteParFlash`, unchanged) runs the same bracket, `Load` 3, the
writes, `LoadCompleted` 3, `A_Restart`, and writes `0x4207 = 00` with ETS's value.

**The group-address download.** ETS's partial download after the link change unloads LSM 1 and 2,
then runs each table's declared bracket as in the full download (`Load`, the declared `AbsSegment` at
its declared size 47 and 45, the table's bytes, the declared `TaskSegment`, `LoadCompleted`), then
`Load` 3, the whole com-object table (91 bytes, here unchanged: object 10 was linked already),
`LoadCompleted` 3 and the restart. No `Unload` 3, no `AbsSegment` 3, no `TaskCtrl1`, no stamp reads.
Of the address table it writes `0x4000` and `0x4003-0x4008`, leaving out the device's own address as
in the full download; the associations come by object, then group index (`03 0209 010A 030A`), which
is also ETS's first-link order ([R8](#the-rules-by-level)) for these links. The revert runs the same table brackets
with the old tables and carries the parameter bytes (every parameter-owned byte, as in the parameter
download) in the same LSM 3 bracket, after the com-object table.

Busforge's group-address flash (`planSystem7GaFlash`) runs that sequence, the declarations as PID 5
writes, writes exactly ETS's bytes, and reads back what it wrote (the address table's own address is
neither written nor read back). Its structural flash runs the revert's bracket set
([Structural flash](#structural-flash)), writing of the parameter bytes only the one that differs.

**Tables are written to their length.** ETS writes a table only as long as it is built, and so does
Busforge; when a table shrinks, its old tail stays in the segment behind it
([below](#tables-shrink-their-old-bytes-stay)).

Where Busforge departs from ETS, deliberately:

- **The parameter flash reads the parameter segment first**, which ETS does not; it keeps the bits no
  parameter owns from that read. It writes the bytes ETS writes, every byte a parameter covers; a
  covered byte no active parameter owns carries the device's value, where ETS writes its own image's.
- **It does not switch on verify mode** (object 0 PID 14 `04`), in either download; Busforge reads
  every write back instead, as on the Gira ([above](#ets-captured-system-7-downloads)).
- **It reads the load state after its own load-state writes.** After `Load`, each `AbsSegment`, the
  `TaskCtrl1` and `LoadCompleted` the runner reads PID 5 to assert the state (the same on every
  property-mapped download); ETS takes the state from the write's answer.
- **The group-address flash reads the device first**: its tables and the com-object table (backup,
  difference, and the link bits it sets in the table the device holds), where ETS reads object 3
  PID 13 and the load states at `$B6EC`, `$B6ED`.
- **The full download reads the program id first.** Busforge reads object 3 PID 13 and refuses a
  unit holding another application (`LOAD_PROC_CHECK_FAILED`), before anything is written; ETS reads
  no PID 13 in this capture. The capture ran on a unit holding this application; the declared form
  reads no load state, so the same sequence runs on a unit without it, which no capture shows.

What the comparisons prove (`tools/etsdiff.test.ts`, "Auro presence detector"): the wire sequence of
the full, the parameter and the group-address download, verify mode aside, and every byte ETS writes,
checked against ETS directly; the
tables and the com-object table built from links read off ETS's tables; the parameter bytes for a
configuration Busforge decoded from the 50 parameter bytes ETS wrote (the project behind the
captures is not available to the tests), so for them the test proves Busforge's decode and encode
agree on ETS's bytes.

How far the three are shown on the device is in [status.md](status.md); the full download there
has no wire capture of its own, and wrote bytes the device already held.

### The TheLuxa P300

The Theben TheLuxa P300, `M-0048_A-107E-12-5B58` (`DynamicTableManagement="true"`, `PreEts4Style`),
its ETS downloads captured in the same order: a full download, a partial download after one
parameter change ("Temperature calibration in 0.1 °C", `AS-4800` offset 19, 0 to 1), one after
linking the unlinked object 16 to a group address, and one that reverted both, each with ETS's own
log. ETS runs the declared full steps in their declared order, as on the Auro, but
declares the two table segments as one region, as on the Gira ([above](#ets-captured-system-7-downloads)).

| Declared (`full`, in this order) | What ETS sends, and Busforge with it |
| --- | --- |
| `Unload` 1, 2, 3 | PID 5 `04` each |
| `Load` 1, `AbsSegment` 1 (16384+511), `TaskSegment` 1, `LoadCompleted` 1 | the segment as long as the address table (a 4-entry table: 16384+9), its bytes, the task segment at 16384 |
| `Load` 2, `AbsSegment` 2 (16895+509), `TaskSegment` 2, `LoadCompleted` 2 | the rest of both segments directly behind it (16393+1011), the association table, the task segment at 16393 |
| `Load` 3, `AbsSegment` 3 at 1792+248 (RAM, a `<Mask>` that marks no byte) | declared, nothing written |
| `AbsSegment` 3 at 17404+500 (the com-object table's segment), at 18432+576 (`Access="255"`, `SegFlags="0"`) | declared, each written whole: the com-object table (117 entries, 471 bytes) and the application data behind it, the parameter segment |
| `TaskSegment` 3 (17894) | PID 5 `03 02 45E6 ...` |
| `TaskCtrl1` 3, `Address="17875" Count="1"` | PID 5 `03 04 45 D3 01 00 00 00 00 00`, answered LOADING; 17875 is `0x45D3`, inside the com-object table's segment behind the table |
| `LoadCompleted` 3, `Restart` | PID 5 `02`; `A_Restart` |

The image is 1090 bytes, not differential: `0x4000` and `0x4003-0x400F` (the address table without
the device's own address, though `AS-4000` declares no `<Mask>`, and the association table),
`0x43FC-0x45EF` and `0x4800-0x4A3F`. Busforge plans exactly these runs and writes them with ETS's
values (`tools/etsdiff.test.ts`, "Theben TheLuxa P300"). `AS-4800` offset 0 is `P-2228`, a download
marker (`Access="None"`, `$AA`): ETS writes `AA` in every download and the unit clears it to `00`
afterwards, so the full download reads that byte back without comparing it, and the parameter flash writes it with
every changed byte, as ETS does. The com-object table writes object 116's update flag in `0x80`
([device-memory-model.md](device-memory-model.md#the-com-object-table-l3)).

The parameter download is `Load` 3, the 338 parameter-covered bytes of `AS-4800`, `LoadCompleted` 3,
`A_Restart`; its log executes `AS-43FC` as `LdCtrlWriteMem` but its image holds nothing of it. The
group-address download unloads 1 and 2, re-declares the tables as one region (16384+11 and
16395+1009 for a 5-entry address table), writes them, then `Load` 3, the com-object table to its
471 bytes, `LoadCompleted` 3 and the restart: 489 bytes, no `Unload` 3, no `TaskCtrl1`. The revert runs
the same brackets with the old tables (485 bytes of tables) and carries the 338 parameter bytes in the
same LSM 3 bracket. Busforge runs the parameter flash (`planAbsoluteParFlash`, the changed byte and the
download marker), the group-address flash (`planSystem7GaFlash`) and the structural flash of the
revert, each pinned byte for byte against these captures.

Where Busforge departs from ETS, deliberately: as on the Auro ([above](#declared-order-system-7-downloads)), no verify mode, the load state
read after each of its own load-state writes, the device read first, and the program id read before
the full download. The full download reads back the whole com-object table segment, `0x45D3-0x45EF` behind the
table included, which ETS writes and which the device holds unchanged after the restart.

How far the three are shown on the device is in [status.md](status.md).

### The Meteodata 140 S, memory-mapped

The Theben Meteodata 140 S, `M-0048_A-140C-14-EB70` (MV-0701, BIM M112, `DynamicTableManagement="true"`,
`PreEts4Style`), its ETS downloads captured in the same order: a full download, a partial download
after one parameter change ("Temperature calibration in 0.1 °C", `P-2234`, `AS-4800` offset 4, 0 to
1), one after linking the unlinked object 23 to a group address, and one that reverted both, each with
ETS's own log. It is the TheLuxa's procedure on a memory-mapped mask: every load
control is the 11-byte memory write to `0x0104` (the LSM and event in the first byte, the property
form's fields behind a segment-id byte), the state is read from `0xB6EA + LSM - 1`, and properties are
only read.

| Declared (`full`, in this order) | What ETS sends, and Busforge with it |
| --- | --- |
| `Unload` 1, 2, 3 | `0x0104` `14 00 …`, `24 00 …`, `34 00 …` |
| `Load` 1, `AbsSegment` 1 (16384+513), `TaskSegment` 1, `LoadCompleted` 1 | the segment as long as the address table (20 entries: `13 00 00 40 00 00 29 F2 03 80 00`, 16384+41), its bytes, the task segment at 16384 |
| `Load` 2, `AbsSegment` 2 (16897+511), `TaskSegment` 2, `LoadCompleted` 2 | the rest of both segments directly behind it (16425+983), the association table, `AS-4000`'s two `<Data>` bytes `0x41FF-0x4200` (`00 00`), the task segment at 16425 |
| `Load` 3, `AbsSegment` 3 at 7168+432 (RAM: 342 bytes of `<Data>` and of an all-zero `<Mask>`) | declared, nothing written |
| `AbsSegment` 3 at 17408+958 (the com-object table's segment), 18432+1024 and 19456+1024 (`Access="255"`) | declared; the com-object table's segment whole (186 entries, 747 bytes, and the application data behind them), of the two parameter segments the bytes the `<Mask>` marks and every parameter-covered byte |
| `TaskSegment` 3 (18356) | `0x0104` `33 02 00 47 B4 …` |
| `TaskCtrl1` 3, `Address="18155" Count="1"` | `0x0104` `33 04 00 46 EB 01 00 00 00 00 00`, answered LOADING; 18155 is `0x46EB`, behind the com-object table in its segment |
| `LoadCompleted` 3, `Restart` | `0x0104` `32 00 …`; `A_Restart` |

The image is 1893 bytes, not differential by stamps. ETS reads every block of it before writing and
writes only the bytes that differ ("Giving up optimistice write after 36 of 36 mismatched bytes", group-address download, where
nothing matches): on a device that already holds the configuration its full download writes two bytes,
`0x4000` (the address table's count, which the unit resets when LSM 1 is declared) and the download
marker `0x4800`. Busforge plans exactly ETS's image with ETS's values and, reading and comparing as ETS
does, writes the same two bytes (`tools/etsdiff.test.ts`, "Theben Meteodata 140 S"; its group-address
download and revert likewise), reading the image back after the restart. ETS writes `0x41FF-0x4200`, non-FF `<Data>` of `AS-4000` behind the tables (past what the
address table can hold); the Gira and the TheLuxa have non-FF `<Data>` behind their tables too, and
ETS writes none of it: theirs lie inside what the tables can grow to, the Meteodata's past it
([R6](#the-rules-by-level)). Busforge writes such bytes by that rule in the full download; its group-address downloads leave them out. The com-object
table carries a configured object's update flag in `0x80`, as on the TheLuxa. `AS-4800` offset 0 is
the download marker `P-2228`, handled as on the TheLuxa.

The parameter download is `Load` 3, the parameter-covered bytes of `AS-4800` and `AS-4C00` (ETS reads
them and writes `0x4800 = AA` and `0x4804 = 01`), `LoadCompleted` 3, `A_Restart`. The group-address
download unloads 1 and 2, re-declares the tables as one region (16384+43 and 16427+981 for 21
entries), writes them, then `Load` 3, the com-object table to its 747 bytes, `LoadCompleted` 3 and the
restart: no `Unload` 3, no `TaskCtrl1`, nothing of `0x41FF-0x4200`. The revert runs the same brackets
with the old tables. Busforge's group-address flash plans exactly these images
(`planSystem7GaFlash`) and its parameter flash the two bytes ETS wrote (`planAbsoluteParFlash`;
ETS's logged image of the parameter download holds 607 bytes, its wire these two), over `0x0104`.
Its structural flash runs the revert's steps, and every byte it writes is in ETS's logged image of
the revert with ETS's value; the writes on the wire are not compared, since ETS leaves out what the
unit holds.

### The MDT BE-06001.02

The MDT Universal Interface 6-fold BE-06001.02, `M-0083_A-00B4-32-3919` (`DynamicTableManagement="false"`,
no `PreferPartialDownloadIfApplicationLoaded`, a module device), its ETS downloads captured in the
same order: a full download, a partial download after one parameter change ("Time for long keypress",
`AS-44C8` offset 4, 0.5 s to 0.6 s), one after linking the unlinked object 48 to a group address, and
one that reverted both, each with ETS's own log. ETS runs the declared full steps in their declared
order and declares the table segments as declared, as on the Auro.

| Declared (`full`, in this order) | What ETS sends, and Busforge with it |
| --- | --- |
| `Unload` 1, 2, 3 | PID 5 `04` each |
| `Load` 1, `AbsSegment` 1 (16384+513), `TaskSegment` 1, `LoadCompleted` 1 | the address table without the device's own address (`AS-4000`'s `<Mask>` leaves bytes 1-2 out), the task segment PID 5 `03 02 4000 01 0083 00B4 32` |
| `Load` 2, `AbsSegment` 2 (16897+511), `TaskSegment` 2, `LoadCompleted` 2 | the association table, the task segment at 16897 |
| `Load` 3, `AbsSegment` 3 at 1792+190 and at 1982+1 (RAM, `MemType="2"`; the second `SegType="1"`, a stack segment: PID 5 `03 01 07BE 0001 00 02 00 00`) | declared, nothing written |
| `AbsSegment` 3 at 17408+200, at 17608+372 | declared, each written whole: the com-object table's segment and the parameter segment |
| `TaskSegment` 3 (17408), `LoadCompleted` 3, `Restart` | PID 5 `03 02 4400 ...`; PID 5 `02`; `A_Restart` |

The image is 594 bytes, not differential: `0x4000`, `0x4003-0x400C`, `0x4201-0x420B`,
`0x4400-0x463B`. Busforge plans exactly these runs and writes them with ETS's values
(`tools/etsdiff.test.ts`, "MDT BE-06001.02"), the external inputs of logic 1 and 2 (objects 36, 39,
`UpdateFlag="Enabled"`) with config `0xD3` ([R13](#the-rules-by-level)). Before its first memory write
ETS reads device control (object 0 PID 14) and writes it back with `0x04` set: `05` in the full and the
parameter download, where the read shows the application stopped (`0x01`), `04` in the other two.

The parameter download is `Load` 3 without an unload or a declaration, 277 bytes of `AS-44C8`, the
image with gaps (its log executes both of LSM 3's data segments as `LdCtrlWriteMem`, its image holds
nothing of the com-object table), `LoadCompleted` 3, `A_Restart`. The group-address download unloads
1 and 2, writes the tables in their declared segments, then `Load` 3, the com-object table to its 49
entries (199 bytes, the segment's last byte not written), `LoadCompleted` 3 and the restart: 225
bytes. The revert runs the same brackets with the old tables and carries the same 277 bytes in
the same LSM 3 bracket; the tables shrink and leave their old bytes behind them
([below](#tables-shrink-their-old-bytes-stay)). Busforge's parameter flash writes the two changed
bytes in ETS's bracket, its group-address flash ETS's 225 bytes in ETS's steps, and its structural
flash runs the revert's steps and writes every byte the revert changes, with ETS's value. Before
each partial download ETS reads `$B6EC` and object 3 PID 13; Busforge reads the device and the
program id instead, the departures listed for the Auro ([above](#declared-order-system-7-downloads)).

How far the four are shown on the device is in [status.md](status.md).

## Which bytes ETS writes

Of a segment ETS does not always write every byte, and not always the same bytes: it depends on how
it loads the segment. One rule fits the images ETS's own log dumps for five applications (Gira
M-0008: full download twice, parameter, group-address and revert download; Auro M-0081_A-FE01, TheLuxa
P300 M-0048_A-107E and Meteodata 140 S M-0048_A-140C: full, parameter, group-address and revert
download, the Meteodata's table-segment `<Data>` given by [R6](#the-rules-by-level); ABB US/U 4.2
M-0002_A-A001: the full download onto a unit holding the application); what the tests
compare byte for byte and what by count is listed below. Each log has an
"Execute image" dump, `--` where the image holds nothing.

| Segment | How ETS loads it | What its image holds |
| --- | --- | --- |
| address, association or com-object table | in a full, group-address or revert download (a parameter download's image holds no table byte, though its log executes the com-object table's segment) | the table as long as it is built, and of that the bytes the segment's `<Mask>` marks (all, without a mask), never the address table's own individual address (bytes 1-2) |
| data segment, the com-object table's segment in a full download that loads it afresh | afresh: its load-state machine unloaded, `LdCtrlAbsSegment` executed | the bytes the `<Mask>` marks and every byte a parameter's memory covers; the whole segment without a mask; nothing where the mask marks no byte and no parameter covers one |
| data segment | into an application it leaves loaded: the log turns the `LdCtrlAbsSegment` into `LdCtrlWriteMem` ("Transformed from") | every byte a parameter's memory covers, and no other, whatever the `<Mask>` marks and where it declares none; nothing of a segment no parameter covers |

"A parameter's memory" means every parameter of the segment, active in the configuration or not,
union members included: ETS writes the bytes of inactive parameters too. A table's built length on
MV-0705 is its count byte's entries: for the com-object table 3 + 4 × count.

```
                 Gira AS-444E (Mask: all 256)          Auro AS-4200 (Mask: 0-48)
                 176 param. bytes   80 no parameter    48 param. bytes   3, 36: no parameter
full download    written            --                 written           written  (Auro: loaded afresh)
parameter dl     written            --                 written           --       (both: app. stays loaded)
(Gira: every download leaves the application loaded)
```

How the captures show it:

- **Gira, `AS-444E`.** Its `<Mask>` marks all 256 bytes, yet ETS's image of the revert shows `--` in
  every row from `0x44B0` to `0x454F`, 80 bytes. They are exactly the bytes no parameter's `<Memory>`
  covers; the other 176, inactive parameters included, are written. ETS never unloads this
  application's load-state machine 3, and its log turns all seven LSM 3 segments into
  `LdCtrlWriteMem`, in the full download as in every partial one.
- **Gira, the full download's image.** It logs "Differential Download: removed 785 identical bytes"
  and dumps the 37 it writes: 822 bytes, the same as the revert's image, which no stamp shortened. The
  parameter download logs "removed 414" and dumps 7: 421, the parameter bytes of the six data
  segments. The 80 bytes are in no image.
- **Gira, `AS-41E5`.** The com-object table counts 91 objects (the application declares 0 to 90),
  3 + 4 × 91 = 367 bytes of its 375-byte segment; every image ends at `0x4353`.
- **TheLuxa P300.** `AS-4000` declares no `<Mask>`, yet every image leaves out bytes 1-2 of the
  address table, as the Gira's and the Auro's masks do: the own address is left to the device
  whatever the mask says. The com-object table's segment `AS-43FC` (no mask) is written whole in the
  full download, which loads LSM 3 afresh: the table's 471 bytes and the 29 bytes of application data
  behind it, the `TaskCtrl1` block at `0x45D3` among them; the group-address download writes the
  table to its 471 bytes only. The RAM segment `AS-0700` declares a `<Mask>` of zeros and no parameter:
  declared, nothing written.
- **Meteodata 140 S.** The same rule on a memory-mapped mask: the tables to their built length
  without the own address, the com-object table's segment `AS-4400` (no mask) whole, of `AS-4800` and
  `AS-4C00` the masked and the parameter-covered bytes, nothing of the RAM segment `AS-1C00` (its
  `<Mask>` covers only its 342 bytes of `<Data>` and marks none). Besides, `AS-4000`'s non-FF
  `<Data>` bytes 511-512, past what the address table can hold, written in the full download only
  ([R6](#the-rules-by-level)).
- **Auro, `AS-4200`.** Its full download unloads load-state machine 3 and executes its
  `LdCtrlAbsSegment`: the image holds offsets 3 and 36, which no parameter covers and the mask marks.
  Its parameter download writes the segment as `LdCtrlWriteMem` and shows `--` at exactly those two
  offsets: "the mask plus the parameter bytes" is the rule's freshly loaded case.
- **ABB US/U 4.2, a full download onto a unit holding the application.** Its application declares
  `PreferPartialDownloadIfApplicationLoaded`, and ETS logs "Trying partial/differential download
  because of PreferPartialDownloadIfApplicationLoaded": both tables reloaded, LSM 3 neither unloaded
  nor declared, each of its segments executed as `LdCtrlWriteMem`. None of its segments declares a
  `<Mask>`. ETS's image is 229 bytes: the tables, the com-object table `AS-43FE` whole (123
  bytes), and of `AS-6D00` and `AS-6F00` exactly the bytes a parameter covers; nothing of the
  7790-byte code segment `AS-4600` or of `AS-6F10`, which no parameter covers. On the wire ETS reads
  the unit first and writes only the bytes that differ from it.

Busforge plans every System 7 full download by this rule (`etsWrittenRuns`, and `etsTableRuns` for
the tables, `packages/product/src/deviceflash.ts`); a parameter's memory in the com-object table's
segment and a mask gap inside the table stay refused where that segment is written afresh. The
group-address flash follows it too (`planSystem7GaFlash`: on the Gira its tables and com-object
table, the 405 bytes of ETS's image of its group-address download, the 401 of the revert's tables). `tools/etsdiff.test.ts` fails if it writes
a byte the image ETS logged does not hold: for the Gira its 822 bytes equal the revert's image, byte for byte,
contain the 37 bytes of both full downloads' images and number those 37 plus the 785 removed, and its
parameter bytes number the parameter download's 7 plus 414 removed (a count: the removed bytes'
addresses are not logged); for the Auro its 151 equal the full download's image, and the parameter
download's image is pinned byte for byte; for the TheLuxa its 1090 equal the full download's image
and its group-address flash the 489 bytes of that image, byte for byte; for the Meteodata its 1893
equal the full download's image and its group-address flash the 829 bytes of that image; for the ABB
on a loaded unit its image equals ETS's 229 bytes, and every byte ETS sent on the wire is in it with
ETS's value.

One limit. The rule rests on five applications; in every capture "loaded afresh" and "the
application stays in the device" coincide with the `LdCtrlAbsSegment` being executed or transformed,
so which of them ETS keys it on is not shown.

## Tables shrink, their old bytes stay

A System 7 group table sits at the start of a declared segment that is longer than the table, and
begins with its count byte; the device reads the table only as far as that count says. ETS writes a
table only as long as it is built, never the rest of its segment. So when a table shrinks, the bytes
of its old tail stay in the segment behind it, and nothing on the bus ever removes them.

The captures of the Auro presence detector `M-0081_A-FE01` show it end to end. Its address table
lives in `AS-4000` (47 bytes), its association table in `AS-402F` (45 bytes):

| Step | What ETS writes |
| --- | --- |
| Group-address download, a second address added to object 10 | the address table's count `04` at `0x4000` and 6 bytes of entries from `0x4003`; the association table, 7 bytes from `0x402F` (count `03`) |
| The revert | 4 bytes of entries from `0x4003` and 5 bytes of associations from `0x402F` (count `02`); the revert's "Execute image" in ETS's log shows `--` from `0x4007` and from `0x4034` |
| A full download | the same 4 bytes at `0x4003` and 5 at `0x402F`, nothing behind them |

After the revert the device holds the added address's two bytes at `0x4007-0x4008` and the
dropped association's two bytes at `0x4034-0x4035`, behind tables whose count bytes say 3 and 2. The
tables are identical to those before the link was added, but the segment stamps are not: the PID 27
stamp of objects 1 and 2 begins with the declared segment length (`0000002F`, `0000002D`) and ends in
a checksum that covers the whole declared segment, residues included, so both stamps change. A read
of the whole declared segments before ETS's group-address download and one after its revert differ
in exactly these 4 bytes and the two stamps. A full download clears neither, ETS's or Busforge's: both
write the tables to their length.

The Gira M-0008's captures show the same mechanism, with a twist: its association table sits
directly behind the address table, so it moves when the address table grows
([above](#ets-captured-system-7-downloads)). Its group-address download with one more link declares
LSM 1 two bytes longer and LSM 2 two bytes later and shorter, and writes a ten-entry association table
there; the revert declares the segments as before and writes the nine-entry table two bytes earlier,
so it ends four bytes before the old one did, and ETS's log of the revert dumps `--` from there on.
The last four bytes of the ten-entry table stay behind it, and object 2's stamp, whose leading word is
the declared segment length of each download, differs from the one before the group-address download
in its checksum alone. The TheLuxa P300's captures show it once more: after the revert the last three
bytes of the four-entry association table its group-address download wrote stay behind the restored
three-entry one, and object 2's stamp changes.

Busforge follows ETS here. Its group-address flash and full download write each table to its built
length and nothing beyond it, and read back exactly the runs they wrote, at the declared addresses;
the group-address flash also checks after the restart that the table references (PID 7) of objects
1 and 2 are the declared addresses. So a verified flash claims nothing about the bytes behind a
table. Busforge's group-address flash adding and removing the same link writes the tables exactly as
ETS's downloads do and leaves the same residues and the same stamps ([status.md](status.md)). A comparison of
whole declared segments, or of the PID 27 stamps, against a reference taken before a table grew shows
them as differences that the tables do not have: after a link is removed they are expected.

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
| System 7: update, read-on-init or communication set differently from the application (an override of the update bit `0x80` is not written, the config byte has no read-on-init bit, its communication bit follows the links), or any override where the full download writes the application's own table (memory-mapped, no `<ComObjectTable CodeSegment>`) | `COM_OBJECT_OVERRIDE_UNWRITABLE` |

The surgical parameter flashes keep the table the device holds. The System 7 group-address flash
keeps it too, but sets each object's communication bit from the links; a project that sets an
object's communication flag differently from the application is refused there as well. Its other
flags stay as the device holds them. A product replacement drops the old application's overrides with its other
configuration.

On hardware an override has been written only by a System 7 full download, onto a device that
already held that value. The System B paths (full
download, group-address flash) and the structural flash with an override are tested offline only.

## System B as the Theben MIX 2's captures show it

The Theben MIX 2 (`M-0048_A-493B-21-B471`, MV-07B0, `MergedProcedure`) declares one parameter segment of
2003 bytes (`LdCtrlRelSegment` LSM 4, Mode 1 Fill 0 for the full download, Mode 0 for the parameter
download) and two memory-control-block regions (object 4 PID 27, `0000066A 0032…` and, at element 2,
`00000169 0032…`); the rest comes from the master data's MV-07B0 load procedures. ETS's downloads of
its three products (HMG 6 T, JMG 4 T, RMG 8 T) and Busforge's plans, which `tools/etsdiff.test.ts`
("Theben MIX 2") pins against them:

| Download | Load controls, in order |
| --- | --- |
| full | `Unload` 5, 4, 3, 2, 1; `Load` 4, `AllocAbs` `030b 000007d3 01 00`, the two PID 27 elements; `Load`/alloc 3 (510 bytes), 1 and 2 at their tables' lengths; memory; PID 13 `0048493b21`; `LoadCompleted` 4, 3, 2, 1; PID 27 read of objects 1, 2, 3 and 4 (both elements in one read); the confirmed restart |
| parameter | `Unload` 4; `Load` 4, `AllocAbs` `…07d3 00 00` (no fill), the two PID 27 elements; the parameter bytes; PID 13; `LoadCompleted` 4; the PID 27 reads; the confirmed restart |
| group address | `Unload` 3, 2, 1; `Load`/alloc 3, 1, 2; the com-object table whole, both tables; `LoadCompleted` 3, 2, 1; the PID 27 reads; the confirmed restart. LSM 4 is not touched |

Three of these are rules for every System B application ([R9, R10, R11](#the-rules-by-level)), which
the captures of the Jung 400021SE, the GVS AMMA and the Theben DALI-Gateway show too:

- **The PEI program's unload (LSM 5) first in the full download.** The master data wraps it in
  `LdCtrlMapError`, so ETS ignores an error there; the MIX 2 answers it with its state, Unloaded.
- **The close at once.** After the last `LoadCompleted` the PID 27 reads the application declares
  (`LdCtrlLoadImageProp`, objects 1, 2, 3 and 4 with `Count="2"`, read as one request of two elements),
  then the restart on the same connection, within a second. The unit starts its application at
  `LoadCompleted`; a pause there lets it run and send its start-up telegrams before the restart.
- **The confirmed restart** (the application declares `IsSecureEnabled="true"`; the DALI-Gateway, which
  does not, gets the plain A_Restart), A_Restart type 1 with erase code 1 and channel 0 (`81 01 00`, ETS6.log
  `ConfirmedRestart_req`). The device answers A_Restart_Response, error 0 and the seconds it needs (1),
  and reboots. Busforge refuses an answer with an error code (`RESTART_REFUSED`) and takes an answer
  with error 0 as the restart's proof, as ETS does: ETS disconnects after it without probing the
  device. Without an answer it requires the device to be gone, as after the basic restart; a probe the
  interface does not confirm then proves no reboot and fails the step. The device's T_ACK proves the
  restart arrived: an MDT IP interface sends no confirmation (L_Data.con) for this frame while the
  device acknowledges and answers it, and ETS goes on without one; Busforge does the same.
- **An interface that drops its tunnels after a restart.** Whenever an MDT IP Interface/Router restarts,
  an MDT IP interface beside it stops serving its tunnels for 40 to 64 seconds and then drops them,
  the tunnel the download itself runs over included. Busforge's read-back after the restart opens its
  tunnel again until the interface answers (up to two minutes); a secured session refuses a tunnel
  that comes back under another individual address (`TUNNEL_ADDRESS_CHANGED`).

What Busforge does besides: it reads the load states back after its load-state writes; the full
download writes the parameter bytes ETS writes ([the rules](#the-rules-by-level)); after a restart the
device did not answer it probes the device into its reboot, and after every restart it reads the device
back on a new connection. ETS reads PID 7 before each segment. Reads aside, the wire of each download is
ETS's. Only on thelsing/OpenKNX firmware does the full
download settle for 8 s on a fresh connection before the restart instead of closing at once
(`SETTLE_BEFORE_RESTART`, [below](#the-flash-bracket-and-why-it-is-tight)).

ETS reverts a parameter change and a link change made together in one partial download with the
structural bracket (unload 4, 3, 2, 1, every object reallocated without fill, [Structural
flash](#structural-flash)). Busforge's structural flash of the revert runs ETS's bracket and writes
every byte of ETS's revert with its value, on each of the three products (`tools/etsdiff.test.ts`).

The images: the object-link tables are `BinaryValue` union members written with their enumeration's
bytes, inactive parameters only rejected branches place are left out (the application declares
`DownloadInvisibleParameters="None"`, [R14](#the-rules-by-level)), and the associations are in ETS's
order ([R8](#the-rules-by-level), [device-memory-model.md](device-memory-model.md)).

## Structural flash

A parameter change that alters the com-object table (a channel function with other objects, an
object enabled or disabled) would otherwise need a full download, which rewrites the whole parameter
image. The structural flash writes it the way ETS writes it in a partial download
([findings.md](findings.md) §28), and both flash routes run it when `comObjectTableChanges` is not
empty and the device's profile offers `structuralFlash`.

The rule is the family's ([R15](#the-rules-by-level)): one bracket set as ETS sends it, and one
restart. On System 7 both group tables are unloaded and declared as in the group-address flash
([R3, R5](#the-rules-by-level)), then load-state machine 3 is loaded without an unload or a
declaration and gets the com-object table to its counted entries and the parameter bytes that differ
from the device, then `LoadCompleted` 3, the closing steps and the restart
(`planAbsoluteStructuralFlash`). On System B it is the reallocating bracket below
(`planRelativeStructuralFlash`), closed like every System B download ([R10, R11](#the-rules-by-level)).

It is the **family's rule**, offered on every application whose full download Busforge can build (it
authors what the full download authors): ETS runs this bracket for a change of parameters and links on
both families, tested against its captures in `tools/etsdiff.test.ts` (the Jung 400021SE and the MDT
BE-02001.02, whose captures reshape the com-object table; the Auro presence detector `M-0081_A-FE01`,
the Gira Tastsensor 3 Komfort, the Theben TheLuxa P300, the Theben Meteodata 140 S, the Theben MIX 2,
the Theben DALI-Gateway KNX plus and the MDT BE-06001.02, whose captures revert a parameter change and a
link change in one download; on the property-mapped System 7 units the bytes written equal ETS's revert
exactly, on the Meteodata every byte has ETS's value and every byte ETS changed is written). The
thelsing/OpenKNX and GVS stacks stay off (`structuralFirmwareOff`, keyed on the firmware's
manufacturer), because the bracket rests on firmware behaviour they are shown not to share (keeping a
segment's bytes across a reallocation at the same address, the order of the writes on thelsing/OpenKNX,
the flash commit a persist-at-LoadCompleted device makes for every `LoadCompleted`); there a change of
the com-object set takes the full download (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD`). Of the parameter
segments the structural flash writes what the parameter flash writes. How far each offered application
is shown on the device is in [status.md](status.md).

```
System B (one bracket)                      System 7 (one bracket per LSM)
unload 4, 3, 2, 1, security object          unload 1, 2
load+alloc 4 (no fill), MCB of 4            load 1, declare, address table, task, completed 1
load+alloc 3, 1, 2 (no fill)                load 2, declare, association table, task, completed 2
write 4: owned bytes                        load 3 (no unload, no declaration)
write 3: bytes that differ                    com-object table to its counted entries
write 2, 1: whole                             parameter bytes that differ, completed 3
security object load                        closing steps (PID 27 reads)
stamp program id                            restart
load-completed 4, 3, 2, 1, assert loaded
closing steps (PID 27 reads)
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
  where they were (`writeSegmentOwned`; a moved segment is written whole). On System 7 the tables as
  the group-address flash writes them (to their built length, without the own address), the
  com-object table to its counted entries, of the parameter segments only the bytes that differ from
  the device.
- **What is verified.** After the restart: the parameter segment as the parameter flash checks it
  (on System 7 the restored template bytes too), the three tables and the security object whole,
  and every load-state machine the flash concerns LOADED again (on System B the application too).
- **Where it differs from ETS.** Of the parameter segments ETS writes every byte a parameter covers on a
  property-mapped mask; the structural flash writes fewer (only what differs from the device), never
  other ones. On a memory-mapped mask both read the unit first and write what differs.
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
   triggers another flash persist. On any other device the plan is the plain table-only
   bracket, and the `GA_FLASH_BROKE_APPLICATION` guard below is what keeps that
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

- **System B** (`planSystemBFullDownload`): implemented. Of the parameter segment the bytes ETS
  writes go over the bus, the rest is left to the allocation's fill (`fillAllocatedRuns`), and it is verified by the device's own segment CRC
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
  On a unit holding an application that declares `PreferPartialDownloadIfApplicationLoaded` (the
  ABB US/U 4.2), the partial form runs instead ([R1](#the-rules-by-level)): the tables reloaded,
  the application left loaded, of its data segments only the parameter-covered bytes, nothing of its
  code segment ([Which bytes ETS writes](#which-bytes-ets-writes)).
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
