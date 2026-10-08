# Device support

Which KNX devices Busforge can read, program, and verify, and which it deliberately refuses.

The guiding principle is honesty over coverage: a device whose memory model we have not
implemented is **explicitly refused**, never silently routed into a path that fabricates a
result. Whenever you see a ❌ below, the corresponding operation throws a coded error
(`DEVICE_FAMILY_UNSUPPORTED`, `DEVICE_READBACK_UNSUPPORTED`, `GROUP_TABLE_UNREADABLE`) instead
of pretending to succeed. (`GROUP_TABLE_UNREADABLE` is a different case: it is raised when a
readable device's group-table header is implausible, not when a family is unsupported.)

This page answers "how is a device classified, and is its memory model implemented". It does
**not** carry verification claims. How far each capability and each real product is actually
proven on hardware is in [status.md](status.md).

## How a device is classified

Every KNX device carries a **mask version** (read off the bus via the device descriptor, and
present in the product XML as `MaskVersion`). The mask version is the single identity stamp,
and it projects onto three derived properties:

- **Medium**: twisted pair (TP), powerline (PL), radio frequency (RF), or IP. This only
  changes the transport.
- **System family**: System 1/2/300/7/B, or a non-application device (coupler, interface, IR
  decoder, media coupler, RF-only).
- **Memory model**: how parameters and group tables are laid out in the device, and therefore
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

| Memory model | Family | Profile | Implemented |
|---|---|---|---|
| `relative` | System B | `SystemBProfile` | Read-back, parameter flash, group-address flash, full download. Proof state: [status.md](status.md). |
| `absolute` | System 7 (BIM M112) | `System7Profile` | Read-back, parameter flash, group-address flash, full download. Two LSM styles: the memory-mapped masks (MV-0700/0701) drive their load state machines over the deprecated memory interface, the property-mapped ones (MV-0705 and siblings) over PID-5 properties; a full download authors the com-object table for the property-mapped variants. Proof state: [status.md](status.md). |

Everything else resolves to `UnsupportedProfile`: the family is recognised (so we can name it
and say "not yet"), but every operation throws.

Within a family, how each download is sent follows rules, never a list of applications: what the
application's catalogue entry declares (for example `PreferPartialDownloadIfApplicationLoaded`,
`DynamicTableManagement`, `IsSecureEnabled`, `DownloadInvisibleParameters`, the declared load
procedure), then a rule of the family (System 7 property-mapped or memory-mapped, System B), then a
rule for every KNX device. Each rule, its level and the ETS captures that confirm it are in
[load-procedures.md](load-procedures.md#the-rules-by-level). Firmware behaviour that no catalogue
declares (when a stack persists, whether it needs a pause before the restart) is keyed on the
manufacturer and named as firmware there. The structural flash is the one operation still offered
per application: only where its plan is tested against an ETS capture of such a download.

A ✅ means the memory model is implemented, and nothing more. The PL (`MV-17B0`), RF (`MV-2705`,
`MV-27B0`) and IP (`MV-5705`, `MV-57B0`) rows read ✅ because they share the exact same codec and
load procedure as their TP siblings, not because a device on that medium was ever driven. Which
masks and media carry a hardware proof is in [status.md](status.md); read a device back before
trusting a row that does not.

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

## The com-object table: three paths, and the difference matters

- The **full download** (first-time commissioning) **AUTHORS** the com-object table from the
  application model, so a virgin device can be brought up with no ETS. The System B layout was
  read out of the firmware that consumes it and cross-checked against an independent
  implementation; the property-mapped System 7 layout was reconstructed from ETS captures (the
  memory-mapped MV-0700/0701 masks write the manufacturer's static table instead). See
  [`comobjbuild.ts`](../packages/product/src/comobjbuild.ts) and
  [commissioning.md](commissioning.md).
- The **surgical group-address flash** rebuilds the com-object table on **System B** and writes it
  alongside the address and association tables, because a table kept from the device leaves a
  freshly linked object with its Communication flag cleared, which reads back byte-perfect and is
  functionally dead. It stays surgical: the three tables are small and the parameter image is never
  touched. On System 7 the table is kept from the device (see [status.md](status.md)). Rebuilding
  is not the same as changing the object *set*: that is still refused, see below.
- The **surgical parameter flash** (re-configuring an already-programmed device) KEEPS the
  device's com-object table: it re-points parameters and group addresses, not the object set. A
  parameter change that, in ETS, would change a com-object's flags or the *set* of active
  com-objects (e.g. enabling a channel that adds objects) therefore cannot be expressed by
  re-pointing alone. **Both** the parameter flash and the group-address flash **refuse** such a
  change in the profile layer with `COM_OBJECT_TABLE_STALE`, naming the objects that would have gone
  stale. The route sees it first: where the profile offers `structuralFlash` it runs the structural
  flash instead, which authors the table with the parameters and group tables in one bracket
  ([load-procedures.md](load-procedures.md#structural-flash)); otherwise it refuses
  (`COM_OBJECT_TABLE_STALE_USE_DOWNLOAD` where a full download can rewrite the table,
  `COM_OBJECT_TABLE_STALE_USE_ETS` where the application's load procedure refuses that download). The group-address flash is
  gated for a second reason: its association table numbers com-objects from the live
  configuration, so an association onto an object the device's table does not configure would be
  a link to nothing, and the verify (which only re-reads the tables we wrote) would still report
  success. See [`comobjtable.ts`](../packages/product/src/comobjtable.ts).
- The staleness gate compares the com-object table implied by the **programmed baseline** (the
  configuration the device was last programmed with, hence the one its table was compiled for)
  against the one implied by the configuration being flashed. It deliberately does NOT compare
  against the device's own parameter image: the parameters that decide a channel's existence
  frequently have no memory offset at all, so they are unobservable on the bus and a
  device-image detector would be blind to exactly the change that matters.
- The read-back keeps the baseline honest from the other side: it re-baselines only refs the
  device's image actually encodes, so an unflashed edit to an unobservable parameter cannot
  launder itself into the "programmed" baseline.

## Known gaps

- **System 1 / System 2 (BCU1/BCU2)** appear in real projects. They are recognised and refused;
  implementing them means the classic fixed-EEPROM address/association/com-object/parameter
  model, which is a separate effort. See [roadmap.md](roadmap.md).
- **Non-application devices** (couplers, interfaces, media couplers) are out of scope for
  parameter commissioning by design. An interface whose product data uses an application mask (the
  MDT IP Interface/Router, MV-07B0) is routed to that mask's profile: read-back, parameter and
  group-address flash are offered, but the full download of an application that declares tunnelling
  entries (`MaxTunnelingUserEntries`) is refused (`FULL_DOWNLOAD_TUNNELING_ENTRIES`), because no
  Busforge path writes the interface's tunnelling addresses. The gate reads only that attribute: an
  interface application that omits it is not recognised as one and keeps the full download.
  The tunnelling addresses are device-instance data in the project (`AdditionalAddresses`), not part
  of the load procedure or the parameter image; Busforge reads them only to resolve secured senders.
  What ETS writes for them, and whether a download without them changes the tunnels the interface
  serves, is not established: the one ETS full download captured onto such an interface (the MDT IP
  Interface/Router) is not evaluated for them yet. Since the full
  download unloads and reallocates every load object, it is refused before any bus traffic, on the
  System B and the System 7 path (unit-tested on `M-0083_A-0137` and on a System 7 application with
  the attribute added, since no System 7 application in the catalogue declares it). An application whose family is
  refused anyway (the MV-0012 IP Interface Secure) keeps `FULL_DOWNLOAD_UNSUPPORTED`. The capability
  flag does not offer the download either, so a device never verified since it was placed keeps the
  surgical flashes instead of being sent to the download; read-back and secure
  identify stay available. Those flashes leave the properties the entries live in alone, but they are
  not harmless: they rewrite the parameter segment, or the group tables, the com-object table and
  (with a tool key on file) the security object, and both end in a restart of the interface, which
  cannot be flashed over its own connection ([knx-secure.md](knx-secure.md)). The product data gives
  the interface a System B parameter model (the IP settings are parameters), while it answered
  `0xFFFF` when read plainly; whether a secured read returns its parameter segment is not shown.
  Its parameter image equals ETS's image of that full download, byte for byte. Writing the
  entries waits for such a capture ([roadmap.md](roadmap.md#device-coverage)).
- **Parameters located in a property instead of memory** are not part of the image model, and no
  Busforge path reads or writes them. Typically this is the hardware type (object 0, PID 78; for
  example on the Gira M-0008, Theben MIX 2, MDT IP Interface/Router, MEAN WELL power supply and Jung
  400021SE), on the MEAN WELL also the version (PID 25). In the plain ETS captures of the Jung 400021SE, whose
  application carries such a parameter, ETS reads PID 78 and writes nothing to it, and so in the ETS
  captures of the Gira M-0008 (full download, partial parameter and links downloads, revert): one
  read of PID 78 each, no write, and so in the ETS captures of the Theben MIX 2's three products (full,
  parameter, links and revert downloads). For the other applications no capture shows what ETS does.
- **Devices that expose an object model instead of a memory image** (some IP interfaces answer an
  opaque device descriptor and offer no readable parameter model) have no read or program path
  yet.
