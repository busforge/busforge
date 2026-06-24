# Device memory model: LSMs, masks, and what Busforge supports

A KNX device's commissioned state lives in several memory segments, each governed by
a **Load State Machine (LSM)**. Programming a device means driving the right LSM
through its load procedure and writing the segment. This note explains the segments,
which device generations use which parameter model, and exactly what Busforge can and
cannot do today, so nobody mistakes a partial capability for full coverage.

## The segments (LSMs)

| LSM | Segment | Holds |
| --- | --- | --- |
| **LSM1** | Address table | The group addresses the device answers to |
| **LSM2** | Association table | Links each group-address entry to a com-object |
| **LSM3** | Com-object table | Com-object descriptors and their flags |
| **LSM4** | Application / parameter segment | The **parameter memory image** (offsets, defaults, your values) |
| **LSM5** | Secondary application segment | Extra application code/data on some masks (full "par" load) |

Two largely independent axes:

- **Group communication** (LSM1/2/3) — which group addresses the device talks on.
- **Parameters** (LSM4, or a different model, see below) — how the device behaves.

You can reconfigure one without the other.

## Two parameter models

Not every device stores parameters in an LSM4 memory image. There are two families,
distinguishable by mask version:

| Model | Masks (seen here) | Parameters live in | Busforge support |
| --- | --- | --- | --- |
| **Relative segment** | MV-07B0, MV-0701 | An LSM4 `RelativeSegment`, allocator-addressed | **read + flash** (the proven path) |
| **Absolute segment** | MV-0705 | One or more `AbsoluteSegment`s at fixed EEPROM addresses | **read + build/verify + flash planned** (see below) |

In the reference installation, **8 of 34 devices** use the relative-segment model; the
other **26** (most push-button sensors, presence detectors) use the absolute-segment
model. The absolute-segment model was originally thought to be opaque "property based"
storage; it is not. These devices keep their parameters in fixed-address segments, and
the correct image is the manufacturer `<Data>` default (or a cleared parameter region
for `<Data>`-less segments) overlaid with the visibility-resolved active parameter set.
Busforge reads, builds, and byte-verifies these images against real hardware, and plans
a surgical flash for them; see `docs/mv0705-spike-findings.md`.

## Support matrix (honest)

| Capability | State | Proven on |
| --- | --- | --- |
| Read device descriptor / mask | yes | all non-secure devices |
| Read group tables (LSM1/2/3) | yes | 32 non-secure devices (read-back corpus) |
| **Group-address flashing** (LSM1/2 rebuilt, LSM3 written back unchanged) | yes | hardware-proven on MV-07B0 (1.1.x, 1.1.x) |
| Read parameter image (LSM4) | yes, memory-image devices only | the 8 LSM4 devices |
| **Parameter flashing** (LSM4 image) | yes, but only non-module, memory-image, non-secure | hardware-proven on **1.1.x** (one device) |
| **Module/channel** per-instance offsets (build + place + plan) | yes (offsets resolved both for imported projects and from scratch) | placement byte-verified vs read-back; flash planned, not yet confirmed on a clean re-flash (see below) |
| Read + build/verify parameter image for **absolute-segment** devices (MV-0705) | yes | 19/32 reachable devices byte-match the read-back corpus |
| **Parameter flashing** for MV-0705 | yes, by driving the device's declared load procedure | hardware-verified on M-0081 (1.1.x param applied + reverted, LSM3 reaching LOADED); surgical `par` download, see [load-procedures.md](load-procedures.md) |
| Com-object flags table (LSM3) authoring | **no** (flags-byte encoding unvalidated; kept from device) | |
| Full merged "par" procedures (LSM4+5) | **no** (minimal LSM4-only subset used) | |
| **KNX Secure** devices | **no** (opaque: descriptor MV-FFFF, no plain access) | 2 MDT IP interfaces |

The flash path's safety rails (mask check, segment backup, dry-run, post-flash
read-back-verify) apply to everything it does write. For how correctness vs stability
is verified, see [verification.md](verification.md).

## Is that all the models? Two axes, and the real gaps

"How many models are there" sounds like one question but is two. Conflating them is
what made the parameter work feel open-ended.

**Axis A: parameter memory layout** (how the image bytes are arranged). This is the
small, finite set the image builder cares about:

1. **Relative segment** (LSM4, allocator-addressed) - MV-07B0, MV-0701.
2. **Absolute segment** (fixed EEPROM address) - MV-0705.
3. **Module / channel placement** - not a separate storage class, a per-instance
   offset modifier on (1)/(2). The effective device offset of a module parameter is
   `its static offset in the ModuleDef + the per-instance value of the Memory@BaseOffset
   argument`. That per-instance base comes from one of two interchangeable sources:
   ETS pins it into the project 0.xml (`<ModuleInstance>` arguments) for an imported
   device, and for a from-scratch device (placed from the catalogue, no project) we
   re-run the application's `<Allocators>` to compute the identical value (counter =
   `Start + cumulative Allocates`, walked over the visibility-resolved active tree, a
   `<Repeat Count="k">` instantiating k copies). The allocator re-run was validated
   against the real Theben 493B devices: it reproduced all 67 of their 0.xml module
   instances exactly. Placement is byte-verified against the device read-back; the
   residual diff vs that particular read-back is dominated by project-device drift, so
   a clean ETS re-flash + re-read is the pending step before claiming module flash.
4. **Property / interface-object** - the genuine "property-based" model: parameters
   load via interface-object property writes, not a memory image.

**Axis B: load procedure** (how the transfer is driven and activated), orthogonal to
the layout. KNX devices carry a `LoadProcedureStyle`:

- **Data-driven** (System 7 / System B / IP, "merged"/product procedure): the procedure
  is shipped *as data* in the product XML as `LdCtrl...` load controls, selected by mask
  version. No per-device code, the XML is the procedure.
- **Hardcoded legacy** (BCU1 `DefaultProcedure`, BCU2 native): the procedure is fixed
  per mask version, not described in the product.

So "flashable" depends on both axes. The four layout models above describe the
parameter-image building, which is generic and XML-driven; but a device is only
end-to-end programmable if its load procedure (axis B) is also handled.

**Known gaps beyond the four layout models** (none require per-device hand-coding; all
are mask-version-keyed, generic capabilities still to add):

| Gap | What it is | Status |
| --- | --- | --- |
| **True property-based loading** | Some IP / System-B devices load parameters via interface-object property writes, not a memory image. Needs a generic `A_PropertyValue_Write` download path. This was the original "property-based" premise; MV-0705 turned out *not* to be it, but real property-loaders exist (IP interfaces/routers, cEMI servers). | not implemented |
| **Legacy System 1 / BCU1** | MV-001x devices, hardcoded `DefaultProcedure`, different memory map. One MV-0012 device is in the corpus. | config shown; flash procedure not implemented |
| **Full first-time commissioning** | A complete download also writes the com-object flag table (LSM3) and application code (LSM5). Busforge writes LSM4 (params) + LSM1/2 (group tables) and keeps LSM3 from the device. | out of scope by design; LSM3 authoring + LSM5 not done |
| **KNX Secure** | Data Secure + IP Secure devices read as descriptor MV-FFFF, no plain access. | not supported |
| **Non-TP media (RF, PL)** | Different addressing and services than the TP-over-IP path used today. | out of scope |

The reassuring part: even the legacy and property cases stay generic. They are selected
by mask version and (for modern devices) described by the product XML's `LdCtrl` load
controls, exactly the model ETS uses. There is no path here that needs a hand-written,
per-device programming recipe.

## Read-back corpus (kept out of git)

To develop against ground truth, every reachable device was read back from the bus
(read-only). The raw dumps live under `apps/server/data/readback/` and are
**gitignored on purpose**: they are the real installation's memory, including its
group addresses, the same class of personal data as a project's instance file. They
are not committed.

> **Incomplete data warning.** The first LSM1/2/3 table capture was **capped at 512
> bytes per table**, so larger tables are **truncated**. It is a first corpus, not a
> source of truth for full table contents. A full, count-based (uncapped) read is
> pending before that data is used as a reference.

What it established: of the parameter images, exactly **one** device (the MEAN WELL
PSU, 1.1.x) byte-matches fully today; the DALI gateway differs in its DCA-managed
bytes; the module devices differ in exactly their module-instance parameters; and the
two KNX Secure interfaces cannot be read at all.
