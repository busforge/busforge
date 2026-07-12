# Device support

Which KNX devices Busforge can read, program, and verify, and which it deliberately refuses.

The guiding principle is honesty over coverage: a device whose memory model we have not
implemented is **explicitly refused**, never silently routed into a path that fabricates a
result. Whenever you see a ❌ below, the corresponding operation throws a coded error
(`DEVICE_FAMILY_UNSUPPORTED`, `DEVICE_READBACK_UNSUPPORTED`, `GROUP_TABLE_UNREADABLE`) instead
of pretending to succeed.

## How a device is classified

Every KNX device carries a **mask version** (read off the bus via the device descriptor, and
present in the product XML as `MaskVersion`). The mask version is the single identity stamp,
and it projects onto three derived properties:

- **Medium** — twisted pair (TP), powerline (PL), radio frequency (RF), or IP. This only
  changes the transport.
- **System family** — System 1/2/300/7/B, or a non-application device (coupler, interface, IR
  decoder, media coupler, RF-only).
- **Memory model** — how parameters and group tables are laid out in the device, and therefore
  how we read and program it. The family fixes this essentially 1:1.

The two axes are **not** a free cross-product: the mask version is the primary key, and family
fixes the memory model. So this is one list keyed by mask, with the derived columns below.

The registry lives in [`packages/product/src/masks.ts`](../packages/product/src/masks.ts)
(`MASKS`, `maskInfo()`). The strategy that dispatches on the memory model lives in
[`apps/server/src/deviceprofile.ts`](../apps/server/src/deviceprofile.ts) (`classify()` →
`SystemBProfile` / `System7Profile` / `UnsupportedProfile`). Source for the mask data: the KNX
Association "Mask Versions" article and the Calimero `DeviceDescriptor` DD0 enum.

## What maps to what

Busforge implements two memory models:

| Memory model | Family | Profile | Status |
|---|---|---|---|
| `relative` | System B | `SystemBProfile` | Read + flash (params and group addresses). Hardware-proven on TP. |
| `absolute` | System 7 (BIM M112) | `System7Profile` | Read + flash (params and group addresses). Hardware-proven on TP (M-0081, 1.1.x): GA flash verified **end-to-end through the production server endpoint** (`POST /api/projects/:id/devices/:deviceId/flash-ga`, IP connection): dry-run identity (0 diff), real **add-link (table growth 24→28 B)** with the endpoint's own read-back `verified:true`, an independent bus read confirming the new GA, then revert, with the device byte-identical to the start. Growth is bounded by the device's declared `<AddressTable>`/`<AssociationTable>` `MaxEntries`; beyond capacity is refused. **Param flash** likewise verified e2e through the production endpoint (`POST .../flash`, LoadProcedure with restart) on M-0081 1.1.x: dry-run identity (0 diff), real 1-byte change with `verified:true`, an independent dry-run proving the device held the changed byte, then revert to a 0-diff state. |

Everything else resolves to `UnsupportedProfile`: the family is recognised (so we can name it
and say "not yet"), but every operation throws.

A ✅ means the memory model is implemented. **The ✅ does not by itself mean "verified on that
medium."** Hardware verification to date is on **twisted-pair (TP)** only, for System B and
System 7. The PL, RF (`MV-2705`, `MV-27B0`, `MV-17B0`) and IP (`MV-5705`, `MV-57B0`) rows share
the exact same codec and load procedure, so they read ✅, but they have **not** been exercised on
that medium. Treat a non-TP ✅ as "should work, code-shared, unproven on the wire" and read one
back before trusting it. (This is the same convention parameter flash already used.)

## The full matrix

<!-- Mirrors packages/product/src/masks.ts (MASKS). Kept honest by apps/server/test/device-support-doc.test.ts,
     which reconstructs every row from the registry and fails if this table drifts. -->


| Mask | Medium | Family | Memory model | Read-back | Flash params | Flash GA |
|---|---|---|---|---|---|---|
| `MV-0001` | TP | Dummy | none | ❌ | ❌ | ❌ |
| `MV-0010` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0011` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0012` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0013` | TP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-0020` | TP | System 2 (BCU2) | bcu2 | ❌ | ❌ | ❌ |
| `MV-0021` | TP | System 2 (BCU2) | bcu2 | ❌ | ❌ | ❌ |
| `MV-0025` | TP | System 2 (BCU2) | bcu2 | ❌ | ❌ | ❌ |
| `MV-0300` | TP | System 300 | system300 | ❌ | ❌ | ❌ |
| `MV-0310` | TP | Interface | none | ❌ | ❌ | ❌ |
| `MV-0311` | TP | Interface | none | ❌ | ❌ | ❌ |
| `MV-0700` | TP | System 7 (M112) | absolute | ✅ params + links | ✅ | ✅ |
| `MV-0701` | TP | System 7 (M112) | absolute | ✅ params + links | ✅ | ✅ |
| `MV-0705` | TP | System 7 (M112) | absolute | ✅ params + links | ✅ | ✅ |
| `MV-07B0` | TP | System B | relative | ✅ params + links | ✅ | ✅ |
| `MV-0810` | TP | IR decoder | none | ❌ | ❌ | ❌ |
| `MV-0811` | TP | IR decoder | none | ❌ | ❌ | ❌ |
| `MV-0900` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0910` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0911` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0912` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-091A` | TP | Coupler | none | ❌ | ❌ | ❌ |
| `MV-0AFD` | TP | Unknown | none | ❌ | ❌ | ❌ |
| `MV-0AFE` | TP | Unknown | none | ❌ | ❌ | ❌ |
| `MV-1011` | PL | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-1012` | PL | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-1013` | PL | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-1310` | PL | Interface | none | ❌ | ❌ | ❌ |
| `MV-1311` | PL | Interface | none | ❌ | ❌ | ❌ |
| `MV-17B0` | PL | System B | relative | ✅ params + links | ✅ | ✅ |
| `MV-1900` | PL | Media coupler | none | ❌ | ❌ | ❌ |
| `MV-2010` | RF | RF-only | none | ❌ | ❌ | ❌ |
| `MV-2110` | RF | RF-only | none | ❌ | ❌ | ❌ |
| `MV-2311` | RF | Interface | none | ❌ | ❌ | ❌ |
| `MV-2705` | RF | System 7 (M112) | absolute | ✅ params + links | ✅ | ✅ |
| `MV-27B0` | RF | System B | relative | ✅ params + links | ✅ | ✅ |
| `MV-2920` | RF | Media coupler | none | ❌ | ❌ | ❌ |
| `MV-3012` | IP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-4012` | IP | System 1 (BCU1) | bcu1 | ❌ | ❌ | ❌ |
| `MV-5705` | IP | System 7 (M112) | absolute | ✅ params + links | ✅ | ✅ |
| `MV-57B0` | IP | System B | relative | ✅ params + links | ✅ | ✅ |

## Known gaps to close next

- **Com-object table (L3): two paths, and the difference matters.**
  - The **full download** (first-time commissioning, System B) **AUTHORS** the com-object table
    from the application model, so a virgin device can be brought up with no ETS. The layout was
    read out of the firmware that consumes it (thelsing/knx) and cross-checked against Kaenx; it is
    byte-verified on real hardware against the OpenKNX AB-PRE (the device reads L3 back
    byte-identical to what Busforge built). See [`comobjbuild.ts`](../packages/product/src/comobjbuild.ts)
    and [openknx.md](openknx.md). Proven at the KNX layer end to end; whether the device's
    application then *runs* after a Busforge-only download is not yet demonstrated (see openknx.md).
  - The **surgical parameter flash** (re-configuring an already-programmed device) still KEEPS the
    device's L3 unchanged: it re-points parameters and group addresses, not the object set. A
    parameter change that, in ETS, would change a com-object's flags or the *set* of active
    com-objects (e.g. enabling a channel that adds/removes objects) therefore cannot be expressed
    by re-pointing alone. **Both** the parameter flash and the group-address flash **refuse** such
    a change with `COM_OBJECT_TABLE_STALE` and name the objects that would have gone stale, rather
    than write parameters over an L3 that no longer matches them. (To make that change, do a full
    download, which rewrites L3.) The GA flash is gated for a second reason: its association table
    numbers com-objects from the live configuration, so an association onto an object the device's
    table does not configure would be a link to nothing, and the verify (which only re-reads the
    tables we wrote) would still report success. See [`comobjtable.ts`](../packages/product/src/comobjtable.ts).
  - The staleness gate compares the com-object table implied by the **programmed baseline**
    (`device_param_base`, i.e. the configuration the device was last programmed with, hence the
    one its L3 was compiled for) against the one implied by the configuration being flashed. It
    deliberately does NOT compare against the device's own parameter image: the parameters that
    decide a channel's existence frequently have no memory offset at all (the Theben 493B's
    channel-active parameter is one), so they are unobservable on the bus and a device-image
    detector would be blind to exactly the change that matters.
  - The read-back keeps the baseline honest from the other side: it re-baselines only refs the
    device's image actually encodes, so an unflashed edit to an unobservable parameter cannot
    launder itself into the "programmed" baseline.
- **System 1 / System 2 (BCU1/BCU2)** appear in real projects (e.g. an `MV-0012` device in the
  house project). They are recognised and refused; implementing them means the classic
  fixed-EEPROM address/association/com-object/parameter model, which is a separate effort.
- Non-application devices (couplers, interfaces, media couplers) are out of scope for parameter
  commissioning by design.
