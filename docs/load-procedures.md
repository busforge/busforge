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
| **MergedProcedure** | `<LoadProcedure MergeId="n">` fragments merged into the management model's base at merge points, selected per operation by a step's `AppliesTo` (`full`/`par`) | the base is model knowledge (System B); the proven relative path embodies the `par` base, parameterized by the fragments |
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
| **executed** | `Load`, `LoadCompleted`, `Restart`, `AbsSegment`, `RelSegment` (mode 0 only, any fill value), `WriteAbsMem`/`WriteRelMem` (superseded by the strictly narrower surgical write), relative: `WriteProp` **to PID 27** on object 4 (the declared memory-control-block regions, written after the allocation) | performed by the planner/executor or the proven base bracket |
| **executed (pre-flight)** | `CompareProp` with inline data | read the declared property (hardware type, application id) and compare before any write; a mismatch aborts with `LOAD_PROC_CHECK_FAILED`. This is a check ETS runs that was previously skipped silently |
| **caller** | `Connect`, `Disconnect` | the session owns the lifecycle |
| **skipped (documented)** | absolute: `Unload`, `TaskSegment`, `TaskCtrl1` (full-download erase/allocation). relative: `LoadImageProp` **to PID 27 only** (ETS 6 sends nothing for it) | deliberately not executed, each with hardware or capture evidence |
| **blocked, refuse** | everything else: unknown verbs, `LoadImageProp` on absolute devices, `WriteProp` to any other PID, allocation variants (`RelSegment` mode ≠ 0), element-addressed `CompareProp`, and any `Load`/`Unload`/`RelSegment`/`WriteRelMem` on the relative path addressed to an LSM other than 4 | unmodeled; refusing beats a silent partial recipe |

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
write for `LoadImageProp`; it reads the device's CRCs back afterwards. No evidence exists for
absolute devices, so both verbs block on them.

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

## Coverage across the catalogue

Surveyed from the real catalogue (`parseLoadProcedures` plus the coverage test in
`packages/product/test/loadproc.test.ts`). The step policy above dispositions every
ProductProcedure and MergedProcedure in the corpus except two classes, both refused:

- **Devices whose procedure declares uncomputable load-image stamps.** One absolute-segment
  sensor family (`M-0008`) declares three `LdCtrlLoadImageProp` load-image/MCB stamps the engine
  cannot compute, so the coverage guard throws `LOAD_STEP_UNSUPPORTED` rather than run a partial
  recipe. That family has no full-download path either, so `par` would have been its only
  writable operation.
- **DefaultProcedure devices** (legacy BCU1/BCU2, nothing in the XML), refused as the explicit
  gap named in the styles table above.

Being dispositioned is not a hardware claim: which application programs have actually been
flashed, and how far, is in [status.md](status.md).

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
  download completes it (see the roadmap entry on recovering an interrupted flash).
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
   reporting `verified: true`. Only a degradation is an error, so a device whose application
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
download's own `full` steps (a check declared `AppliesTo="full"` would otherwise be missed).
A match means the device already holds this application, an all-zero read means a virgin
device, and a **different** non-zero application is refused, so a full download never lands
the wrong application's image on a device.

Commissioning (address assignment, what a first-time download has to get right, and the
device-specific traps) is in [commissioning.md](commissioning.md).
