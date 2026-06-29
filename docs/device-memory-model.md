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
distinguished by the **segment structure the app declares** (a `RelativeSegment` vs an
`AbsoluteSegment`), not by the mask number. The masks below are simply the ones seen here;
the build picks the path by structure (`app.absoluteSegments` non-empty -> absolute), so a
low-numbered mask like MV-0701 still lands on the absolute path:

| Model | Masks (seen here) | Parameters live in | Busforge support |
| --- | --- | --- | --- |
| **Relative segment** | MV-07B0 | An LSM4 `RelativeSegment`, allocator-addressed | **read + flash** (the proven path) |
| **Absolute segment** | MV-0705, MV-0701 | One or more `AbsoluteSegment`s at fixed EEPROM addresses | **read + build/verify + flash planned** (see below) |

In the reference installation, **8 of 34 devices** use the relative-segment model; the
other **26** (most push-button sensors, presence detectors) use the absolute-segment
model. The absolute-segment model was originally thought to be opaque "property based"
storage; it is not. These devices keep their parameters in fixed-address segments, and
the correct image is the manufacturer `<Data>` default (or a cleared parameter region
for `<Data>`-less segments) overlaid with the visibility-resolved active parameter set.
Busforge reads, builds, and byte-verifies these images against real hardware, and plans
a surgical flash for them; see `docs/mv0705-spike-findings.md`.

### Relative-segment flash is surgical too (owned-byte overlay)

The relative (System B) flash does NOT write a from-scratch full image. A System B download
rewrites the whole LSM4 segment after reallocation, but Busforge supplies that image by
reading the live segment and overlaying ONLY the bytes it OWNS, carrying every other byte
over from the device unchanged. Ownership (`buildRelativeSegmentTarget`, owned mask):

- a plain top-level memory parameter is owned at its effective default. ETS writes every
  such default and the device holds it (the freshly ETS-flashed PSU M-0162 byte-matches the
  full image only with this default fallback; gating it off regressed 51 bytes);
- a `<Union>` member or a module-instance (`…_MI-…`) parameter is owned only when it is the
  ACTIVE branch (visibility-resolved). Overlapping union branches must not all be written;
- an `Access="None"` parameter that is NOT active is NOT owned. Its on-device value is
  computed by ETS, not derived from a static default. The Theben channel devices carry a
  928-bit `<Union>` of `Access="None"` "Objektlink" (com-object link) tables that ETS
  generates from the channel/link allocation; Busforge cannot reproduce those bytes, so it
  leaves them untouched rather than zeroing them with a full-image write.

Consequence and scope: re-configuring an already-commissioned device (changing parameters)
is safe, because the ETS-computed regions are preserved. Initial commissioning of a complex
module device from scratch still needs ETS to lay down the object-link allocation once. The
post-flash verify compares only owned bytes, since a reload can recompute the unowned ones.

Getting the owned set right is subtle: a top-level param whose memory a module instance now
occupies is a displaced channel variant and must NOT be owned (writing its default would
corrupt the channel). For the repeatable method that finds these, see
[`drift-forensics.md`](drift-forensics.md): trace every byte-level diff to its parameter,
classify it, and decide own-vs-preserve before flashing.

### ETS evaluates every matching `<when>`, not just the first

A `<choose ParamRefId="X">` selects branches by testing X against each `<when test="...">`.
It is tempting to read this as a switch (first match wins, then break), but ETS evaluates
**every** `<when>` whose test matches; the `default` branch fires only when none match. This
only differs from first-match when tests OVERLAP, which manufacturers use deliberately to
drive two independent placements from one selector. The Theben RMG 8 S contact block is the
canonical case: one choose on the channel-function param places the contact-type field (bits
0-1) under whens `0 1 3`/`2 4` AND a union member (bits 2-3) under whens `0 1`/`2 3 4`, so
every value matches exactly two whens and both fields get written. First-match left the union
bits unwritten; the device read-back disproved it (channel-function 0 -> union default 2,
channel-function 2 -> union default 0). The resolver (`config.ts` `selectWhens`) and the
module allocator (`modules.ts`) both walk all matching whens so the config view, the image
build, and the from-scratch instance set stay consistent with ETS.

A consequence for the surgical image: an active branch can now reach a member of the wide
`Access="None"` "Objektlink" union (the per-channel link tables ETS computes, hundreds of
bits). Those are never authored from a static default, so the relative build refuses to own
any parameter the integer codec cannot represent (> 6 bytes wide) and preserves the device
bytes. Small `Access="None"` members that DO carry a real default (e.g. a 2-bit hidden
behaviour setting) are still owned, because ETS writes their default like any other.

### `<Assign>` targets are written, even when placed only in an inactive branch

An `<Assign TargetParamRefRef="T" SourceParamRefRef="S">` sets parameter T's value to S's.
ETS writes T's memory with that value. A common manufacturer pattern assigns a hidden
`Access="None"` parameter from a visible one in the ACTIVE branch and places T's own
`<ParameterRef>` only in a different (inactive) branch, e.g. Steinel M-0083:

```
<choose ParamRefId="P-38">
  <when test="0"> place P-1; <Assign Target="P-26" Source="P-1"/> </when>   (active: P-38=0)
  <when test="1"> ... place P-26 ... </when>                                (inactive)
</choose>
```

The image set (`imageValues`) is built by visiting reached `<ParameterRef>` nodes, so an
assigned-but-not-placed target would be missed and its byte left at the default. It is
written by ETS, so `buildDeviceConfig` records each `<Assign>` target's value in `imageValues`
directly (non-memory Merker targets have no offset and are ignored by the image build).
Hardware-confirmed on 1.1.56: `P-26` (SendFallingOnInit) assigned from `P-1`
(SendRisingOnInit) and written to bit 4.

One exception keeps the union-overlap invariant: a `<Union>`-member assign target is NOT
recorded. Union branches share one region and the image build owns a union byte only for the
actively-placed branch; injecting an assigned alternative would let two members claim the
same byte (the relative builder iterates refs unordered). The active branch's own placement
still writes it. M-0083 has ten such union-member assigns, all left to their active branch.

## Support matrix (honest)

| Capability | State | Proven on |
| --- | --- | --- |
| Read device descriptor / mask | yes | all non-secure devices |
| Read group tables (LSM1/2/3) | yes | 32 non-secure devices (read-back corpus) |
| **Group-address flashing** (LSM1/2 rebuilt, LSM3 written back unchanged) | yes, incl. re-point and **adding/removing** GAs up to the device's reserved capacity | hardware-proven on MV-07B0 (1.1.x, 1.1.x) and MV-0705 (1.1.x: re-point + adding a GA, byte-verified). For System 7 the table sizes are fixed-reserved; growth is bounded by `<AddressTable>`/`<AssociationTable>` `MaxEntries` (e.g. 22 on M-0081), refused beyond it. System B reallocates via `allocSegment`. |
| Read parameter image (LSM4) | yes, memory-image devices only | the 8 LSM4 devices |
| **Parameter flashing** (LSM4 image) | yes, surgical owned-byte overlay (module + non-module, memory-image, non-secure); preserves ETS-computed regions | hardware-proven on **1.1.x** (no-op, 0 diff) and **1.1.x** (Theben HMG: a module-instance param change applied + restored, byte-checked) |
| **Module/channel** per-instance offsets (build + place + flash) | yes (offsets resolved both for imported projects and from scratch), **hardware-verified** | build byte-matches the device on 3/5 Theben HMG (1.1.x = 0 owned diffs; 1.1.x/1.1.x differ only in project-device drift, confirmed by sibling consistency); a module-param change + restore was byte-checked on **1.1.x** (relative) and **1.1.56** (M-0083, MV-0705 absolute - the resolved module offset placed correctly on hardware) |
| Read + build/verify parameter image for **absolute-segment** devices (MV-0705) | yes | part of the corpus sweep below |
| **Owned-byte image match across the corpus** (`tools/verify-images.ts`, surgical owned scope) | yes | **28/32 reachable devices** byte-match on owned bytes (2 KNX-Secure skipped). Remaining 4 are not modelling gaps. The MV-0701 device (1.1.x, M-0048 A-140C) is built correctly by the generic absolute path (structure-detected, not mask-gated): its only owned diff is the internal download-recognition marker P-2228 ("Wert $AA, Downloaderkennung", Access="None", default 0xAA; the device reads 0), and its second segment (AS-4C00) is unused erased EEPROM (0xFF) that the surgical flash leaves untouched. The other 3 are single-byte project-vs-device drifts where OUR build is correct and the device is stale (1.1.x, 1.1.x, 1.1.x). Both union-placement cases are fixed: the relative module-internal union and the absolute assign-target write (1.1.56). See "ETS evaluates every matching when" below and [`drift-forensics.md`](drift-forensics.md) |
| **Parameter flashing** for MV-0705 | yes, by driving the device's declared load procedure | hardware-verified on M-0081, M-0008, M-0048, M-008E and M-0083 (1.1.56, module param): each a real param change applied + restored, byte-checked; surgical `par` download, see [load-procedures.md](load-procedures.md). M-008E self-stamps `AS-4B00[0:2]` on download (our build over-claims those 2 bytes). |
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

1. **Relative segment** (LSM4, allocator-addressed) - MV-07B0.
2. **Absolute segment** (fixed EEPROM address) - MV-0705, MV-0701. Chosen by the app's
   segment structure (`AbsoluteSegment` present), not the mask number.
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
   instances exactly. Placement is **hardware-verified**: with the boundary-aware read
   (see "Reading device memory") the Theben HMG devices read full-length and the build
   byte-matches the device on 3 of 5 (0 owned diffs), the other 2 differing only in
   project-device drift (confirmed by sibling consistency). A module-instance param change
   was flashed and restored, byte-checked, on both a relative device and the one
   MV-0705 module device (M-0083, 1.1.56), so the resolved offset is correct on hardware.
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

## Com-object table (L3) format, reverse-engineered (MV-0705)

Toward authoring the com-object table (the documented gap: today L3 is kept from the device).
Read-only investigation across **all five MV-0705 families on the house bus** (M-0008,
M-0048, M-0081, M-008E, M-0083, 24 devices) established the model:

- L3 lives at the app program's `<ComObjectTable CodeSegment=…>` fixed absolute address (e.g.
  `AS-405C` = `0x405C`, 91 B for M-0081). It is **not** behind the object-3 table pointer:
  `tableAddr(3)` (PID 7) returns `0` on MV-0705, unlike System B.
- Layout: a **3-byte header** (`[count:1][ramEnd:2 BE]`), then one **4-byte entry per com-object**:
  `[dataPtr:2 BE][config:1][type:1]`.
  - `dataPtr` points into the `0x07xx` RAM value segment; `type` is the KNX size enum
    (`0x00`=1 bit, `0x03`=4 bit, `0x07`=1 byte, `0x08`=2 bytes, …).
  - `config` byte: bits 0-1 = priority, `0x04` = object has a linked group address,
    `0x10` = write, `0x40` = transmit, `0x80` = **unconfigured marker** (the manufacturer template's
    "not yet configured" bit, which ETS clears when it configures an object). The `0x08` bit was
    earlier assumed to be "read" but is NOT (see the residual notes below: it is set for write-disabled
    transmit-only/output objects); the exact read/output bit layout is still being pinned down.

### The build model: manufacturer template + per-device overlay

The decisive finding: the app program's `<ComObjectTable>` `AbsoluteSegment` carries a base64
**`<Data>` blob** that is the manufacturer's complete static image of L3 (header + every entry,
including `dataPtr`, `type`, sizes, and a template `config` byte with `0x80` set). ETS writes that
image, then **overlays only the dynamic state** onto each entry. So the build is:

1. Start from the segment `<Data>` blob (truth for header, `dataPtr`, sizes, and inactive entries).
2. For each entry, overlay the `config` byte:
   - `0x04` (linked) := the object has a GA in the device's group/association table.
   - **Configured (active) objects**: `config = priority | linked | read | write | transmit` from the
     **resolved** com-object flags (`ComObject` base overlaid with the active `ComObjectRef`); the
     `0x80` marker drops; the `type` byte is rewritten from the resolved object size.
   - **Unconfigured objects**: keep the template entry verbatim, only clear the linked bit.

This is robust by construction (the manufacturer image is the base; we change only what ETS changes)
rather than rebuilding every byte from first principles. The active set + resolved flags come from
`buildDeviceConfig().imageComObjects` (the com-object analog of `imageValues`: every com-object
reached in the active dynamic tree, incl. hidden Access="None" blocks and per-instance module
objects, keyed by resolved number).

### Build + byte-match status (Phase 2A, offline, read-only)

Offline builder vs live device L3, all 24 MV-0705 devices:

- **18 / 24 byte-match exactly**, including **all 12 M-0081** and one M-0008.
- The remaining 6 differ only in the **config byte** (and one type byte) of a small, bounded set of
  objects. Root causes (corrected after a clean re-flash of 1.1.x, see below):
  - **The config-byte BIT LAYOUT is incomplete / partly wrong.** Our builder used
    `0x08 = read, 0x10 = write, 0x40 = transmit`. Clean ground truth from the freshly re-flashed
    1.1.x shows that is wrong: the two active flag combos present map as
    `r0 w0 c1 t1 -> 0x08|0x40` and `r0 w1 c1 t1 -> 0x10|0x40`. So `0x10 = write`, but `0x08` is **not
    read**: it is set for a **write-disabled (transmit-only / output) object**, regardless of the
    ReadFlag. Our builder emits neither bit for such objects, so e.g. M-0008 obj 64 (a transmit-only
    output) comes out `0x40` instead of `0x48`. M-0081 never had this flag combo, which is exactly why
    all 12 byte-match while obj 64 (×7 M-0008) and several others do not. **Fix needs the full bit
    layout, which needs more flag-combo samples** (clean re-flashed devices, especially M-008E whose
    objects exercise read-enabled and other combos 1.1.x lacks).
  - **Large/special objects** (M-0048 obj 116 "Software version", 14 B): the device leaves it
    **unconfigured** (`0x80` kept, template type) even though it is reached and its two sibling
    objects (114/115) one line away in the *same* container *are* configured. So the predicate is a
    property of the object, not its dynamic placement. **Not a simple size rule**: a scan found
    configured objects of 3 B (M-0048 obj 0), 6 B and 8 B (M-008E obj 0/109), so only obj 116 at 14 B
    is unconfigured. Likely threshold "> 8 B / string DPT" (too large for the standard RAM comms
    buffer), but that needs more samples to pin down.
  - **Module objects** (M-0083 obj 36/39, M-008E obj 13 + obj 170-178): per-instance module
    com-objects. The linked bit (`0x04`) on module objects does **not** come from the association
    table the way it does for normal objects: 1.1.x's L3 marks objects 170-178 linked, yet its
    association table has only 11 entries (none of them). So module objects carry a linked/active bit
    from a separate mechanism still to be modelled.

  **CORRECTION (do not trust the earlier "obj 64 is drift" claim in git history).** An earlier pass
  called obj 64 project-vs-device drift after reading param P-2387 as `1`. That used **LSB-first** bit
  extraction; the codec is **MSB-first** (`shift = 8 - bit - sizeInBit`, image.ts). With the correct
  ordering P-2387 = `0`, matching the project. A full ETS "download all" of 1.1.x then left obj 64
  unchanged, **disproving drift**. obj 64 is a genuine build bug (the bit-layout above), not drift.
  The clean-re-flash method is still the right gate (it disambiguates bug vs drift AND yields clean
  flag-combo samples to finish the bit layout); the conclusion for obj 64 specifically was wrong.

So the **format and the build model (template + per-device overlay) are proven and robust**, and 18/24
devices byte-match. What remains is three bounded, well-characterized reverse-engineering items: the
**config-byte bit layout** (chiefly the `0x08` output bit, needs more flag-combo samples), the
**"configured" predicate** for large/special objects, and the **module linked/active bit**. Each
needs real samples, not a heuristic. Until the builder byte-matches **every** device, L3 stays
**kept-from-device** (device-support.md "Known gaps") and is **not** authored/flashed: a wrong
com-object flag breaks the object's communication, so the byte-match gate is mandatory.

## Reading device memory: chunking and read boundaries

`KnxDevice.memRead` reads a segment in chunks (12 bytes by default). Some M112 devices
have **internal read boundaries**: they refuse any single `MemoryRead` that spans the
boundary, answering with an empty data response (each byte is individually readable; only
a request that straddles the line is refused). Confirmed on the house installation:
M-0048 refuses reads crossing `0x4008`-`0x4009`, and M-0008 has a
boundary inside its `0x4000` segment.

`memRead` therefore places bytes **by address** and, on a short/empty chunk response,
shrinks the request until it fits within a boundary and advances only by what was actually
returned. (The earlier loop concatenated chunk responses and advanced by the requested
length regardless, so a refused chunk produced a buffer that was both short and
**misaligned** - silently corrupting read-back of any segment crossing such a boundary.
It stayed hidden because the only fully-verified device, M-0081, never crosses one, and the
surgical flash targets in this house happen not to either; it is a latent-correctness fix.)
`memWrite` uses the same fixed-chunk loop and is **not** boundary-aware, but its read-back
verify now uses the corrected `memRead`, so a write that crossed a boundary would fail loud
(verify mismatch) rather than corrupt silently. No flash target here crosses a boundary, so
this path is untested on hardware and left unchanged.

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
