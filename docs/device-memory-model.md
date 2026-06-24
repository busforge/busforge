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
| Parameter flashing for **module/channel** devices | **no** (per-instance memory offsets unresolved) | the differing bytes are captured for this work |
| Read + build/verify parameter image for **absolute-segment** devices (MV-0705) | yes | 19/32 reachable devices byte-match the read-back corpus |
| **Parameter flashing** for MV-0705 | planned, not on-bus yet | surgical plan proven safe+convergent offline on 71 segments; bus exec needs hardware sign-off |
| Com-object flags table (LSM3) authoring | **no** (flags-byte encoding unvalidated; kept from device) | |
| Full merged "par" procedures (LSM4+5) | **no** (minimal LSM4-only subset used) | |
| **KNX Secure** devices | **no** (opaque: descriptor MV-FFFF, no plain access) | 2 MDT IP interfaces |

The flash path's safety rails (mask check, segment backup, dry-run, post-flash
read-back-verify) apply to everything it does write. For how correctness vs stability
is verified, see [verification.md](verification.md).

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
